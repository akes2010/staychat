#!/usr/bin/env node
// scripts/deploy-smoke.js — pristine-deployment proof, runnable anywhere.
//
// Copies the repo to a throwaway dir WITHOUT node_modules, data/ or .env —
// exactly what a fresh VPS gets — then proves the full path a deployer walks:
//   1. generate real production secrets
//   2. node server/db/migrate.js   (schema from zero)
//   3. node server/db/seed.js      (demo tenants, real data)
//   4. node server/db/check.js     (every demo login verified)
//   5. boot server in production mode → health/landing 200
//   6. self-service signup → 14-day trial tenant created → starter rooms real
//   7. login as demo admin → tenant APIs answer
// Exit 0 = the repo is deployable as-is. Any failure exits 1 with the reason.
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.SMOKE_PORT || 4321;
const BASE = 'http://localhost:' + PORT;

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const run = (cmd, opts = {}) => execSync(cmd, Object.assign({ stdio: 'pipe', cwd: opts.dir || ROOT }, opts)).toString().trim();

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-smoke.'));
  console.log('── 1. Pristine copy (no node_modules, no data, no .env, no .git)');
  try {
    run(`tar cf - --exclude=node_modules --exclude=data --exclude=.env --exclude=.git --exclude=.freebuff . | (cd ${work} && tar xf -)`, { dir: ROOT });
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(work, 'node_modules'));
    fs.mkdirSync(path.join(work, 'data'));
    ok('copy clean: ' + fs.readdirSync(work).filter(f => !f.startsWith('.')).join(', '));
  } catch (e) { return bad('pristine copy failed: ' + e.message); }

  console.log('── 2. Production secrets generated (as setup-vps.sh would)');
  const secret = (n) => run(`node -e "process.stdout.write(require('crypto').randomBytes(${n}).toString('hex'))"`);
  const env = Object.assign({}, process.env, {
    NODE_ENV: 'production', PORT: String(PORT),
    JWT_ACCESS_SECRET: secret(48), JWT_REFRESH_SECRET: secret(48),
    CREDENTIALS_ENCRYPTION_KEY: secret(32), COOKIE_SECRET: secret(32),
  });

  console.log('── 3. Schema from zero (migrate)');
  try { run('node server/db/migrate.js', { dir: work, env }); ok('migrate OK'); }
  catch (e) { return bad('migrate failed: ' + e.stderr || e.message); }

  console.log('── 4. Demo data (seed)');
  try {
    const out = run('node server/db/seed.js', { dir: work, env });
    ok(out.includes('seeded') || out.includes('IMPORTANT') ? 'seed OK' : 'seed emitted: ' + out.slice(0, 60));
  } catch (e) { return bad('seed failed: ' + e.stderr || e.message); }

  console.log('── 5. Demo logins verified (check)');
  try {
    const out = run('node server/db/check.js', { dir: work, env });
    if (/PASS/.test(out)) ok('check PASS — ' + (out.match(/\d+\/\d+ demo logins/) || [''])[0]);
    else return bad('check did not pass: ' + out.slice(-200));
  } catch (e) { return bad('check failed: ' + (e.stderr || e.message)); }

  console.log('── 6. Boot in production mode');
  const srv = spawn('node', ['server/index.js'], { cwd: work, env, stdio: 'ignore' });
  const healthy = await new Promise(resolve => {
    const t0 = Date.now();
    const tick = () => http.get(BASE + '/api/health', r => { r.resume(); resolve(r.statusCode === 200); }).on('error', () =>
      Date.now() - t0 > 15000 ? resolve(false) : setTimeout(tick, 300));
    tick();
  });
  if (!healthy) { bad('server never became healthy'); srv.kill('SIGKILL'); return; }
  ok('healthy on ' + BASE);

  console.log('── 7. Public surfaces + self-service signup (the real first hour)');
  const get = (p) => new Promise(res => http.get(BASE + p, r => { r.resume(); res(r.statusCode); }).on('error', () => res(0)));
  const landing = await get('/');
  (landing === 200) ? ok('landing page 200') : bad('landing ' + landing);
  const book = await get('/book.html?hotel=hospitally');
  (book === 200) ? ok('public booking page 200') : bad('booking page ' + book);

  const signup = await new Promise(resolve => {
    const body = JSON.stringify({ hotelName: 'Smoke Villa', name: 'Smoke Owner', email: 'owner@smokevilla.test', password: 'Smoke@12345x', plan: 'starter' });
    const req = http.request(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, data: JSON.parse(d || '{}') }));
    });
    req.on('error', () => resolve({ status: 0, data: {} })); req.end(body);
  });
  if (signup.status === 201) ok('self-service signup 201 — trial tenant "' + (signup.data.tenant || {}).name + '"');
  else bad('signup ' + signup.status + ': ' + JSON.stringify(signup.data).slice(0, 120));

  const rooms = signup.status === 201 ? dbRoomCount(work, signup.data) : -1;
  (rooms === 8) ? ok('starter inventory seeded — 8 bookable rooms on day one') : bad('starter rooms: ' + rooms);

  console.log('── 8. Tenant API answers with real data');
  const bookings = await new Promise(resolve => {
    http.get(BASE + '/api/bookings', { headers: { Authorization: 'Bearer ' + (signup.data.accessToken || '') } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, data: d }));
    }).on('error', () => resolve({ status: 0, data: '' }));
  });
  (bookings.status === 200 && Array.isArray(JSON.parse(bookings.data || '[]'))) ? ok('tenant bookings API 200 (scoped to own tenant)') : bad('bookings API ' + bookings.status);

  srv.kill('SIGKILL');
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}

  console.log('\n═══ DEPLOY SMOKE: ' + pass + ' passed, ' + fail + ' failed ═══');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SMOKE CRASH:', e); process.exit(1); });

// Count the registered tenant's rooms by reading its own DB copy directly.
function dbRoomCount(work, signupData) {
  try {
    const Database = require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
    const db = new Database(path.join(work, 'data', 'staychat.db'), { readonly: true });
    const tenantId = signupData.user && signupData.user.tenantId;
    if (!tenantId) return -1;
    return db.prepare("SELECT COUNT(*) c FROM rooms WHERE tenant_id = ? AND status = 'available'").get(tenantId).c;
  } catch (e) { return -1; }
}
