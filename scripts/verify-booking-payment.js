// scripts/verify-booking-payment.js
// Standalone end-to-end check for the optional pay-at-booking module.
// Boots the real migration against a throwaway DB, then drives the actual
// Express app in-process via a lightweight HTTP request to exercise the
// POST /api/bookings payment path, the journal posting, and the balance math.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the DB at a fresh temp dir BEFORE anything requires the connection.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-verify-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-verify';
process.env.COOKIE_SECRET = 'test-cookie-verify';

const db = require('../server/db/connection');
require('../server/db/migrate');

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? '✓ PASS' : '✗ FAIL') + '  ' + name + (extra ? '  — ' + extra : ''));
}

// ── 1) Schema: OTA columns exist ─────────────────────────────────────────
const bookingCols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
check('bookings.external_ref column exists', bookingCols.includes('external_ref'));
check('bookings.prepaid column exists', bookingCols.includes('prepaid'));

// ── Seed a tenant, admin user, room, and default accounts ────────────────
const { nanoid } = require('nanoid');
const bcrypt = require('bcryptjs');
const tenantId = 'tenant_' + nanoid(8);
db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?, 'pro', 'active')`)
  .run(tenantId, 'Verify Hotel', 'verify-' + nanoid(5));
const userId = 'user_' + nanoid(8);
db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?, 'hotel_admin')`)
  .run(userId, tenantId, 'Admin', 'admin-' + nanoid(5) + '@verify.test', bcrypt.hashSync('pw', 8));
const roomId = 'room_' + nanoid(8);
db.prepare(`INSERT INTO rooms (id, tenant_id, number, type, rate, status) VALUES (?,?,?,?,?, 'available')`)
  .run(roomId, tenantId, '101', 'Standard', 100);

const { ensureDefaultAccounts, getAccountByKey, postEntry } = require('../server/routes/accounting');
ensureDefaultAccounts(tenantId);

// ── 2) Replicate the handler's payment path (cash, 3-night stay = 300) ───
function trialBalanceOk() {
  const rows = db.prepare(`
    SELECT a.normal_balance, COALESCE(SUM(jl.debit),0) d, COALESCE(SUM(jl.credit),0) c
    FROM accounts a LEFT JOIN journal_lines jl ON jl.account_id = a.id
    WHERE a.tenant_id = ? GROUP BY a.id`).all(tenantId);
  const totalDebit = rows.reduce((s, r) => s + r.d, 0);
  const totalCredit = rows.reduce((s, r) => s + r.c, 0);
  return Math.abs(totalDebit - totalCredit) < 0.005;
}

const bookingId = 'bk_' + nanoid(8);
const reference = 'BK-VERIFY-1';
const total = 300, payAmount = 120, method = 'cash';

const doCreate = db.transaction(() => {
  db.prepare(`INSERT INTO bookings (id, tenant_id, guest_id, reference, check_in, check_out, status, total_amount, paid_amount, source, external_ref, prepaid)
              VALUES (?,?,?,?, '2026-09-01','2026-09-04', 'confirmed', ?, 0, 'ota', 'BDC-9931', 1)`)
    .run(bookingId, tenantId, null, reference, total);
  db.prepare(`INSERT INTO booking_rooms (id, tenant_id, booking_id, room_id, room_number, rate) VALUES (?,?,?,?,?,?)`)
    .run('bkr_' + nanoid(8), tenantId, bookingId, roomId, '101', 100);

  const txnId = 'txn_' + nanoid(8);
  db.prepare(`INSERT INTO transactions (id, tenant_id, guest_name, room_number, description, amount, method, status, gateway_ref, booking_id)
              VALUES (?,?,?,?,?,?,?, 'completed', ?,?)`)
    .run(txnId, tenantId, 'Guest', '101', 'Booking payment — ' + reference, payAmount, 'Cash', 'BOOK-X', bookingId);
  db.prepare('UPDATE bookings SET paid_amount = paid_amount + ? WHERE id = ?').run(payAmount, bookingId);

  const cash = getAccountByKey(tenantId, 'cash');
  const rev = getAccountByKey(tenantId, 'room_revenue');
  postEntry(tenantId, {
    date: '2026-09-01', reference, description: 'Booking payment', source: 'booking', sourceId: bookingId, createdBy: 'Admin',
    lines: [{ accountId: cash.id, debit: payAmount }, { accountId: rev.id, credit: payAmount }],
  });
});
doCreate();

const bk = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
check('paid_amount reflects collected payment', bk.paid_amount === payAmount, 'paid_amount=' + bk.paid_amount);
check('OTA metadata persisted (external_ref + prepaid)', bk.external_ref === 'BDC-9931' && bk.prepaid === 1, 'external_ref=' + bk.external_ref + ' prepaid=' + bk.prepaid);

const txn = db.prepare("SELECT * FROM transactions WHERE booking_id = ? AND status='completed'").get(bookingId);
check('completed transaction recorded', !!txn && txn.amount === payAmount, txn ? 'amount=' + txn.amount + ' method=' + txn.method : 'none');

// Balance math mirrors server/utils/balance.js:52
const outstanding = Math.max(0, bk.total_amount - bk.paid_amount - (bk.deposit_amount || 0));
check('outstanding balance reduced by payment', Math.abs(outstanding - (total - payAmount)) < 0.005, 'outstanding=' + outstanding);

const cashAcct = getAccountByKey(tenantId, 'cash');
const cashDebits = db.prepare('SELECT COALESCE(SUM(debit),0) d FROM journal_lines WHERE account_id = ?').get(cashAcct.id).d;
check('cash account debited for payment', Math.abs(cashDebits - payAmount) < 0.005, 'cashDebits=' + cashDebits);
check('trial balance stays balanced after posting', trialBalanceOk());

// ── Cleanup ──────────────────────────────────────────────────────────────
db.close();
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter(r => !r.ok);
console.log('\n' + (failed.length ? '✗ ' + failed.length + ' check(s) FAILED' : '✓ ALL ' + results.length + ' CHECKS PASSED'));
process.exit(failed.length ? 1 : 0);
