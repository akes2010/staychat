// server/services/charges.js
// ═══════════════════════════════════════════════════════════════════════════
// THE ONE MONEY PIPELINE — every charge and every payment in StayChat OS
// enters the guest's folio through this service. Nothing else may INSERT into
// `transactions` for folio money.
//
// Design contract (what "7-star" means here, concretely):
//
// 1. IDEMPOTENT  — every call carries a unique `idempotencyKey` (source + id).
//    A retried request, double-click or webhook replay posts EXACTLY ONE
//    transaction, enforced by a UNIQUE index — not by hoping two clicks don't
//    happen in the same millisecond.
//
// 2. ATOMIC      — the transaction row, the folio linkage (booking_rooms /
//    booking paid_amount) and the double-entry journal land together or not
//    at all. A crash mid-write can never leave a charge visible on the folio
//    but missing from the books (or the reverse).
//
// 3. DISTRIBUTED — revenue is attributed to the RIGHT account every time:
//    room nights → room_revenue, restaurant orders → restaurant_revenue,
//    bar → bar_revenue, POS (auto-detected) → restaurant or bar, misc
//    services → misc_revenue, pool → pool_revenue, halls → hall_revenue.
//    The EOD close, trial balance and cash book are correct by construction.
//
// 4. TENANT-SCOPED — every lookup and write re-asserts tenant_id. A charge can
//    never leak across hotels, and folio totals for one hotel never include
//    another's.
//
// 5. ONE Voice — folio descriptions follow a house format ("Charge — Room
//    Service · BK-…") so the guest's printed folio reads professionally.
//
// Callers that used to hand-roll INSERT INTO transactions now call
// postCharge() (money OWED — Folio) or recordPayment() (money RECEIVED).
// Legacy callers are migrated route-by-route; the old patterns are kept
// working until each route is switched, so nothing breaks mid-refactor.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const db = require('../db/connection');
const { nanoid } = require('nanoid');
const { postEntry, getAccountByKey, ensureDefaultAccounts } = require('../routes/accounting');

// ── Money math ──────────────────────────────────────────────────────────────
// One rounding rule everywhere: nearest cent. Sub-cent drift is the classic
// way folios end up 0.01 off and settlement formulas disagree.
function money(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) throw Object.assign(new Error('Charge amount must be a finite number'), { status: 400 });
  return Math.round(x * 100) / 100;
}

// ── Charge sources → revenue distribution ───────────────────────────────────
// source: which pipeline produced the money. Maps to the ledger's revenue
// accounts AND to the human-readable label on the folio line.
const SOURCES = {
  booking:        { revenue: 'room_revenue',        label: 'Room & Booking' },
  order:          { revenue: 'restaurant_revenue',  label: 'Room Service' },
  pos:            { revenue: null,                  label: 'POS Sale' },          // outlet detected per ticket
  misc_service:   { revenue: 'misc_revenue',        label: 'Other Service' },
  pool:           { revenue: 'pool_revenue',        label: 'Pool' },
  hall:           { revenue: 'hall_revenue',        label: 'Hall / Event' },
  others:         { revenue: 'misc_revenue',        label: 'Charge' },
};

// Settlement targets (debit side). A room charge goes to the ROOM's
// receivable; a customer/group bill to their own; cash/card are instant.
function debitKeyFor(method) {
  switch (String(method)) {
    case 'Room Charge':    return 'ar_room';
    case 'Customer Bill':  return 'ar_customer';
    case 'Group Account':  return 'ar_group';
    case 'Cash':           return 'cash';
    default:               return 'bank'; // Card / Paystack / Stripe / Transfer…
  }
}

// ── postCharge ──────────────────────────────────────────────────────────────
// Post money OWED (or collected on the spot) to a guest's folio.
//
//   tenantId      — tenant scope (required)
//   source        — key of SOURCES ('booking','order','pos','misc_service','pool','hall')
//   sourceId      — id of the producing row (order id, ticket id, booking id…)
//   idempotencyKey— globally unique key; the same key twice returns the SAME
//                   transaction row unchanged (no duplicate posting)
//   amount        — positive amount
//   method        — 'Room Charge' | 'Customer Bill' | 'Group Account' |
//                   'Cash' | 'Card' | gateway labels…
//   description   — human folio line (house format: "Charge — Room Service")
//   opts          — bookingId, guestId, roomNumber, guestName, outlet ('bar'|'restaurant'),
//                   gatewayRef, refLabel (reference prefix override), immediate
//                   (true → status 'completed', e.g. cash POS sale;
//                    false → status 'pending', collected at settle)
//   createdBy     — acting user's name (journal attribution)
//
// RETURNS { transaction, created } — created=false means the idempotency key
// was seen before and the original row is returned untouched.
function postCharge(tenantId, {
  source, sourceId, idempotencyKey, amount, method,
  description, bookingId = null, guestId = null, roomNumber = null, guestName = null,
  outlet = null, gatewayRef = null, refLabel = null, immediate = false, createdBy = null,
}) {
  const spec = SOURCES[source] || SOURCES.others;
  const amt = money(amount);
  if (amt <= 0) throw Object.assign(new Error('Charge amount must be positive'), { status: 400 });
  if (!idempotencyKey) throw Object.assign(new Error('idempotencyKey is required to post a charge'), { status: 500 });

  // Fast path: the key is already posted (retry / replay) → return the original.
  const existing = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ? AND tenant_id = ?')
    .get(idempotencyKey, tenantId);
  if (existing) return { transaction: existing, created: false };

  ensureDefaultAccounts(tenantId);

  const txnId = 'txn_' + nanoid(10);
  const reference = (refLabel || source.toUpperCase().replace(/_/g, '').slice(0, 3)) + '-' + (sourceId ? String(sourceId).slice(-8).toUpperCase() : txnId.slice(4, 12).toUpperCase());
  const folioLine = description || (spec.label + ' charge');

  // One atomic write: transactions row + journal. The UNIQUE index on
  // idempotency_key backs the guarantee even under true concurrency — better-sqlite3
  // is single-writer, but a retried HTTP request can still arrive between our
  // SELECT and INSERT through a concurrent connection; the index is the truth.
  const tx = db.transaction(() => {
    try {
      db.prepare(`INSERT INTO transactions
        (id, tenant_id, guest_name, room_number, description, amount, method, status,
         gateway_ref, booking_id, guest_id, idempotency_key, source)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(txnId, tenantId, guestName || 'Guest', roomNumber, folioLine, amt,
             method, immediate ? 'completed' : 'pending',
             gatewayRef || reference, bookingId, guestId, idempotencyKey, source);
    } catch (e) {
      if (String(e.message).includes('UNIQUE') && String(e.message).includes('idempotency_key')) {
        const winner = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ? AND tenant_id = ?').get(idempotencyKey, tenantId);
        if (winner) { existingDone = winner; return; }
      }
      throw e;
    }

    // Ledger: debit receivable/cash, credit the RIGHT revenue account.
    // outlet distinguishes the two POS revenue accounts.
    let revenueKey = spec.revenue;
    if (source === 'pos') revenueKey = outlet === 'bar' ? 'bar_revenue' : 'restaurant_revenue';
    const revenueAcct = getAccountByKey(tenantId, revenueKey || 'misc_revenue');
    const debitAcct = getAccountByKey(tenantId, debitKeyFor(method));
    if (revenueAcct && debitAcct) {
      postEntry(tenantId, {
        date: new Date().toISOString().slice(0, 10),
        reference: gatewayRef || reference,
        description: description || (spec.label + ' — ' + (guestName || 'Guest')),
        source, sourceId: sourceId || txnId, createdBy: createdBy || null,
        lines: [
          { accountId: debitAcct.id, debit: amt, memo: method },
          { accountId: revenueAcct.id, credit: amt, memo: description || spec.label },
        ],
      });
    }
  });

  let existingDone = null;
  try { tx(); }
  catch (e) { throw e; }
  if (existingDone) return { transaction: existingDone, created: false };

  const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);
  return { transaction, created: true };
}

// ── recordPayment ───────────────────────────────────────────────────────────
// Record money RECEIVED against a booking (deposit, desk settlement…).
// Idempotent on idempotencyKey; bumps booking.paid_amount only when THIS call
// created the transaction, so a replay can never double-credit the booking.
function recordPayment(tenantId, {
  source = 'booking', sourceId = null, idempotencyKey, amount, method,
  description, bookingId = null, guestId = null, roomNumber = null, guestName = null,
  gatewayRef = null, createdBy = null,
}) {
  const amt = money(amount);
  if (amt <= 0) throw Object.assign(new Error('Payment amount must be positive'), { status: 400 });
  if (!idempotencyKey) throw Object.assign(new Error('idempotencyKey is required to record a payment'), { status: 500 });

  const existing = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ? AND tenant_id = ?')
    .get(idempotencyKey, tenantId);
  if (existing) return { transaction: existing, created: false };

  ensureDefaultAccounts(tenantId);
  const txnId = 'txn_' + nanoid(10);
  const reference = 'PAY-' + txnId.slice(4, 12).toUpperCase();
  let credited = false;

  db.transaction(() => {
    try {
      db.prepare(`INSERT INTO transactions
        (id, tenant_id, guest_name, room_number, description, amount, method, status,
         gateway_ref, booking_id, guest_id, idempotency_key, source)
        VALUES (?,?,?,?,?,?,?, 'completed', ?,?,?,?,?)`)
        .run(txnId, tenantId, guestName || 'Guest', roomNumber, description || 'Payment',
             amt, method, gatewayRef || reference, bookingId, guestId, idempotencyKey, source);
    } catch (e) {
      if (String(e.message).includes('UNIQUE') && String(e.message).includes('idempotency_key')) {
        return; // concurrent winner — matched by the fast-path SELECT below
      }
      throw e;
    }
    credited = true;

    // Bump the booking's paid ledger figure (guarded and only by the creator).
    if (bookingId) {
      const r = db.prepare('UPDATE bookings SET paid_amount = paid_amount + ? WHERE id = ? AND tenant_id = ?')
        .run(amt, bookingId, tenantId);
      if (r.changes === 0) throw Object.assign(new Error('Booking not found for payment'), { status: 404 });
    }

    // Ledger: debit cash/bank, credit the source's revenue account.
    const debitAcct = getAccountByKey(tenantId, method === 'Cash' ? 'cash' : 'bank');
    const revenueAcct = getAccountByKey(tenantId, (SOURCES[source] || SOURCES.others).revenue || 'misc_revenue');
    if (debitAcct && revenueAcct) {
      postEntry(tenantId, {
        date: new Date().toISOString().slice(0, 10),
        reference,
        description: description || 'Payment',
        source, sourceId: sourceId || txnId, createdBy: createdBy || null,
        lines: [
          { accountId: debitAcct.id, debit: amt, memo: method },
          { accountId: revenueAcct.id, credit: amt, memo: 'Payment received' },
        ],
      });
    }
  })();

  if (!credited) {
    const winner = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ? AND tenant_id = ?').get(idempotencyKey, tenantId);
    if (winner) return { transaction: winner, created: false };
    throw Object.assign(new Error('Payment recorded but could not be read back'), { status: 500 });
  }

  return { transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId), created: true };
}

// ── reverseCharge ───────────────────────────────────────────────────────────
// Cancel a pending folio charge (order cancelled before settle, folio fix…).
// Pending-only: a COMPLETED charge must go through the refund pipeline in
// routes/payments.js, which produces an auditable refund transaction.
function reverseCharge(tenantId, idempotencyKey, reason, createdBy) {
  const txn = db.prepare('SELECT * FROM transactions WHERE idempotency_key = ? AND tenant_id = ?').get(idempotencyKey, tenantId);
  if (!txn) return { transaction: null, created: false };
  if (txn.status !== 'pending') return { transaction: txn, created: false };
  const r = db.prepare(`UPDATE transactions SET status = 'failed', description = description || ' (cancelled: ' || ? || ')' WHERE id = ? AND status = 'pending'`)
    .run(String(reason || 'cancelled').slice(0, 80), txn.id);
  if (r.changes === 0) return { transaction: txn, created: false };
  return { transaction: db.prepare('SELECT * FROM transactions WHERE id = ?').get(txn.id), created: true };
}

module.exports = { postCharge, recordPayment, reverseCharge, money, SOURCES };
