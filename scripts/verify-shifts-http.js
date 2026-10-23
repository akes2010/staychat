// scripts/verify-shifts-http.js
// End-to-end HTTP check for the Shift & Attendance duty-rotation calendar:
// boots the REAL Express app on an ephemeral port (temp DATA_DIR) and drives
// /api/shifts/* through the actual middleware stack (auth → resolveTenant →
// requireTenant → attendance.use → staff_shifts entitlement). Covers:
//   seeded default rotation (Reception 2 → Kitchen 2 → Bar 3, 7-day cycle,
//   anchored to the Monday of the current week),
//   calendar resolution across block and cycle boundaries,
//   PUT replacement (order, days, anchor) + validation rules,
//   permission gates (attendance.use reads / shifts.manage writes),
//   plan entitlement gate (starter → 402),
//   untouched regression: shift CRUD + attendance clock-in still work.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-shifts-'));
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
    .run(id, 'Shifts ' + plan + ' Hotel', 'shifts-' + nanoid(5), plan);
  return id;
}
function makeUser(tenantId, role) {
  const id = 'user_' + nanoid(8);
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?,?)`)
    .run(id, tenantId, role, role + '-' + nanoid(5) + '@shifts.test', bcrypt.hashSync('pw', 8), role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

const proTenant = makeTenant('pro');
const starterTenant = makeTenant('starter');
const admin = makeUser(proTenant, 'hotel_admin');      // shifts.manage + attendance.use
const desk = makeUser(proTenant, 'receptionist');      // attendance.use only
const starterAdmin = makeUser(starterTenant, 'hotel_admin');

const adminTok = signAccessToken(admin);
const deskTok = signAccessToken(desk);
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

function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Same convention as the server: Monday of the current week (UTC).
function mondayOfThisWeek() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

async function run() {
  await new Promise(resolve => server.once('listening', resolve));

  // ── 1. Defaults seed on first access ─────────────────────────────────
  let r = await req('GET', '/api/shifts/rotation', adminTok);
  check('GET /api/shifts/rotation → 200', r.status === 200, 'got ' + r.status);
  const rot = r.body;
  check('default rotation = Reception 2 → Kitchen 2 → Bar 3',
    rot && rot.rotation && rot.rotation.length === 3 &&
    rot.rotation[0].department === 'Reception' && rot.rotation[0].daysOn === 2 &&
    rot.rotation[1].department === 'Kitchen' && rot.rotation[1].daysOn === 2 &&
    rot.rotation[2].department === 'Bar' && rot.rotation[2].daysOn === 3,
    JSON.stringify(rot && rot.rotation));
  check('cycle is 7 days with positions 1–2 / 3–4 / 5–7',
    rot && rot.totalDays === 7 &&
    rot.rotation[0].cycleDayStart === 1 && rot.rotation[0].cycleDayEnd === 2 &&
    rot.rotation[1].cycleDayStart === 3 && rot.rotation[1].cycleDayEnd === 4 &&
    rot.rotation[2].cycleDayStart === 5 && rot.rotation[2].cycleDayEnd === 7,
    rot && ('total=' + rot.totalDays));
  check('anchor defaults to the Monday of the current week',
    rot && rot.anchorDate === mondayOfThisWeek(), rot && rot.anchorDate);

  // Second read is idempotent (still 3 entries, same anchor).
  const rot2 = (await req('GET', '/api/shifts/rotation', adminTok)).body;
  check('re-read is idempotent (still 3 entries, same anchor)',
    rot2 && rot2.rotation.length === 3 && rot2.anchorDate === rot.anchorDate);

  // ── 2. Calendar resolution across block + cycle boundaries ───────────
  const anchor = rot.anchorDate;
  r = await req('GET', '/api/shifts/rotation/calendar?from=' + anchor + '&to=' + addDaysStr(anchor, 7), adminTok);
  check('calendar range → 200 with 8 days', r.status === 200 && Array.isArray(r.body.days) && r.body.days.length === 8,
    'got ' + r.status + ' len=' + (r.body && r.body.days && r.body.days.length));
  const days = r.body.days || [];
  const at = (n) => days.find(d => d.date === addDaysStr(anchor, n)) || {};
  check('anchor day 0: Reception day 1 (block start)',
    at(0).department === 'Reception' && at(0).dayInBlock === 1 && at(0).blockStart === addDaysStr(anchor, 0) && at(0).blockEnd === addDaysStr(anchor, 1),
    JSON.stringify(at(0)));
  check('anchor day 1: Reception day 2', at(1).department === 'Reception' && at(1).dayInBlock === 2, JSON.stringify(at(1)));
  check('anchor day 2: Kitchen takes over (day 1)', at(2).department === 'Kitchen' && at(2).dayInBlock === 1, JSON.stringify(at(2)));
  check('anchor day 4: Bar block starts (day 1 of 3)', at(4).department === 'Bar' && at(4).dayInBlock === 1 && at(4).blockDays === 3, JSON.stringify(at(4)));
  check('anchor day 6: Bar day 3 (block end)', at(6).department === 'Bar' && at(6).dayInBlock === 3 && at(6).blockEnd === addDaysStr(anchor, 6), JSON.stringify(at(6)));
  check('anchor day 7: cycle wraps to Reception', at(7).department === 'Reception' && at(7).dayInBlock === 1 && at(7).cycleDay === 1, JSON.stringify(at(7)));

  // Default window (no params): today → +20 days.
  r = await req('GET', '/api/shifts/rotation/calendar', adminTok);
  const today = new Date().toISOString().slice(0, 10);
  check('default calendar window: today → +20 (21 days)',
    r.status === 200 && r.body.days && r.body.days.length === 21 && r.body.days[0].date === today,
    'len=' + (r.body && r.body.days && r.body.days.length));

  // ── 3. PUT replacement (order, days, anchor) ─────────────────────────
  const newAnchor = addDaysStr(anchor, -7);
  r = await req('PUT', '/api/shifts/rotation', adminTok, {
    rotation: [
      { department: 'Reception', daysOn: 1 },
      { department: 'Kitchen', daysOn: 1 },
      { department: 'Bar', daysOn: 1 },
      { department: 'Security', daysOn: 4 },
    ],
    anchorDate: newAnchor,
  });
  check('PUT rotation → 200 with new cycle',
    r.status === 200 && r.body.totalDays === 7 && r.body.rotation.length === 4 &&
    r.body.rotation[3].department === 'Security' && r.body.rotation[3].daysOn === 4 && r.body.anchorDate === newAnchor,
    'got ' + r.status + ' ' + JSON.stringify(r.body && r.body.rotation).slice(0, 160));

  r = await req('GET', '/api/shifts/rotation/calendar?from=' + newAnchor + '&to=' + addDaysStr(newAnchor, 6), adminTok);
  const nd = r.body.days || [];
  const nat = (n) => nd.find(d => d.date === addDaysStr(newAnchor, n)) || {};
  check('calendar recomputes: Security holds days 3–6 of the new cycle',
    nat(0).department === 'Reception' && nat(1).department === 'Kitchen' && nat(2).department === 'Bar' &&
    nat(3).department === 'Security' && nat(3).dayInBlock === 1 && nat(6).department === 'Security' && nat(6).dayInBlock === 4,
    JSON.stringify(nd.map(d => d.department[0])));

  // PUT without anchorDate keeps the existing anchor.
  r = await req('PUT', '/api/shifts/rotation', adminTok, {
    rotation: [{ department: 'Reception', daysOn: 2 }, { department: 'Kitchen', daysOn: 2 }, { department: 'Bar', daysOn: 3 }],
  });
  check('PUT without anchorDate keeps the anchor',
    r.status === 200 && r.body.anchorDate === newAnchor && r.body.totalDays === 7,
    'anchor=' + (r.body && r.body.anchorDate));

  // ── 4. PUT validation ────────────────────────────────────────────────
  r = await req('PUT', '/api/shifts/rotation', adminTok, { rotation: [] });
  check('empty rotation → 400', r.status === 400, 'got ' + r.status);
  r = await req('PUT', '/api/shifts/rotation', adminTok, { rotation: [{ department: 'Bar', daysOn: 0 }] });
  check('daysOn 0 → 400', r.status === 400, 'got ' + r.status);
  r = await req('PUT', '/api/shifts/rotation', adminTok, {
    rotation: [{ department: 'Bar', daysOn: 2 }, { department: 'bar', daysOn: 1 }],
  });
  check('duplicate department (case-insensitive) → 400', r.status === 400, 'got ' + r.status);
  const tooLong = Array.from({ length: 13 }, (_, i) => ({ department: 'Dept ' + i, daysOn: 30 }));
  r = await req('PUT', '/api/shifts/rotation', adminTok, { rotation: tooLong });
  check('cycle > 366 days → 400', r.status === 400, 'got ' + r.status);
  r = await req('GET', '/api/shifts/rotation/calendar?from=' + anchor + '&to=' + addDaysStr(anchor, 93), adminTok);
  check('calendar range > 92 days → 400', r.status === 400, 'got ' + r.status);
  r = await req('PUT', '/api/shifts/rotation', adminTok, { rotation: [{ department: 'Bar', daysOn: 2 }], anchorDate: 'not-a-date' });
  check('invalid anchorDate → 400', r.status === 400, 'got ' + r.status);

  // ── 5. Permission gates ──────────────────────────────────────────────
  r = await req('GET', '/api/shifts/rotation', deskTok);
  check('receptionist (attendance.use) can READ the rotation → 200', r.status === 200, 'got ' + r.status);
  r = await req('PUT', '/api/shifts/rotation', deskTok, { rotation: [{ department: 'Bar', daysOn: 5 }] });
  check('receptionist (no shifts.manage) cannot WRITE → 403', r.status === 403, 'got ' + r.status);

  // ── 6. Untouched regression: shift CRUD + attendance clock-in ───────
  r = await req('POST', '/api/shifts', adminTok, { name: 'Morning', startTime: '07:00', endTime: '15:00', department: 'All' });
  check('shift CRUD untouched: create shift → 201', r.status === 201, 'got ' + r.status);
  const shiftId = r.body && r.body.id;
  r = await req('POST', '/api/shifts/attendance/clock-in', adminTok, { shiftId });
  check('attendance clock-in untouched → 201 present/late', r.status === 201 && (r.body.status === 'present' || r.body.status === 'late'),
    'got ' + r.status + ' ' + (r.body && r.body.status));

  // ── 7. Entitlement gate: starter plan → 402 UPGRADE_REQUIRED ────────
  r = await req('GET', '/api/shifts/rotation', starterTok);
  check('starter plan → 402 UPGRADE_REQUIRED', r.status === 402 && r.body && r.body.code === 'UPGRADE_REQUIRED',
    'got ' + r.status + ' ' + (r.body && r.body.code));

  // ── Summary ──────────────────────────────────────────────────────────
  const failed = results.filter(x => !x.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed.length) {
    console.error('FAILED: ' + failed.map(f => f.name).join(' | '));
    process.exit(1);
  }
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
