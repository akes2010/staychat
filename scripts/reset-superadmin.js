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
// It is deliberately a NEW, standalone file: it changes no existing code and
// no existing behaviour. It only touches the `users` table (plus a revocation
// of that user's sessions and one audit-log row).
//
// ── Usage ──────────────────────────────────────────────────────────────────
//   Interactive (asks for the password without echoing it):
//     node scripts/reset-superadmin.js
//
//   Non-interactive (CI / scripts / forgotten-password recovery):
//     SUPERADMIN_EMAIL=ops@yourdomain.com SUPERADMIN_PASSWORD='YourStr0ng!Pass' \
//       node scripts/reset-superadmin.js
//     node scripts/reset-superadmin.js --email=ops@yourdomain.com --password='YourStr0ng!Pass'
//
//   No password given and no TTY (e.g. piped output): a strong random password
//   is generated and printed ONCE.
//
//   Docker deployments:
//     docker exec -it staychat node scripts/reset-superadmin.js
//   (If the script isn't in the container yet: git pull on the host, then
//    `docker cp scripts/reset-superadmin.js staychat:/app/scripts/` and re-run.)
//
// ── Safety ─────────────────────────────────────────────────────────────────
//   • Never promotes an existing non-superadmin account unless --promote is
//     passed — resetting a receptionist's email into a platform superadmin
//     would be a silent privilege escalation.
//   • Never prints a password that was supplied via env/arg; a generated one
//     is shown exactly once.
//   • Revokes all refresh tokens for the user (every other session is forced
//     to re-login with the new password).
//   • Idempotent: run it as many times as you like.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

require('dotenv').config(); // so DATA_DIR / DEMO_PASSWORD from .env apply
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const APP_ROOT = path.join(__dirname, '..');
require(path.join(APP_ROOT, 'server', 'db', 'migrate')); // idempotent schema — safe on any DB
const db = require(path.join(APP_ROOT, 'server', 'db', 'connection'));
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');

const BCRYPT_ROUNDS = 12; // same cost factor seed.js/users.js use

// ── Arguments ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function argValue(name) {
  const hit = args.find(a => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : true;
}
if (argValue('help')) {
  console.log('Usage: node scripts/reset-superadmin.js [--email=<address>] [--password=<pw>] [--promote]');
  process.exit(0);
}
const PROMOTE = !!argValue('promote');
const EMAIL = String(argValue('email') || process.env.SUPERADMIN_EMAIL || 'superadmin@staychat.io').trim().toLowerCase();

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
  const fromArg = argValue('password');
  if (typeof fromArg === 'string' && fromArg.length > 0) return { password: fromArg, source: 'argument' };
  if (process.env.SUPERADMIN_PASSWORD) return { password: process.env.SUPERADMIN_PASSWORD, source: 'environment' };
  const typed = await promptHidden('New superadmin password (input hidden): ');
  if (typed && typed.length > 0) return { password: typed, source: 'prompt' };
  return { password: generatedPassword(), source: 'generated' };
}

// ── Diagnostics: why was login failing? ────────────────────────────────────
function diagnose() {
  const users = db.prepare('SELECT email, role, active FROM users').all();
  const tenants = db.prepare('SELECT COUNT(*) c FROM tenants').get().c;
  console.log('');
  console.log('  Database: ' + db.name);
  console.log('  Existing logins (' + users.length + '):');
  if (users.length === 0) console.log('    (none — every login attempt will fail until this script runs)');
  users.forEach(u => console.log('    • ' + u.email + ' [' + u.role + ']' + (u.active ? '' : '  ⚠ DEACTIVATED — login is refused for inactive accounts')));
  if (tenants === 0) {
    console.log('');
    console.log('  ⚠ WARNING: this database has ZERO hotels. server/db/seed.js re-creates the');
    console.log('    demo tenants AND demo logins (password DEMO_PASSWORD or Demo@123456) on the');
    console.log('    next start. Create your first real hotel, or leave one tenant row in place.');
  }
  console.log('');
}

// ── Main ───────────────────────────────────────────────────────────────────
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
  const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

  let userId;
  let action;
  if (existing) {
    // Reset password + reactivate + ensure the role (only possible with --promote
    // for non-superadmins — checked above).
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
    userId = userId;
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
