// scripts/verify-tables-http.js
// End-to-end HTTP check for the Tables & Seating module: boots the REAL
// Express app on an ephemeral port (temp DATA_DIR) and drives /api/tables
// through the actual middleware stack (auth → resolveTenant → requireTenant →
// tables.use → pos_tables entitlement → tables.manage). Covers:
//   CRUD round-trip (name / sitting / chairs / location / active),
//   validation (missing & overlong name, bad sitting, bad location, chairs
//   out of range / fractional),
//   one-name-per-outlet uniqueness (same name allowed in the OTHER location),
//   PATCH edits incl. active flip + location move, DELETE,
//   use/manage permission split (tables.use alone → reads yes, writes 403),
//   plan entitlement gate (starter → 402), audit rows.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-tables-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // ephemeral

const db = require('../server/db/connection');
require('../server/db/migrate');

const { nanoid } = require('nanoid');
const bcrypt = require('bcryptjs');
const { signAccessToken } = require('../server/utils/tokens');

function makeTenant(plan) {
  const id = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?,?,'active')`)
    .run(id, 'Tbl ' + plan + ' Hotel', 'tbl-' + nanoid(5), plan);
  return id;
}
function makeUser(tenantId, role, perms) {
  const id = 'user_' + nanoid(8);
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, permissions, permissions_customized) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, tenantId, role, role + '-' + nanoid(5) + '@tbl.test', bcrypt.hashSync('pw', 8), role,
         JSON.stringify(perms || []), perms ? 1 : 0);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

const proTenant = makeTenant('pro');
const starterTenant = makeTenant('starter');
const admin = makeUser(proTenant, 'hotel_admin');                                  // tables.use + tables.manage
const waiter = makeUser(proTenant, 'staff', ['tables.use']);                       // use only — no manage
const staff = makeUser(proTenant, 'staff');                                        // neither
const starterAdmin = makeUser(starterTenant, 'hotel_admin');                       // right caps, wrong plan

const adminTok = signAccessToken(admin);
const waiterTok = signAccessToken(waiter);
const staffTok = signAccessToken(staff);
const starterTok = signAccessToken(starterAdmin);

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

  // ── 1. Auth + empty list ────────────────────────────────────────────────
  let r = await req('GET', '/api/tables', null);
  check('GET without token → 401', r.status === 401, 'got ' + r.status);

  r = await req('GET', '/api/tables', adminTok);
  check('GET as admin → 200 []', r.status === 200 && Array.isArray(r.body) && r.body.length === 0,
    'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 60));

  // ── 2. Create → round-trip (every field) ────────────────────────────────
  r = await req('POST', '/api/tables', adminTok, { name: 'Window One', sitting: 'Window Side', chairs: 4, persons: 5, location: 'restaurant' });
  check('POST full create → 201', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
  const t1 = r.body;
  check('round-trips name/sitting/chairs/persons/location',
    t1 && t1.name === 'Window One' && t1.sitting === 'Window Side' && t1.chairs === 4 && t1.persons === 5 && t1.location === 'restaurant',
    JSON.stringify(t1 && { name: t1.name, sitting: t1.sitting, chairs: t1.chairs, persons: t1.persons, location: t1.location }));
  check('new table is active by default', t1 && t1.active === true);

  r = await req('POST', '/api/tables', adminTok, { name: 'Bar High 1' });
  check('name-only create defaults sensibly → 201', r.status === 201 &&
    r.body.sitting === 'Standard' && r.body.chairs === 4 && r.body.persons === 4 && r.body.location === 'restaurant' && r.body.active === true,
    JSON.stringify(r.body).slice(0, 140));

  r = await req('GET', '/api/tables', adminTok);
  check('GET lists both tables', r.status === 200 && r.body.length === 2, 'n=' + (r.body && r.body.length));

  // ── 3. One name per outlet (other location allowed) ─────────────────────
  r = await req('POST', '/api/tables', adminTok, { name: 'window one', location: 'restaurant' });
  check('case-insensitive duplicate in same location → 409', r.status === 409, 'got ' + r.status);

  r = await req('POST', '/api/tables', adminTok, { name: 'Window One', location: 'bar' });
  check('same name in the OTHER location → 201', r.status === 201, 'got ' + r.status);
  const barOne = r.body;

  // ── 4. Validation → 400 ─────────────────────────────────────────────────
  r = await req('POST', '/api/tables', adminTok, { sitting: 'Booth', chairs: 2 });
  check('missing name → 400', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/tables', adminTok, { name: 'x'.repeat(61) });
  check('overlong name → 400', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/tables', adminTok, { name: 'Bad Sitting', sitting: 'Hammock' });
  check('unknown sitting → 400', r.status === 400 && /sitting/i.test(r.body && r.body.error ? r.body.error : ''),
    JSON.stringify(r.body).slice(0, 100));
  r = await req('POST', '/api/tables', adminTok, { name: 'Bad Loc', location: 'rooftop' });
  check('unknown location → 400', r.status === 400 && /location/i.test(r.body && r.body.error ? r.body.error : ''),
    JSON.stringify(r.body).slice(0, 100));
  r = await req('POST', '/api/tables', adminTok, { name: 'Zero Chairs', chairs: 0 });
  check('chairs = 0 → 400', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/tables', adminTok, { name: 'Fractional', chairs: 2.5 });
  check('fractional chairs → 400', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/tables', adminTok, { name: 'No Persons', persons: 0 });
  check('persons = 0 → 400', r.status === 400, 'got ' + r.status);

  // ── 5. PATCH edits ──────────────────────────────────────────────────────
  r = await req('PATCH', '/api/tables/' + t1.id, adminTok, { name: 'Window Two', sitting: 'Lounge', chairs: 6, persons: 8 });
  check('PATCH rename+sitting+chairs+persons → 200 round-trip', r.status === 200 &&
    r.body.name === 'Window Two' && r.body.sitting === 'Lounge' && r.body.chairs === 6 && r.body.persons === 8,
    JSON.stringify(r.body).slice(0, 160));

  r = await req('PATCH', '/api/tables/' + t1.id, adminTok, { active: false });
  check('PATCH active:false → serialized active false', r.status === 200 && r.body.active === false,
    JSON.stringify(r.body && r.body.active));

  r = await req('PATCH', '/api/tables/' + t1.id, adminTok, { name: 'Window One', location: 'bar' });
  check('rename+move colliding with "Window One" already in the bar → 409', r.status === 409, 'got ' + r.status);
  r = await req('GET', '/api/tables', adminTok);
  const t1After = r.body.find(x => x.id === t1.id);
  check('rejected rename+move leaves the row untouched', t1After && t1After.name === 'Window Two' && t1After.location === 'restaurant',
    JSON.stringify(t1After && { name: t1After.name, location: t1After.location }));

  r = await req('PATCH', '/api/tables/' + barOne.id, adminTok, { location: 'restaurant' });
  check('bar table moves into the restaurant (no collision) → 200', r.status === 200 && r.body.location === 'restaurant',
    'got ' + r.status);

  r = await req('PATCH', '/api/tables/' + t1.id, adminTok, { nope: 1 });
  check('PATCH with no valid fields → 400', r.status === 400, 'got ' + r.status);
  r = await req('PATCH', '/api/tables/tbl_missing', adminTok, { chairs: 2 });
  check('PATCH unknown id → 404', r.status === 404, 'got ' + r.status);

  // ── 6. DELETE ───────────────────────────────────────────────────────────
  r = await req('DELETE', '/api/tables/' + barOne.id, adminTok);
  check('DELETE → 200', r.status === 200, 'got ' + r.status);
  r = await req('GET', '/api/tables', adminTok);
  check('deleted table is gone from the list', r.body.length === 2, 'n=' + r.body.length);
  r = await req('DELETE', '/api/tables/tbl_missing', adminTok);
  check('DELETE unknown id → 404', r.status === 404, 'got ' + r.status);

  // ── 7. use/manage permission split ──────────────────────────────────────
  r = await req('GET', '/api/tables', waiterTok);
  check('tables.use only → GET 200', r.status === 200 && Array.isArray(r.body), 'got ' + r.status);
  r = await req('POST', '/api/tables', waiterTok, { name: 'Nope Table' });
  check('tables.use only → POST 403', r.status === 403, 'got ' + r.status);
  r = await req('PATCH', '/api/tables/' + t1.id, waiterTok, { chairs: 9 });
  check('tables.use only → PATCH 403', r.status === 403, 'got ' + r.status);
  r = await req('DELETE', '/api/tables/' + t1.id, waiterTok);
  check('tables.use only → DELETE 403', r.status === 403, 'got ' + r.status);
  r = await req('GET', '/api/tables', staffTok);
  check('no tables.use → GET 403', r.status === 403, 'got ' + r.status);

  // ── 8. Plan entitlement gate ────────────────────────────────────────────
  r = await req('GET', '/api/tables', starterTok);
  check('starter plan → 402 UPGRADE_REQUIRED', r.status === 402 && r.body && r.body.code === 'UPGRADE_REQUIRED',
    'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 100));

  // ── 9. Audit trail ──────────────────────────────────────────────────────
  const audits = db.prepare("SELECT action, COUNT(*) c FROM audit_log WHERE tenant_id = ? AND entity_type = 'pos_table' GROUP BY action").all(proTenant);
  const byAction = Object.fromEntries(audits.map(a => [a.action, a.c]));
  check('audit rows exist for create/update/delete',
    byAction['tables.create'] >= 3 && byAction['tables.update'] >= 3 && byAction['tables.delete'] >= 1,
    JSON.stringify(byAction));

  // ── Cleanup ─────────────────────────────────────────────────────────────
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter(x => !x.ok);
  console.log('\n' + (failed.length ? '✗ ' + failed.length + ' of ' + results.length + ' checks FAILED' : '✓ ALL ' + results.length + ' CHECKS PASSED'));
  process.exit(failed.length ? 1 : 0);
}

run().catch(e => { console.error(e); try { server.close(); } catch (x) {} process.exit(1); });
