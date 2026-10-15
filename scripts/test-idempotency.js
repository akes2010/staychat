#!/usr/bin/env node
// scripts/test-idempotency.js — proves the offline-first replay contract.
//
// The PWA queues writes while offline and replays them with an
// `Idempotency-Key` header when the connection returns. This suite executes
// every replayed request TWICE against a live server and asserts the server
// executed it exactly once:
//
//   • guests    — replay returns the ORIGINAL body/status (no dup record);
//                 key reuse with a different payload → 409 IDEMPOTENCY_MISMATCH;
//                 no header → old behavior (two records) — zero impact without a key
//   • bookings  — double replay never creates a second reservation
//   • check-in  — replay is a no-op replay; a NEW key against an already
//                 checked-in booking still 409s (route guards untouched)
//   • settle    — replay never double-charges (balance stays cleared, one txn)
//   • checkout  — replay returns the original answer
//
// Usage:  node scripts/test-idempotency.js             (spawns its own server)
//         PORT=3000 node scripts/test-idempotency.js   (test a running server)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 4423;
const BASE = 'http://localhost:' + PORT;
let srv = null;
let dataDir = null;

async function waitForHealth() {
  for (let i = 0; i < 30; i++) {
    try { await fetch(BASE + '/api/health'); return; } catch (e) { await new Promise(r => setTimeout(r, 400)); }
  }
  throw new Error('server never became healthy');
}

let passed = 0, failed = 0;
function check(label, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ FAIL: ') + label + (cond || extra === undefined ? '' : '  → ' + extra));
  cond ? passed++ : failed++;
}

async function call(method, p, token, body, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (key) headers['Idempotency-Key'] = key;
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: r.status, data, replay: r.headers.get('idempotent-replay') === 'true' };
}

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  if (!process.env.PORT) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-idem.'));
    srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production' }),
      stdio: 'ignore',
    });
    await waitForHealth();
  }

  console.log('── Fresh tenant (register seeds starter rooms) ──');
  const email = 'idem_' + Date.now() + '@example.test';
  const reg = await call('POST', '/api/auth/register', null, {
    hotelName: 'Idempotency Test Hotel', name: 'Idem Admin', email, password: 'Str0ng!Pass9x',
  });
  check('register → 200/201 (' + reg.status + ')', reg.status === 200 || reg.status === 201, JSON.stringify(reg.data).slice(0, 140));
  const token = reg.data && reg.data.accessToken;
  check('accessToken issued', !!token);

  console.log('── Guests: replay = original record, never a dup ──');
  const gBody = { name: 'Idem Alice', phone: '+15550001' };
  const g1 = await call('POST', '/api/guests', token, gBody, 'K-guest-1');
  const g2 = await call('POST', '/api/guests', token, gBody, 'K-guest-1');
  check('first execution ' + g1.status + ' (201 expected)', g1.status === 201, JSON.stringify(g1.data).slice(0, 120));
  check('replay ' + g2.status + ' with Idempotent-Replay header', g2.status === 201 && g2.replay, 'replay=' + g2.replay);
  check('replay body identical to original (same guest id)', deepEq(g1.data, g2.data));
  const guests = await call('GET', '/api/guests', token);
  const aliceCount = (guests.data || []).filter(g => g.name === 'Idem Alice').length;
  check('exactly ONE "Idem Alice" row in the DB (got ' + aliceCount + ')', aliceCount === 1);

  console.log('── Guests: key reuse with a DIFFERENT payload is rejected ──');
  const mismatch = await call('POST', '/api/guests', token, { name: 'Idem Bob' }, 'K-guest-1');
  check('same key + different body → 409 IDEMPOTENCY_MISMATCH (' + mismatch.status + ')',
    mismatch.status === 409 && mismatch.data && mismatch.data.code === 'IDEMPOTENCY_MISMATCH',
    JSON.stringify(mismatch.data).slice(0, 120));

  console.log('── No header → behavior unchanged (key middleware is inert) ──');
  const n1 = await call('POST', '/api/guests', token, { name: 'Idem Twice' });
  const n2 = await call('POST', '/api/guests', token, { name: 'Idem Twice' });
  check('without a key both execute (201 + 201)', n1.status === 201 && n2.status === 201);
  const guests2 = await call('GET', '/api/guests', token);
  check('without a key → TWO rows, exactly as before this feature',
    (guests2.data || []).filter(g => g.name === 'Idem Twice').length === 2);

  console.log('── Booking creation: double replay = ONE reservation ──');
  const rooms = await call('GET', '/api/rooms', token);
  const room = (rooms.data || [])[0];
  check('starter room available', !!room, JSON.stringify(rooms.data).slice(0, 100));
  const IN = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const OUT = new Date(Date.now() + 16 * 86400000).toISOString().slice(0, 10);
  const bkBody = {
    surname: 'Idem', firstName: 'Replay', checkIn: IN, checkOut: OUT,
    roomIds: [room.id], isGroup: false, adults: 1, children: 0, source: 'direct', notes: '',
  };
  const b1 = await call('POST', '/api/bookings', token, bkBody, 'K-book-1');
  const b2 = await call('POST', '/api/bookings', token, bkBody, 'K-book-1');
  check('booking created ' + b1.status + ' (' + (b1.data && b1.data.reference) + ')', (b1.status === 200 || b1.status === 201) && !b1.data.error, JSON.stringify(b1.data).slice(0, 160));
  check('replay ' + b2.status + ' flagged + SAME booking id', (b2.status === 200 || b2.status === 201) && b2.replay && b1.data.id === b2.data.id, JSON.stringify(b2.data).slice(0, 160));
  const all = await call('GET', '/api/bookings', token);
  const refCount = (all.data || []).filter(b => b.reference === (b1.data && b1.data.reference)).length;
  check('exactly ONE booking with reference ' + (b1.data && b1.data.reference) + ' (got ' + refCount + ')', refCount === 1);
  const bookingId = b1.data.id;
  let status = b1.data.status;
  if (status !== 'confirmed') {
    const cf = await call('POST', '/api/bookings/' + bookingId + '/confirm', token, {}, 'K-book-confirm');
    check('confirm → ' + cf.status, cf.status === 200, JSON.stringify(cf.data).slice(0, 120));
  }

  console.log('── Check-in: replay is safe, fresh key still guarded ──');
  const c1 = await call('POST', '/api/bookings/' + bookingId + '/checkin', token, {}, 'K-ci-1');
  const c2 = await call('POST', '/api/bookings/' + bookingId + '/checkin', token, {}, 'K-ci-1');
  check('check-in ' + c1.status + ' → checked_in', c1.status === 200 && c1.data.status === 'checked_in', JSON.stringify(c1.data).slice(0, 140));
  check('replay ' + c2.status + ' returns the stored check-in response', c2.status === 200 && c2.replay && deepEq(c1.data, c2.data));
  const c3 = await call('POST', '/api/bookings/' + bookingId + '/checkin', token, {}, 'K-ci-2');
  check('NEW key against an already checked-in booking → 409 (route guard intact)',
    c3.status === 409, JSON.stringify(c3.data).slice(0, 140));

  console.log('── Settle: replay must NEVER double-charge ──');
  const balBefore = await call('GET', '/api/payments/balance?bookingId=' + bookingId, token);
  const due = balBefore.data && balBefore.data.grandTotal;
  check('outstanding balance before settle: ' + due, typeof due === 'number' && due > 0, JSON.stringify(balBefore.data).slice(0, 140));
  const sBody = { bookingId, method: 'cash', cashReceived: due };
  const s1 = await call('POST', '/api/payments/settle', token, sBody, 'K-settle-1');
  const s2 = await call('POST', '/api/payments/settle', token, sBody, 'K-settle-1');
  check('settle ' + s1.status + ' collected ' + (s1.data && s1.data.grandTotal), s1.status === 200, JSON.stringify(s1.data).slice(0, 160));
  check('replay ' + s2.status + ' returns the IDENTICAL settlement receipt', s2.status === 200 && s2.replay && deepEq(s1.data, s2.data));
  const balAfter = await call('GET', '/api/payments/balance?bookingId=' + bookingId, token);
  check('balance still cleared exactly once (grandTotal=' + (balAfter.data && balAfter.data.grandTotal) + ')',
    balAfter.data && balAfter.data.grandTotal === 0, JSON.stringify(balAfter.data).slice(0, 140));
  const txns = await call('GET', '/api/payments/transactions', token);
  const settleTxns = (txns.data || []).filter(t => t.booking_id === bookingId && String(t.gateway_ref || '').startsWith('SETTLE-'));
  check('exactly ONE settlement transaction on record (got ' + settleTxns.length + ')', settleTxns.length === 1);

  console.log('── Check-out: replay returns the original answer ──');
  const o1 = await call('POST', '/api/bookings/' + bookingId + '/checkout', token, {}, 'K-co-1');
  const o2 = await call('POST', '/api/bookings/' + bookingId + '/checkout', token, {}, 'K-co-1');
  check('check-out ' + o1.status + ' → checked_out', o1.status === 200 && o1.data.status === 'checked_out', JSON.stringify(o1.data).slice(0, 140));
  check('replay ' + o2.status + ' identical body', o2.status === 200 && o2.replay && deepEq(o1.data, o2.data));

  console.log('\n════════════════════════════════════════════════');
  console.log(failed === 0 ? ' ✓ ALL ' + passed + ' IDEMPOTENCY CHECKS PASSED' : ' ✗ ' + failed + ' of ' + (passed + failed) + ' CHECKS FAILED');
  console.log('════════════════════════════════════════════════');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('✗ suite crashed:', e && e.stack || e);
  process.exit(1);
}).finally(() => {
  if (srv) { try { srv.kill('SIGTERM'); } catch (e) {} }
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} }
});
