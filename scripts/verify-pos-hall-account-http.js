// scripts/verify-pos-hall-account-http.js
// End-to-end HTTP check for charging a restaurant/bar ticket to a Halls &
// Events booking's account. Boots the REAL Express app on an ephemeral port
// (temp DATA_DIR) and drives it through the actual middleware stack.
// Covers:
//   picker: cashier (pos.use, no halls.use) can list event accounts, an
//           unentitled hotel gets 402 and an empty POS button,
//   checkout: missing / unknown / cancelled event rejected without touching
//             the ticket, a valid event charges the sale onto hall_bookings
//             .fnb_total with no ledger transaction and no receivable,
//   visibility: the event bill, the hall account picker and the halls report
//               all show the POS charge,
//   refund: takes the amount back off the event bill, ticket marked refunded
//           with its reason, double refund rejected.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-pos-hall-'));
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
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?,?, 'active')`)
    .run(id, 'Hall Account Hotel', 'ha-' + nanoid(5), plan);
  return id;
}
function makeUser(tenantId, role) {
  const id = 'user_' + nanoid(8);
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?,?)`)
    .run(id, tenantId, role, role + '-' + nanoid(5) + '@hatest.test', bcrypt.hashSync('pw', 8), role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

const tenantId = makeTenant('enterprise');
const cheapTenantId = makeTenant('starter'); // no hall_events entitlement
const admin = makeUser(tenantId, 'hotel_admin');   // halls.manage + payments.manage + pos.use
const cashier = makeUser(tenantId, 'cashier');     // pos.use only, locked to restaurant
const cheapAdmin = makeUser(cheapTenantId, 'hotel_admin');

const adminTok = signAccessToken(admin);
const cashierTok = signAccessToken(cashier);
const cheapTok = signAccessToken(cheapAdmin);

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '✓ PASS' : '✗ FAIL') + '  ' + name + (extra ? '  — ' + extra : ''));
}

const { app } = require('../server/index');
const server = app.listen(0, '127.0.0.1');
const listening = new Promise(resolve => server.on('listening', resolve));

function req(method, pathName, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path: pathName, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    }, (res) => {
      let buf = '';
      res.on('data', c => (buf += c));
      res.on('end', () => {
        let json = null;
        try { json = buf ? JSON.parse(buf) : null; } catch { json = buf; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  await listening;

  // ── Seed: a hall with an event, and a menu item to sell ────────────────
  const hall = await req('POST', '/api/halls/halls', adminTok, { name: 'Grand Ballroom', capacity: 200, dayRate: 1200 });
  check('admin can create a hall', hall.status === 201, 'status ' + hall.status);
  const hallId = hall.body.id;

  const ev = await req('POST', '/api/halls/bookings', adminTok, {
    hallId, eventName: 'Okoro Wedding', organizerName: 'Mrs. Okoro', organizerPhone: '+2348000000000',
    eventDate: '2026-12-20', startTime: '18:00', endTime: '23:00', guestCount: 150,
    setupStyle: 'Banquet', catering: true, totalAmount: 5000, depositAmount: 2000, status: 'confirmed',
  });
  check('admin can create a confirmed event booking', ev.status === 201, 'status ' + ev.status);
  const eventId = ev.body.id;

  db.prepare(`INSERT INTO menu_items (id, tenant_id, name, price, category, outlet, available) VALUES (?,?,?,?,?,?,1)`)
    .run('mi_' + nanoid(6), tenantId, 'Jollof Rice', 40, 'Mains', 'restaurant');

  // ── Picker ──────────────────────────────────────────────────────────────
  const picker = await req('GET', '/api/pos/hall-accounts', cashierTok);
  check('cashier can read the event-account picker', picker.status === 200, 'status ' + picker.status);
  check('picker lists the confirmed event', Array.isArray(picker.body) && picker.body.some(b => b.id === eventId));
  const listed = (picker.body || []).find(b => b.id === eventId) || {};
  check('picker exposes the organizer + hall name', listed.organizerName === 'Mrs. Okoro' && listed.hallName === 'Grand Ballroom', JSON.stringify(listed));
  check('a hotel without hall_events gets 402', (await req('GET', '/api/pos/hall-accounts', cheapTok)).status === 402);

  // ── Ticket + charge ─────────────────────────────────────────────────────
  const ticket = await req('POST', '/api/pos/tickets', cashierTok, { outlet: 'restaurant', label: 'Table 4' });
  check('cashier opens a restaurant ticket', ticket.status === 201, 'status ' + ticket.status);
  const tid = ticket.body.id;

  const item = await req('POST', '/api/pos/tickets/' + tid + '/items', cashierTok, { name: 'Jollof Rice', price: 40, qty: 2 });
  check('two plates added to the ticket', item.status === 200 && Number(item.body.total) === 80, 'total ' + (item.body && item.body.total));

  const missing = await req('POST', '/api/pos/tickets/' + tid + '/checkout', cashierTok, { paymentMethod: 'hall_account' });
  check('checkout without an event is rejected (400)', missing.status === 400, 'status ' + missing.status);

  const unknown = await req('POST', '/api/pos/tickets/' + tid + '/checkout', cashierTok, { paymentMethod: 'hall_account', hallBookingId: 'hb_nope' });
  check('checkout to an unknown event is rejected (404)', unknown.status === 404, 'status ' + unknown.status);

  const cancelled = await req('POST', '/api/halls/bookings', adminTok, {
    hallId, eventName: 'Cancelled Gala', organizerName: 'Mr. Ade',
    eventDate: '2026-12-28', startTime: '10:00', endTime: '14:00', guestCount: 20, status: 'cancelled',
  });
  const onCancelled = await req('POST', '/api/pos/tickets/' + tid + '/checkout', cashierTok, { paymentMethod: 'hall_account', hallBookingId: cancelled.body.id });
  check('a cancelled event cannot take a charge (409)', onCancelled.status === 409, 'status ' + onCancelled.status);

  const stillOpen = db.prepare('SELECT status, total FROM pos_tickets WHERE id = ?').get(tid);
  check('rejected checkouts leave the ticket open', stillOpen.status === 'open' && Number(stillOpen.total) === 80);

  const paid = await req('POST', '/api/pos/tickets/' + tid + '/checkout', cashierTok, { paymentMethod: 'hall_account', hallBookingId: eventId });
  check('ticket checks out to the event account', paid.status === 200, 'status ' + paid.status);
  check('payment method recorded as hall_account', paid.body.ticket.payment_method === 'hall_account');
  check('ticket is linked to the booking', paid.body.ticket.hall_booking_id === eventId);
  check('ticket points at no ledger transaction', !paid.body.ticket.transaction_id && paid.body.transaction === null);
  check('guest name picked up from the organizer', paid.body.ticket.guest_name === 'Mrs. Okoro', paid.body.ticket.guest_name);

  const bill = db.prepare('SELECT fnb_total FROM hall_bookings WHERE id = ?').get(eventId);
  check('the event bill grew by the sale (80)', Number(bill.fnb_total) === 80, 'fnb_total ' + bill.fnb_total);
  const ledger = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE tenant_id = ?`).get(tenantId);
  check('no receivable was posted to the ledger', ledger.n === 0, ledger.n + ' transactions');

  const recheckout = await req('POST', '/api/pos/tickets/' + tid + '/checkout', cashierTok, { paymentMethod: 'hall_account', hallBookingId: eventId });
  check('a settled ticket cannot be charged twice (409)', recheckout.status === 409, 'status ' + recheckout.status);

  // ── Visibility on the Halls page + report ───────────────────────────────
  const bookings = await req('GET', '/api/halls/bookings', adminTok);
  const row = (bookings.body || []).find(b => b.id === eventId) || {};
  check('halls list shows the POS charge count', Number(row.pos_charges) === 1, 'pos_charges ' + row.pos_charges);
  check('halls list shows the POS charge value', Number(row.pos_sales) === 80, 'pos_sales ' + row.pos_sales);
  check('halls list keeps the event bill total', Number(row.fnb_total) === 80, 'fnb_total ' + row.fnb_total);

  const report = await req('GET', '/api/reports/hall?period=custom&from=2026-12-01&to=2026-12-31', adminTok);
  check('hall report renders', report.status === 200, 'status ' + report.status);
  const rrow = (report.body.rows || []).find(b => b.id === eventId) || {};
  check('report row breaks out the POS sales', Number(rrow.pos_sales) === 80, 'pos_sales ' + rrow.pos_sales);
  check('report summary totals the POS sales', Number(report.body.summary.posSalesTotal) === 80, 'posSalesTotal ' + report.body.summary.posSalesTotal);
  check('report summary counts POS tickets', Number(report.body.summary.posTickets) === 1, 'posTickets ' + report.body.summary.posTickets);
  check('report total includes the POS sales', Number(report.body.summary.total) === 5000 + 80, 'total ' + report.body.summary.total);

  // ── Refund takes the sale back off the event bill ───────────────────────
  const refund = await req('POST', '/api/pos/tickets/' + tid + '/refund', adminTok, { reason: 'Event moved to the garden menu' });
  check('refund succeeds', refund.status === 200, 'status ' + refund.status);
  check('refund reports the amount', Number(refund.body.refunded) === 80, 'refunded ' + refund.body.refunded);
  const afterRefund = db.prepare('SELECT fnb_total FROM hall_bookings WHERE id = ?').get(eventId);
  check('the event bill lost the refunded sale', Number(afterRefund.fnb_total) === 0, 'fnb_total ' + afterRefund.fnb_total);
  const refunded = db.prepare('SELECT status, refund_reason, refunded_amount FROM pos_tickets WHERE id = ?').get(tid);
  check('ticket marked refunded with its reason', refunded.status === 'refunded' && refunded.refund_reason === 'Event moved to the garden menu' && Number(refunded.refunded_amount) === 80);

  const again = await req('POST', '/api/pos/tickets/' + tid + '/refund', adminTok, { reason: 'again' });
  check('a refunded ticket cannot be refunded twice (409)', again.status === 409, 'status ' + again.status);
  check('second refund leaves the event bill at 0', Number(db.prepare('SELECT fnb_total FROM hall_bookings WHERE id = ?').get(eventId).fnb_total) === 0);
}

main().catch(err => { console.error(err); process.exitCode = 1; }).then(() => {
  const failed = results.filter(r => !r.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  if (failed.length) console.log('FAILED: ' + failed.map(f => f.name).join(' | '));
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed.length || process.exitCode ? 1 : 0);
});
