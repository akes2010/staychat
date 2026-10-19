#!/usr/bin/env node
// scripts/reset-superadmin.js
// ═══════════════════════════════════════════════════════════════════════════
// EMERGENCY PLATFORM-ADMIN LOGIN RECOVERY for a LIVE deployment.
//
// The login page answers "Invalid email or password" for exactly three reasons
// (see server/routes/auth.js): the email doesn't exist, the password is wrong,
// or the account is deactivated (`active = 1` filter). This script fixes ALL
// THREE in one shot — it creates the superadmin if missing, resets its
// password, and reactivates it — so you can sign in and configure the platform
// from the Super Admin console.
//
// It is a NEW, standalone file: it changes no existing code and no existing
// behaviour. It only touches the `users` table (plus a revocation of that
// user's sessions and one audit-log row) — and in --check mode it writes
// NOTHING at all.
//
// ── Read this FIRST: why is Demo@123456 rejected? ──────────────────────────
//   Run the read-only diagnosis (no changes, safe anywhere):
//     node reset-superadmin.js --check --password='Demo@123456'
//   It prints every login on the server, whether it is active, and whether the
//   password matches. Common findings:
//     • "DEMO_PASSWORD is SET" → the server's .env overrode the demo password
//       at seed time; the real password is that value (or just reset below).
//     • "no logins at all"      → the live DB was never seeded; this script
//       CREATES the superadmin for you.
//     • "DEACTIVATED"           → the account exists but login refuses it.
//     • wrong database          → DATA_DIR points somewhere else than you
//       think; the printed path tells you which file you are editing.
//
// ── Usage ──────────────────────────────────────────────────────────────────
//   Read-only diagnosis:
//     node scripts/reset-superadmin.js --check [--email=…] [--password=…]
//
//   Interactive (asks for the password without echoing it):
//     node scripts/reset-superadmin.js
//
//   Non-interactive (CI / scripts / forgotten-password recovery):
//     SUPERADMIN_PASSWORD='YourStr0ng!Pass' node scripts/reset-superadmin.js
//     node scripts/reset-superadmin.js --email=ops@yourdomain.com --password='YourStr0ng!Pass'
//
//   No password given and no TTY: a strong random password is generated and
//   printed ONCE.
//
//   Works from ANY directory (it locates the app root itself) — Docker:
//     docker exec -it staychat node /app/scripts/reset-superadmin.js
//   If the file isn't in the container yet, download it straight in:
//     docker exec -it staychat sh -c "wget -qO /tmp/rs.js \
//       https://raw.githubusercontent.com/akes2010/staychat/master/scripts/reset-superadmin.js && node /tmp/rs.js --check"
//
// ── Safety ─────────────────────────────────────────────────────────────────
//   • --check never writes anything.
//   • Never promotes an existing non-superadmin account unless --promote.
//   • Never prints a password supplied via env/arg (generated = shown once).
//   • Revokes all refresh tokens for the user on reset.
//   • Idempotent: run it as many times as you like.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

// ── Locate the application root (so this runs from ANY working directory) ──
// Candidates: this script's own folder, the current directory, Docker's /app,
// and a short walk up from the current directory. A root qualifies when it
// contains server/db/connection.js — the module every path below needs.
function findAppRoot() {
  const candidates = [path.join(__dirname, '..'), process.cwd(), '/app'];
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) { candidates.push(dir); dir = path.dirname(dir); }
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'server', 'db', 'connection.js'))) return path.resolve(c); } catch (e) { /* keep looking */ }
  }
  return null;
}
const APP_ROOT = findAppRoot();
if (!APP_ROOT) {
  console.error('');
  console.error('  ✗ Could not find the StayChat OS app folder (server/db/connection.js).');
  console.error('    Run this from inside the app directory — or inside the container:');
  console.error('      docker exec -it <container> node /app/scripts/reset-superadmin.js');
  console.error('');
  process.exit(1);
}

// Load the app's own .env FIRST (dotenv never overrides variables that are
// already set, so shell env always wins) — DATA_DIR decides which database
// this script reads and writes.
try { require('dotenv').config({ path: path.join(APP_ROOT, '.env') }); } catch (e) { /* optional */ }
require('dotenv').config();

require(path.join(APP_ROOT, 'server', 'db', 'migrate')); // idempotent schema — safe on any DB
const db = require(path.join(APP_ROOT, 'server', 'db', 'connection'));
const bcrypt = require(path.join(APP_ROOT, 'node_modules', 'bcryptjs'));
const { nanoid } = require(path.join(APP_ROOT, 'node_modules', 'nanoid'));

const BCRYPT_ROUNDS = 12; // same cost factor seed.js/users.js use

// ── Arguments ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(name) {
  const hit = args.find(a => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}
if (argValue('help')) {
  console.log('Usage:');
  console.log('  node reset-superadmin.js --check [--email=<address>] [--password=<pw>]   (read-only)');
  console.log('  node reset-superadmin.js [--email=<address>] [--password=<pw>] [--promote]');
  process.exit(0);
}
const CHECK = !!argValue('check');
const PROMOTE = !!argValue('promote');
const EMAIL = String(argValue('email') || process.env.SUPERADMIN_EMAIL || 'superadmin@staychat.io').trim().toLowerCase();
const PASSWORD_ARG = typeof argValue('password') === 'string' ? argValue('password') : null;

// ── Shared diagnostics ─────────────────────────────────────────────────────
function diagnose() {
  const users = db.prepare('SELECT email, role, active FROM users ORDER BY email').all();
  const tenants = db.prepare('SELECT COUNT(*) c FROM tenants').get().c;
  console.log('');
  console.log('  App root: ' + APP_ROOT);
  console.log('  Database: ' + db.name);
  console.log('  DATA_DIR: ' + (process.env.DATA_DIR || '(default: <app>/data)'));
  console.log('  Existing logins (' + users.length + '):');
  if (users.length === 0) console.log('    (none — every login attempt fails until this script creates one)');
  users.forEach(u => console.log('    • ' + u.email + ' [' + u.role + ']' + (u.active ? '' : '  ⚠ DEACTIVATED — login is refused for inactive accounts')));
  if (process.env.DEMO_PASSWORD) {
    console.log('  ⚠ DEMO_PASSWORD is SET in this environment — seeded accounts were created with');
    console.log('    THAT value, NOT "Demo@123456". (Value not shown; reset it below instead.)');
  }
  if (tenants === 0) {
    console.log('  ⚠ WARNING: this database has ZERO hotels. server/db/seed.js re-creates the');
    console.log('    demo tenants AND demo logins on the next start — create a real hotel or');
    console.log('    leave one tenant row in place.');
  }
  console.log('');
}

// ── --check: read-only diagnosis, exits 0 only if the login WOULD work ─────
if (CHECK) {
  diagnose();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(EMAIL);
  if (!user) {
    console.log('  ✗ ' + EMAIL + ' does NOT exist in this database → login returns "Invalid email or password".');
    console.log('    Fix: run this script WITHOUT --check to create it.');
    console.log('');
    process.exit(1);
  }
  console.log('  Account: ' + user.email);
  console.log('    role:   ' + user.role);
  console.log('    active: ' + user.active + (user.active ? '' : '  ⚠ login refused → run WITHOUT --check to reactivate'));
  if (PASSWORD_ARG !== null) {
    const match = bcrypt.compareSync(PASSWORD_ARG, user.password_hash);
    console.log('    password provided: ' + (match ? '✓ MATCHES' : '✗ does NOT match the stored hash'));
    if (!match) console.log('    → login returns "Invalid email or password" for this password.');
    const ok = match && user.active === 1;
    console.log('');
    console.log(ok ? '  VERDICT: this login WOULD succeed right now.'
                   : '  VERDICT: this login would FAIL. Run without --check to repair it.');
    console.log('');
    process.exit(ok ? 0 : 1);
  }
  console.log('    (no --password given — pass one to test it, e.g. --password=\'Demo@123456\')');
  console.log('');
  process.exit(0);
}

// ── Password input: arg → env → hidden TTY prompt → generated ──────────────
function generatedPassword() {
  // Meets the app's own strength policy (upper/lower/digit/special, 12+ chars).
  return 'SC-' + crypto.randomBytes(9).toString('base64url') + 'aA1!';
}
function promptHidden(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve(null);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdin, terminal: true });
    let muted = true;
    const originalWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
    rl._writeToOutput = (s) => {
      if (!muted) { if (originalWrite) originalWrite(s); else process.stdout.write(s); }
      else if (String(s).includes('\n')) process.stdout.write('\n'); // keep Enter feedback
    };
    process.stdout.write(question);
    rl.question('', (answer) => {
      muted = false;
      rl.close();
      resolve(String(answer || '').trim());
    });
  });
}

async function resolvePassword() {
  if (PASSWORD_ARG !== null && PASSWORD_ARG.length > 0) return { password: PASSWORD_ARG, source: 'argument' };
  if (process.env.SUPERADMIN_PASSWORD) return { password: process.env.SUPERADMIN_PASSWORD, source: 'environment' };
  const typed = await promptHidden('New superadmin password (input hidden): ');
  if (typed && typed.length > 0) return { password: typed, source: 'prompt' };
  return { password: generatedPassword(), source: 'generated' };
}

// ── Main: create / reset / reactivate ──────────────────────────────────────
(async () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════════════════╗');
  console.log('  ║  StayChat OS — superadmin login recovery                 ║');
  console.log('  ╚═══════════════════════════════════════════════════════════╝');
  diagnose();

  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(EMAIL);
  if (existing && existing.role !== 'superadmin' && !PROMOTE) {
    console.error('  ✗ ' + EMAIL + ' already exists but is a "' + existing.role + '" account.');
    console.error('    Refusing to silently promote it to platform superadmin.');
    console.error('    Pass --promote if that is really what you want, or use --email= another address.');
    process.exit(1);
  }

  const { password, source } = await resolvePassword();
  if (password.length < 8) {
    console.error('  ✗ Password must be at least 8 characters.');
    process.exit(1);
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password)) {
    console.log('  ⚠ Note: this password does not meet the in-app policy (upper + lower +');
    console.log('    number + special). Login will still work, but the Users page will');
    console.log('    reject it for future admin resets — consider a stronger one.');
  }

  const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  let userId;
  let action;
  if (existing) {
    // Reset password + reactivate (role only changes with --promote — checked above).
    db.prepare('UPDATE users SET password_hash = ?, active = 1, role = ? WHERE id = ?')
      .run(hash, existing.role === 'superadmin' ? 'superadmin' : 'superadmin', existing.id);
    db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(existing.id);
    userId = existing.id;
    action = 'superadmin.login_reset';
  } else {
    userId = 'user_' + nanoid(16);
    // Superadmin rows carry tenant_id = NULL by design (platform scope, not a hotel).
    db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, avatar, active)
                VALUES (?, NULL, 'Platform Admin', ?, ?, 'superadmin', 'SA', 1)`)
      .run(userId, EMAIL, hash);
    action = 'superadmin.login_created';
  }

  // Audit trail — the same table the app writes every security event to.
  try {
    db.prepare(`INSERT INTO audit_log (id, tenant_id, user_id, action, entity_type, entity_id, details, ip_address)
                VALUES (?,?,?,?,'user',?,?,'127.0.0.1')`)
      .run('audit_' + nanoid(10), null, userId, action, userId,
           JSON.stringify({ by: 'scripts/reset-superadmin.js', passwordSource: source }));
  } catch (e) { console.log('  (audit log row skipped: ' + e.message + ')'); }

  const saved = db.prepare('SELECT email, role, active FROM users WHERE id = ?').get(userId);
  console.log('  ✓ ' + (existing ? 'Password reset' : 'Account created') + ' for ' + saved.email);
  console.log('    role=' + saved.role + '  active=' + saved.active + '  (takes effect immediately — no restart needed)');
  if (source === 'generated') {
    console.log('');
    console.log('    GENERATED PASSWORD (shown once, not recoverable): ' + password);
  } else {
    console.log('    Password was set from the ' + source + ' (not displayed).');
  }
  console.log('');
  console.log('  Prove it before opening the browser:');
  console.log('    node ' + path.relative(process.cwd(), __filename) + ' --check --email=' + saved.email + " --password='…'");
  console.log('');
  console.log('  Next: log in at your site with ' + saved.email + ', then');
  console.log('    • change this password (Users → your account), and');
  console.log('    • set real secrets in .env (JWT_ACCESS_SECRET / JWT_REFRESH_SECRET /');
  console.log('      COOKIE_SECRET / CREDENTIALS_ENCRYPTION_KEY) if you have not yet.');
  console.log('');
  db.close();
  process.exit(0);
})().catch(err => {
  console.error('  ✗ Failed: ' + err.message);
  process.exit(1);
});
