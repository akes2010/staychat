// scripts/verify-booking-http.js
// End-to-end HTTP check for the pay-at-booking module: boots the REAL Express app
// on an ephemeral port and drives POST /api/bookings through the actual middleware
// stack (auth → resolveTenant → requireTenant), permission gate, validation, the
// transaction, journal posting, and the checkout balance integration. Covers the
// scenarios the in-process replicated-path harness can't: 403 permission gate,
// 400 over-amount guard, no-payment regression, and full-payment → checkout.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-http-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // ephemeral

const db = require('../server/db/connection');
require('../server/db/migrate');

const { nanoid } = require('nanoid');
const bcrypt = require('bcryptjs');
const { signAccessToken } = require('../server/utils/tokens');
const { ensureDefaultAccounts } = require('../server/routes/accounting');

// ── Seed tenant, two users, one room ──
// User 2 is a receptionist whose per-user permissions were customized to REMOVE
// payments.use — the realistic "can book, cannot take money" profile. (The
// original fixture used an invented 'cleaner' role that the users.role CHECK
// constraint no longer permits; plain 'staff' also lacks bookings.manage, so the
// booking gate itself would 403 before the payment gate is ever reached.)
const tenantId = 'tenant_' + nanoid(8);
db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?, 'pro', 'active')`)
  .run(tenantId, 'HTTP Hotel', 'http-' + nanoid(5));

function makeUser(role) {
  const id = 'user_' + nanoid(8);
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?,?)`)
    .run(id, tenantId, role, role + '-' + nanoid(5) + '@http.test', bcrypt.hashSync('pw', 8), role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
const reception = makeUser('receptionist'); // has payments.use
// Customized permissions: receptionist defaults minus payments.use.
// permissions_customized=1 makes the users.permissions column authoritative.
const { ROLE_DEFAULTS } = require('../server/utils/permissions');
const noPayPerms = JSON.stringify(ROLE_DEFAULTS.receptionist.filter(p => p !== 'payments.use'));
db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, permissions, permissions_customized)
            VALUES (?,?,?,?,?, 'receptionist', ?, 1)`)
  .run('user_' + nanoid(8), tenantId, 'NoPay Desk', 'nopay-' + nanoid(5) + '@http.test', bcrypt.hashSync('pw', 8), noPayPerms);
const noPayUser = db.prepare('SELECT * FROM users WHERE email LIKE ?').get('nopay-%@http.test');

const roomId = 'room_' + nanoid(8);
db.prepare(`INSERT INTO rooms (id, tenant_id, number, type, rate, status) VALUES (?,?,?,?,?, 'available')`)
  .run(roomId, tenantId, '201', 'Standard', 100);
ensureDefaultAccounts(tenantId);

const receptionTok = signAccessToken(reception);
const noPayTok = signAccessToken(noPayUser);

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
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        let json = null; try { json = raw ? JSON.parse(raw) : null; } catch (e) { /* non-json */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const BASE = { checkIn: '2026-10-01', checkOut: '2026-10-04', roomIds: [roomId] }; // 3 nights @100 = 300

(async () => {
  server.on('listening', () => {});
  await new Promise(r => server.once('listening', r));

  // 1) No-payment regression — confirmed booking, paid_amount 0, no transaction
  let res = await req('POST', '/api/bookings', receptionTok, { ...BASE, surname: 'NoPay', source: 'direct' });
  check('no-payment booking created (201)', res.status === 201, 'status=' + res.status);
  check('no-payment: status confirmed & paid_amount 0', res.body && res.body.status === 'confirmed' && res.body.paid_amount === 0, res.body ? 'paid=' + res.body.paid_amount : '');
  const noPayTxns = db.prepare("SELECT COUNT(*) c FROM transactions WHERE booking_id = ?").get(res.body.id).c;
  check('no-payment: no transaction row recorded', noPayTxns === 0, 'txns=' + noPayTxns);

  // 2) Cash at booking — 120 of 300
  res = await req('POST', '/api/bookings', receptionTok, { ...BASE, surname: 'CashPay', roomIds: [roomId], checkIn: '2026-11-01', checkOut: '2026-11-04', payment: { amount: 120, method: 'cash' } });
  check('cash booking created (201)', res.status === 201, 'status=' + res.status);
  check('cash: payment echoed in response', res.body && res.body.payment && res.body.payment.amount === 120, res.body && res.body.payment ? 'amt=' + res.body.payment.amount : 'no payment');
  check('cash: paid_amount reflects payment', res.body && res.body.paid_amount === 120, res.body ? 'paid=' + res.body.paid_amount : '');
  const cashTxn = db.prepare("SELECT * FROM transactions WHERE booking_id = ? AND status='completed'").get(res.body.id);
  check('cash: completed transaction persisted', !!cashTxn && cashTxn.amount === 120, cashTxn ? 'method=' + cashTxn.method : 'none');

  // 3) Over-amount guard — payment > room total
  res = await req('POST', '/api/bookings', receptionTok, { ...BASE, surname: 'OverPay', roomIds: [roomId], checkIn: '2026-12-01', checkOut: '2026-12-04', payment: { amount: 9999, method: 'cash' } });
  check('over-amount rejected (400)', res.status === 400, 'status=' + res.status);
  check('over-amount: error mentions room total', res.body && /room total/i.test(res.body.error || ''), res.body ? res.body.error : '');

  // 4) Permission gate — user without payments.use tries to record money
  res = await req('POST', '/api/bookings', noPayTok, { ...BASE, surname: 'NoPerm', roomIds: [roomId], checkIn: '2027-01-01', checkOut: '2027-01-04', payment: { amount: 50, method: 'cash' } });
  check('no-permission payment rejected (403)', res.status === 403, 'status=' + res.status);
  // …but the same user can still book WITHOUT payment
  res = await req('POST', '/api/bookings', noPayTok, { ...BASE, surname: 'NoPermNoPay', roomIds: [roomId], checkIn: '2027-02-01', checkOut: '2027-02-04' });
  check('no-permission booking without payment still works (201)', res.status === 201, 'status=' + res.status);

  // 5) Full payment → check in → check out with no outstanding-balance block
  res = await req('POST', '/api/bookings', receptionTok, { ...BASE, surname: 'FullPay', roomIds: [roomId], checkIn: '2027-03-01', checkOut: '2027-03-04', payment: { amount: 300, method: 'card' } });
  check('full payment booking created (201)', res.status === 201, 'status=' + res.status);
  const fullId = res.body.id;
  // card → journal should debit Bank, not Cash
  const bankAcct = db.prepare("SELECT a.id FROM accounts a WHERE a.tenant_id = ? AND a.system_key = 'bank'").get(tenantId);
  const bankDebit = db.prepare('SELECT COALESCE(SUM(debit),0) d FROM journal_lines WHERE account_id = ?').get(bankAcct.id).d;
  check('card payment debits Bank account (not Cash)', Math.abs(bankDebit - 300) < 0.005, 'bankDebit=' + bankDebit);
  let ci = await req('POST', '/api/bookings/' + fullId + '/checkin', receptionTok, {});
  check('full-paid booking checks in (200)', ci.status === 200, 'status=' + ci.status);
  let co = await req('POST', '/api/bookings/' + fullId + '/checkout', receptionTok, {});
  check('full-paid booking checks out with no balance block (200)', co.status === 200, 'status=' + co.status + (co.body && co.body.error ? ' err=' + co.body.error : ''));

  // ── Cleanup ──
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter(r => !r.ok);
  console.log('\n' + (failed.length ? '✗ ' + failed.length + ' check(s) FAILED' : '✓ ALL ' + results.length + ' CHECKS PASSED'));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
