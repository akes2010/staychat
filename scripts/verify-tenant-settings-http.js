// scripts/verify-tenant-settings-http.js
// End-to-end HTTP check for the tenant branding settings (logo upload, phone
// number, address): boots the REAL Express app on an ephemeral port (temp
// DATA_DIR) and drives /api/settings through the actual middleware stack.
// Covers:
//   GET exposes phone/address/logo (null until set),
//   PATCH saves + round-trips phone & address,
//   logo accepts a base64 image data URL, rejects bad prefixes and oversized
//   payloads, and can be cleared,
//   role gate (receptionist → 403 on PATCH, read still 200),
//   audit trail of settings.update.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-branding-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // ephemeral

const db = require('../server/db/connection');
require('../server/db/migrate');

const { nanoid } = require('nanoid');
const bcrypt = require('bcryptjs');
const { signAccessToken } = require('../server/utils/tokens');

function makeTenant() {
  const id = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?, 'pro', 'active')`)
    .run(id, 'Branding Hotel', 'brand-' + nanoid(5));
  return id;
}
function makeUser(tenantId, role) {
  const id = 'user_' + nanoid(8);
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?,?)`)
    .run(id, tenantId, role, role + '-' + nanoid(5) + '@brand.test', bcrypt.hashSync('pw', 8), role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

const tenantId = makeTenant();
const admin = makeUser(tenantId, 'hotel_admin');
const reception = makeUser(tenantId, 'receptionist');
const adminTok = signAccessToken(admin);
const receptionTok = signAccessToken(reception);

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '✓ PASS' : '✗ FAIL') + '  ' + name + (extra ? '  — ' + extra : ''));
}

const { app } = require('../server/index');
const server = app.listen(0, '127.0.0.1');

function req(method, pathName, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path: pathName, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { json = buf; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function run() {
  await new Promise(resolve => server.once('listening', resolve));

  // ── 1. Auth + defaults ──────────────────────────────────────────────────
  let r = await req('GET', '/api/settings', null);
  check('GET without token → 401', r.status === 401, 'got ' + r.status);

  r = await req('GET', '/api/settings', adminTok);
  check('GET as admin exposes branding fields (phone/address/logo, unset → null)',
    r.status === 200 && 'phone' in r.body && r.body.address === null && r.body.logo === null,
    'got ' + r.status + ' address=' + JSON.stringify(r.body.address) + ' logo=' + JSON.stringify(r.body.logo));

  // ── 2. Phone + address save + round-trip ────────────────────────────────
  r = await req('PATCH', '/api/settings', adminTok, { phone: '+234 801 234 5678', address: '12 Marina Road, Lagos Island' });
  check('PATCH phone + address → 200', r.status === 200, 'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
  check('response round-trips phone + address',
    r.body && r.body.phone === '+234 801 234 5678' && r.body.address === '12 Marina Road, Lagos Island',
    JSON.stringify({ phone: r.body && r.body.phone, address: r.body && r.body.address }));

  r = await req('GET', '/api/settings', adminTok);
  check('branding persists on a fresh GET',
    r.body.phone === '+234 801 234 5678' && r.body.address === '12 Marina Road, Lagos Island',
    JSON.stringify({ phone: r.body.phone, address: r.body.address }));

  // ── 3. Logo upload ──────────────────────────────────────────────────────
  r = await req('PATCH', '/api/settings', adminTok, { logo: PNG_1PX });
  check('PATCH valid base64 image logo → 200', r.status === 200 && r.body.logo === PNG_1PX,
    'got ' + r.status + ' logo=' + String(r.body && r.body.logo).slice(0, 40));

  r = await req('GET', '/api/settings', adminTok);
  check('logo persists on a fresh GET', r.body.logo === PNG_1PX, String(r.body.logo).slice(0, 40));

  // ── 4. Logo validation ──────────────────────────────────────────────────
  r = await req('PATCH', '/api/settings', adminTok, { logo: 'https://evil.example/x.png' });
  check('non-data-URL logo → 400', r.status === 400 && /logo/i.test(r.body && r.body.error ? r.body.error : ''),
    'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 90));

  r = await req('PATCH', '/api/settings', adminTok, { logo: 'data:image/png;base64,' + 'A'.repeat(1500001) });
  // Two honest rejection layers: the app's own 1.5M-char cap answers 400 when
  // it fires first; anything past Express's 1mb JSON body limit is refused with
  // 413 before the handler runs. Either way the payload must be REJECTED.
  check('oversized logo rejected (400 app cap or 413 body limit)',
    (r.status === 400 && /too large/i.test(r.body && r.body.error ? r.body.error : '')) || r.status === 413,
    'got ' + r.status);

  r = await req('GET', '/api/settings', adminTok);
  check('rejected logos never overwrite the stored one', r.body.logo === PNG_1PX, String(r.body.logo).slice(0, 40));

  r = await req('PATCH', '/api/settings', adminTok, { logo: '' });
  check('clearing the logo → 200 with logo null', r.status === 200 && r.body.logo === null,
    JSON.stringify(r.body && r.body.logo));

  // ── 5. Role gate ────────────────────────────────────────────────────────
  r = await req('PATCH', '/api/settings', receptionTok, { phone: '+1 555 0100' });
  check('receptionist cannot change settings → 403', r.status === 403, 'got ' + r.status);
  r = await req('GET', '/api/settings', receptionTok);
  check('receptionist can still READ settings → 200', r.status === 200, 'got ' + r.status);
  r = await req('GET', '/api/settings', adminTok);
  check('failed 403 did not write the phone', r.body.phone === '+234 801 234 5678', String(r.body.phone));

  // ── 6. Audit trail ──────────────────────────────────────────────────────
  const audit = db.prepare(`SELECT details FROM audit_log WHERE tenant_id = ? AND action = 'settings.update'
                            ORDER BY created_at DESC LIMIT 1`).get(tenantId);
  check('settings.update audited with the changed keys',
    audit && /phone|address|logo/.test(audit.details || ''), audit ? audit.details : 'no audit row');

  // ── Cleanup ─────────────────────────────────────────────────────────────
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter(x => !x.ok);
  console.log('\n' + (failed.length ? '✗ ' + failed.length + ' of ' + results.length + ' checks FAILED' : '✓ ALL ' + results.length + ' CHECKS PASSED'));
  process.exit(failed.length ? 1 : 0);
}

run().catch(e => { console.error(e); try { server.close(); } catch (x) {} process.exit(1); });
