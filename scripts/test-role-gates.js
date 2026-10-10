#!/usr/bin/env node
// scripts/test-role-gates.js — fast API-level regression for role permissions.
// Verifies: Billing & Plan is owner/admin-only, while the front desk keeps
// read access to the booking-engine config and can run its desk workflow.
//
// Usage:  node scripts/test-role-gates.js              (spawns its own server)
//         PORT=3000 node scripts/test-role-gates.js    (test a running server)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 4420;
const BASE = 'http://localhost:' + PORT;
let srv = null;
let dataDir = null;

async function waitForHealth() {
  for (let i = 0; i < 30; i++) {
    try { await fetch(BASE + '/api/health'); return; } catch (e) { await new Promise(r => setTimeout(r, 400)); }
  }
  throw new Error('server never became healthy');
}

async function login(email) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Demo@123456' }),
  });
  const d = await r.json();
  if (!d.accessToken) throw new Error('login failed for ' + email + ': ' + JSON.stringify(d).slice(0, 120));
  return d.accessToken;
}

function status(path, token) {
  return fetch(BASE + path, { headers: { Authorization: 'Bearer ' + token } }).then(r => r.status);
}

let passed = 0, failed = 0;
function check(label, cond) {
  console.log((cond ? '  ✓ ' : '  ✗ FAIL: ') + label);
  cond ? passed++ : failed++;
}

(async () => {
  const external = !!process.env.PORT && !!srv;
  if (!external) {
    dataDir = fs.mkdtempSync('/tmp/staychat-rolegate.');
    fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db'), path.join(dataDir, 'staychat.db'));
    for (const ext of ['-wal', '-shm']) {
      if (fs.existsSync(path.join(ROOT, 'data', 'staychat.db' + ext))) fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db' + ext), path.join(dataDir, 'staychat.db' + ext));
    }
    srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production' }),
      stdio: 'ignore',
    });
    await waitForHealth();
  }

  console.log('── Billing & Plan visibility ──');
  const admin = await login('admin@hospitally.com');
  const recep = await login('reception@hospitally.com');
  check('admin: GET /api/billing/summary → 200', (await status('/api/billing/summary', admin)) === 200);
  check('admin: GET /api/billing/state → 200', (await status('/api/billing/state', admin)) === 200);
  check('receptionist: GET /api/billing/summary → 403', (await status('/api/billing/summary', recep)) === 403);
  check('receptionist: GET /api/billing/state → 403', (await status('/api/billing/state', recep)) === 403);
  check('receptionist: GET /api/billing/usage → 200 (job data unaffected)', (await status('/api/billing/usage', recep)) === 200);

  console.log('── API floors for minimal roles (cashier/barman have till-only powers) ──');
  const cashier = await login('cashier@hospitally.com');
  check('cashier: GET /api/guests → 200 (POS customer-bill picker still works)', (await status('/api/guests', cashier)) === 200);
  check('cashier: POST /api/guests → 403 (no guest-record creation)', (await fetch(BASE + '/api/guests', { method: 'POST', headers: { Authorization: 'Bearer ' + cashier, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Nope' }) })).status === 403);
  check('cashier: PATCH /api/guests/x → 403 (no ledger edits)', (await fetch(BASE + '/api/guests/x', { method: 'PATCH', headers: { Authorization: 'Bearer ' + cashier, 'Content-Type': 'application/json' }, body: '{}' })).status === 403);
  check('cashier: POST loyalty → 403 (no loyalty inflation)', (await fetch(BASE + '/api/guests/x/loyalty/add', { method: 'POST', headers: { Authorization: 'Bearer ' + cashier, 'Content-Type': 'application/json' }, body: '{}' })).status === 403);
  check('cashier: DELETE /api/guests/x → 403', (await fetch(BASE + '/api/guests/x', { method: 'DELETE', headers: { Authorization: 'Bearer ' + cashier } })).status === 403);
  check('cashier: POST /api/maintenance → 403', (await fetch(BASE + '/api/maintenance', { method: 'POST', headers: { Authorization: 'Bearer ' + cashier, 'Content-Type': 'application/json' }, body: JSON.stringify({ roomNumber: '101', issue: 'x' }) })).status === 403);
  check('cashier: POST /api/inbox/conversations → 403', (await fetch(BASE + '/api/inbox/conversations', { method: 'POST', headers: { Authorization: 'Bearer ' + cashier, 'Content-Type': 'application/json' }, body: '{}' })).status === 403);
  check('cashier: GET /api/analytics/summary → 403 (no dashboard)', (await status('/api/analytics/summary', cashier)) === 403);
  check('receptionist: POST /api/maintenance → 201 (desk logs issues)', (await fetch(BASE + '/api/maintenance', { method: 'POST', headers: { Authorization: 'Bearer ' + recep, 'Content-Type': 'application/json' }, body: JSON.stringify({ roomNumber: '101', issue: '[RoleGate] faucet drip' }) })).status === 201);
  check('receptionist: POST /api/guests → 200 (check-in flow registers guests)', (await fetch(BASE + '/api/guests', { method: 'POST', headers: { Authorization: 'Bearer ' + recep, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Role Gate Walk-in' }) })).status === 201);
  check('admin: GET /api/analytics/summary → 200', (await status('/api/analytics/summary', admin)) === 200);

  console.log('── WhatsApp setup surface ──');
  const settingsJson = await fetch(BASE + '/api/settings', { headers: { Authorization: 'Bearer ' + admin } }).then(r => r.json());
  const waSetup = settingsJson.waSetup || {};
  check('GET /api/settings exposes waSetup presence flags', typeof waSetup === 'object' && 'phoneNumberId' in waSetup && 'appSecret' in waSetup);
  check('receptionist: POST /api/settings/whatsapp/test → 403 (owner/admin only)', (await fetch(BASE + '/api/settings/whatsapp/test', { method: 'POST', headers: { Authorization: 'Bearer ' + recep, 'Content-Type': 'application/json' }, body: '{}' })).status === 403);
  const noCreds = await fetch(BASE + '/api/settings/whatsapp/test', { method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.status);
  check('admin test without saved credentials → 400 with guidance (' + noCreds + ')', noCreds === 400);
  // With (fake) credentials saved, the test's INBOUND self-check must pass —
  // it exercises this server's real handshake + signature gates. The OUTBOUND
  // probe will fail against Meta with a fake token (400/502), but the webhook
  // results ride along either way.
  await fetch(BASE + '/api/settings', { method: 'PATCH', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ waPhoneId: '111111111111111', waToken: 'fake_token_for_selftest', waVerifyToken: 'rolegate-verify', waAppSecret: 'rolegate-secret' }) });
  const testRes = await fetch(BASE + '/api/settings/whatsapp/test', { method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, body: '{}' });
  const testBody = await testRes.json();
  const wb = testBody.webhook || {};
  check('in-app test: webhook handshake self-check passes (echo via saved verify token)', wb.handshakeOk === true);
  check('in-app test: signed self-delivery passes the real signature gate', wb.signatureOk === true);
  check('in-app test: fake token rejected by Meta probe (' + testRes.status + ')', testRes.status === 400 || testRes.status === 502);
  await fetch(BASE + '/api/settings', { method: 'PATCH', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, body: JSON.stringify({ waPhoneId: '', waToken: '', waVerifyToken: '', waAppSecret: '' }) });

  console.log('── POS is not for the front desk ──');
  check('receptionist: GET /api/pos/tickets → 403 (restaurant/bar till is cashier/barman+managers)', (await status('/api/pos/tickets', recep)) === 403);
  check('admin: GET /api/pos/tickets → 200 (managers run any till)', (await status('/api/pos/tickets', admin)) === 200);

  console.log('── Booking engine access ──');
  // Booking dates must always be in the future — the engine rejects past
  // check-ins server-side, so the test computes them relative to today.
  const FUTURE_IN = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const FUTURE_OUT = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
  check('receptionist: GET /api/booking-engine/admin/config → 200 (desk read)', (await status('/api/booking-engine/admin/config', recep)) === 200);
  const cfgBody = JSON.stringify({ enabled: true, notice: 'x', maxDaily: 50 });
  check('receptionist: PUT /api/booking-engine/admin/config → 403 (no editing)', (await fetch(BASE + '/api/booking-engine/admin/config', { method: 'PUT', headers: { Authorization: 'Bearer ' + recep, 'Content-Type': 'application/json' }, body: cfgBody })).status === 403);
  check('admin: PUT /api/booking-engine/admin/config → 200', (await fetch(BASE + '/api/booking-engine/admin/config', { method: 'PUT', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, body: cfgBody })).status === 200);

  console.log('── Desk workflow on a fresh public booking ──');
  const av = await fetch(BASE + `/api/booking-engine/availability?subdomain=hospitally&checkIn=${FUTURE_IN}&checkOut=${FUTURE_OUT}`).then(r => r.json());
  const bk = await fetch(BASE + '/api/booking-engine/book', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subdomain: 'hospitally', guestName: 'Role Gate Guest', guestPhone: '+234807770011', checkIn: FUTURE_IN, checkOut: FUTURE_OUT, roomIds: [av.rooms[0].roomId], adults: 1, children: 0 }),
  }).then(r => r.json());
  check('guest booking created (' + (bk.code || '?') + ')', !!bk.code);
  const pending = await fetch(BASE + '/api/bookings?status=pending_payment', { headers: { Authorization: 'Bearer ' + recep } }).then(r => r.json());
  const mine = pending.find(b => b.engineCode === bk.code);
  check('receptionist sees the pending submission', !!mine);
  check('receptionist confirms → 200', (await fetch(BASE + '/api/bookings/' + mine.id + '/confirm', { method: 'POST', headers: { Authorization: 'Bearer ' + recep, 'Content-Type': 'application/json' }, body: '{}' })).status === 200);
  check('receptionist checks in → 200', (await fetch(BASE + '/api/bookings/' + mine.id + '/checkin', { method: 'POST', headers: { Authorization: 'Bearer ' + recep, 'Content-Type': 'application/json' }, body: '{}' })).status === 200);

  console.log('── Desk collects payment at checkout (settle = payments.use) ──');
  const bal = await fetch(BASE + '/api/payments/balance?bookingId=' + mine.id, { headers: { Authorization: 'Bearer ' + recep } }).then(r => r.json());
  const due = (bal.grandTotal !== undefined ? bal.grandTotal : 0);
  check('balance endpoint shows ' + due + ' outstanding before settle', due > 0);
  const refused = await fetch(BASE + '/api/payments/settle', { method: 'POST', headers: { Authorization: 'Bearer ' + recep, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId: mine.id, method: 'cash' }) });
  check('cash without an amount-collected figure → 400 (still validated)', refused.status === 400);
  const settled = await fetch(BASE + '/api/payments/settle', { method: 'POST', headers: { Authorization: 'Bearer ' + recep, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId: mine.id, method: 'cash', cashReceived: due }) });
  check('receptionist: POST /api/payments/settle → 200 (desk CAN collect)', settled.status === 200);
  const after = await fetch(BASE + '/api/payments/balance?bookingId=' + mine.id, { headers: { Authorization: 'Bearer ' + recep } }).then(r => r.json());
  check('balance cleared after settle (grandTotal=0, no double-charge)', after.grandTotal === 0);
  const refundBlock = await fetch(BASE + '/api/payments/transactions/x', { method: 'PATCH', headers: { Authorization: 'Bearer ' + recep, 'Content-Type': 'application/json' }, body: '{}' });
  check('receptionist: PATCH /api/payments/transactions → 403 (refunds/status edits stay manage-only)', refundBlock.status === 403);
  check('receptionist checks out the settled booking → 200', (await fetch(BASE + '/api/bookings/' + mine.id + '/checkout', { method: 'POST', headers: { Authorization: 'Bearer ' + recep, 'Content-Type': 'application/json' }, body: '{}' })).status === 200);

  console.log('── Help center public surface ──');
  check('GET /help → 200', (await status('/help', null)) === 200 || (await fetch(BASE + '/help').then(r => r.status)) === 200);
  const help = await fetch(BASE + '/api/help').then(r => r.json());
  check('GET /api/help → 18 manual sections, 25 FAQs', help.manual.length === 18 && help.faq.length === 25);
  const waHelp = (help.manual.find(s => s.id === 'whatsapp-ai') || {}).body || '';
  check('WhatsApp setup guide covers Meta console steps (token, verify token, app secret, webhook field)', ['Phone Number ID', 'System User', 'Verify Token', 'App Secret', 'webhooks/whatsapp', 'messages'].every(k => waHelp.includes(k)));
  const chat = await fetch(BASE + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'who can see the billing page?' }) }).then(r => r.json());
  check('chat answers billing-visibility question', (chat.reply || '').includes('owner'));

  console.log('\n' + (failed === 0 ? '═══ ROLE GATES: ' + passed + ' passed, 0 failed ═══' : '═══ ROLE GATES: ' + failed + ' FAILED ═══'));
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('✗', e.message); process.exit(1); });
