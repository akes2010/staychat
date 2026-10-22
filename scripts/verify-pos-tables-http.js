// scripts/verify-pos-tables-http.js
// End-to-end HTTP check for the POS table picker: boots the REAL Express app
// on an ephemeral port (temp DATA_DIR) and drives /api/pos/tables +
// /api/pos/tickets + /api/tables through the actual middleware stack.
// Covers:
//   picker list: active tables only, occupancy flags, pos.use gate,
//   seating on open: label mirrors the table, table_id + covers persist,
//   seat rules: already-seated 409, outlet mismatch 400, inactive 409,
//               unknown 404, party-too-big 400, covers range 400,
//   free-text labels keep working (no tableId) — back-compat,
//   re-seat while open (label syncs, self-exclusion on the clash check),
//   unseating (tableId: null), covers-only edits vs the current seat,
//   void frees the table for the next ticket, audit trail.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-pos-tables-'));
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
    .run(id, 'PosTable Hotel', 'posT-' + nanoid(5));
  return id;
}
function makeUser(tenantId, role) {
  const id = 'user_' + nanoid(8);
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?,?)`)
    .run(id, tenantId, role, role + '-' + nanoid(5) + '@post.test', bcrypt.hashSync('pw', 8), role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

const tenantId = makeTenant();
const admin = makeUser(tenantId, 'hotel_admin'); // tables.manage + pos.use
const cashier = makeUser(tenantId, 'cashier');   // pos.use only — picker yes, no table mgmt
const staff = makeUser(tenantId, 'receptionist'); // no pos.use (front desk, not the till)

const adminTok = signAccessToken(admin);
const cashierTok = signAccessToken(cashier);
const staffTok = signAccessToken(staff);

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

  // ── Seed tables through the real management API ─────────────────────────
  const mk = (name, location, persons, chairs) =>
    req('POST', '/api/tables', adminTok, { name, location, persons, chairs, sitting: 'Standard' });
  let r = await mk('T1', 'restaurant', 4, 4);
  const t1 = r.body;
  r = await mk('T2', 'restaurant', 2, 2);
  const t2 = r.body;
  r = await mk('High 1', 'bar', 2, 2);
  const high1 = r.body;
  r = await mk('T3', 'restaurant', 4, 4);
  const t3 = r.body;
  r = await req('PATCH', '/api/tables/' + t3.id, adminTok, { active: false });
  check('seeded 4 tables (T3 inactive)', r.status === 200 && r.body.active === false, 'got ' + r.status);

  // ── 1. Picker list endpoint ─────────────────────────────────────────────
  r = await req('GET', '/api/pos/tables', null);
  check('GET /api/pos/tables without token → 401', r.status === 401, 'got ' + r.status);

  r = await req('GET', '/api/pos/tables', adminTok);
  check('picker lists active tables only', r.status === 200 && Array.isArray(r.body) &&
    r.body.length === 3 && !r.body.some(x => x.id === t3.id), 'n=' + (r.body && r.body.length));
  const seeded = r.body;
  check('picker rows carry name/persons/chairs/sitting/occupancy shape',
    seeded.every(x => typeof x.name === 'string' && Number.isInteger(x.persons) && Number.isInteger(x.chairs) &&
      typeof x.sitting === 'string' && x.occupied === false && x.ticketId === null),
    JSON.stringify(seeded[0]).slice(0, 140));

  r = await req('GET', '/api/pos/tables', cashierTok);
  check('cashier (pos.use) can read the picker → 200', r.status === 200 && Array.isArray(r.body), 'got ' + r.status);
  r = await req('GET', '/api/pos/tables', staffTok);
  check('receptionist without pos.use → 403', r.status === 403, 'got ' + r.status);

  // ── 2. Seating on open ──────────────────────────────────────────────────
  r = await req('POST', '/api/pos/tickets', adminTok, { outlet: 'restaurant', tableId: t1.id, covers: 4, guestName: 'Ada' });
  check('open ticket seated at T1 → 201', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
  const tk1 = r.body;
  check('ticket label mirrors the table, table_id + covers persist',
    tk1 && tk1.label === 'T1' && tk1.table_id === t1.id && tk1.covers === 4,
    JSON.stringify(tk1 && { label: tk1.label, table_id: tk1.table_id, covers: tk1.covers }));

  r = await req('GET', '/api/pos/tables', adminTok);
  const t1row = r.body.find(x => x.id === t1.id);
  check('T1 now shows occupied with its ticket id', t1row && t1row.occupied === true && t1row.ticketId === tk1.id,
    JSON.stringify(t1row));

  r = await req('POST', '/api/pos/tickets', cashierTok, { outlet: 'restaurant', tableId: t1.id });
  check('second ticket at the seated T1 → 409', r.status === 409 && /already seated/.test(r.body && r.body.error ? r.body.error : ''),
    'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 90));

  r = await req('POST', '/api/pos/tickets', adminTok, { outlet: 'restaurant', tableId: high1.id });
  check('bar table cannot seat a restaurant ticket → 400', r.status === 400 && /cannot seat/.test(r.body && r.body.error ? r.body.error : ''),
    'got ' + r.status);

  r = await req('POST', '/api/pos/tickets', adminTok, { outlet: 'restaurant', tableId: 'tbl_missing' });
  check('unknown table → 404', r.status === 404, 'got ' + r.status);

  r = await req('POST', '/api/pos/tickets', adminTok, { outlet: 'restaurant', tableId: t3.id });
  check('inactive table → 409', r.status === 409 && /not active/.test(r.body && r.body.error ? r.body.error : ''),
    'got ' + r.status);

  // ── 3. Capacity (persons) ───────────────────────────────────────────────
  r = await req('POST', '/api/pos/tickets', adminTok, { outlet: 'restaurant', tableId: t2.id, covers: 5 });
  check('party of 5 at a 2-person table → 400 does not fit', r.status === 400 && /does not fit/.test(r.body && r.body.error ? r.body.error : ''),
    'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 100));

  r = await req('POST', '/api/pos/tickets', adminTok, { outlet: 'restaurant', covers: 0 });
  check('covers = 0 → 400', r.status === 400 && /covers/.test(r.body && r.body.error ? r.body.error : ''), 'got ' + r.status);
  r = await req('POST', '/api/pos/tickets', adminTok, { outlet: 'restaurant', covers: 51 });
  check('covers = 51 → 400', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/pos/tickets', adminTok, { outlet: 'restaurant', covers: 2.5 });
  check('fractional covers → 400', r.status === 400, 'got ' + r.status);

  // ── 4. Back-compat: free-text labels, covers without a table ────────────
  r = await req('POST', '/api/pos/tickets', cashierTok, { outlet: 'restaurant', label: 'Counter seat' });
  check('free-text label without tableId still works → 201', r.status === 201 &&
    r.body.label === 'Counter seat' && r.body.table_id === null, 'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 90));
  const tk2 = r.body;

  r = await req('POST', '/api/pos/tickets', adminTok, { outlet: 'restaurant', covers: 2 });
  check('covers without a table → 201 stored', r.status === 201 && r.body.covers === 2 && r.body.table_id === null,
    'got ' + r.status);
  const tk3 = r.body;

  // ── 5. Re-seat while open ───────────────────────────────────────────────
  r = await req('PATCH', '/api/pos/tickets/' + tk2.id, adminTok, { tableId: t2.id });
  check('re-seat free-text ticket onto T2 → 200, label syncs to "T2"',
    r.status === 200 && r.body.table_id === t2.id && r.body.label === 'T2',
    'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 110));

  r = await req('PATCH', '/api/pos/tickets/' + tk3.id, adminTok, { tableId: t2.id });
  check('another ticket onto the seated T2 → 409', r.status === 409, 'got ' + r.status);

  r = await req('PATCH', '/api/pos/tickets/' + tk3.id, adminTok, { covers: 5 });
  check('covers-only edit (no table) → 200 stored', r.status === 200 && r.body.covers === 5, 'got ' + r.status);

  r = await req('PATCH', '/api/pos/tickets/' + tk1.id, adminTok, { covers: 9 });
  check('covers beyond the seated table capacity → 400', r.status === 400 && /does not fit/.test(r.body && r.body.error ? r.body.error : ''),
    'got ' + r.status);

  r = await req('PATCH', '/api/pos/tickets/' + tk1.id, adminTok, { covers: 3 });
  check('smaller party on the seated table → 200', r.status === 200 && r.body.covers === 3, 'got ' + r.status);

  r = await req('PATCH', '/api/pos/tickets/' + tk2.id, adminTok, { tableId: null });
  check('unseat (tableId null) → 200, table cleared, label unchanged',
    r.status === 200 && r.body.table_id === null && r.body.label === 'T2', 'got ' + r.status);

  // ── 6. Void frees the seat ──────────────────────────────────────────────
  r = await req('POST', '/api/pos/tickets/' + tk1.id + '/void', adminTok, {});
  check('void the T1 ticket → 200', r.status === 200, 'got ' + r.status);
  r = await req('GET', '/api/pos/tables', adminTok);
  check('T1 free again after the void', r.body.find(x => x.id === t1.id).occupied === false, JSON.stringify(r.body.find(x => x.id === t1.id)));
  r = await req('POST', '/api/pos/tickets', adminTok, { outlet: 'restaurant', tableId: t1.id, covers: 4 });
  check('a new ticket can take T1 after the void → 201', r.status === 201 && r.body.table_id === t1.id, 'got ' + r.status);

  // ── 7. Audit trail ──────────────────────────────────────────────────────
  const seats = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tenant_id = ? AND action = 'pos.ticket_seat'").get(tenantId).c;
  check('seat events audited (open + re-seat)', seats >= 4, 'n=' + seats);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter(x => !x.ok);
  console.log('\n' + (failed.length ? '✗ ' + failed.length + ' of ' + results.length + ' checks FAILED' : '✓ ALL ' + results.length + ' CHECKS PASSED'));
  process.exit(failed.length ? 1 : 0);
}

run().catch(e => { console.error(e); try { server.close(); } catch (x) {} process.exit(1); });
