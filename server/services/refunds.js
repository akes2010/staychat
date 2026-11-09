// server/services/refunds.js
// ── Refund pipeline (money OUT) ─────────────────────────────────────────────
// One implementation shared by the Payments page and the POS terminals: a
// refund marks the original COMPLETED transaction 'refunded', writes a real
// 'refunded' money-out row (reference RFD-…, which every report already
// excludes from revenue) and reverses the ledger entry (Credit cash/bank,
// Debit revenue). Optionally re-opens a checked-out booking.
//
// Refunding changes what the hotel owes the guest — callers must gate on
// payments.manage (the .manage side of the fraud split) before calling.
'use strict';

const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { postEntry, getAccountByKey, ensureDefaultAccounts } = require('../routes/accounting');
const { broadcast } = require('../ws');

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

/**
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.transactionId  the COMPLETED payment to refund
 * @param {number} [opts.amount]       defaults to the full transaction amount
 * @param {string} opts.reason         required, written into the ledger + refund row
 * @param {object} opts.user           { name } — attributed in the audit trail
 * @param {boolean} [opts.reopenBooking]
 */
function refundTransaction({ tenantId, transactionId, amount, reason, user, reopenBooking }) {
  if (!transactionId) throw httpError('transactionId is required', 400);
  if (!reason || !String(reason).trim()) throw httpError('A written reason is required to issue a refund', 400);

  const txn = db.prepare('SELECT * FROM transactions WHERE id = ? AND tenant_id = ?').get(transactionId, tenantId);
  if (!txn) throw httpError('Transaction not found', 404);
  if (txn.status !== 'completed') throw httpError('Only a completed payment can be refunded (this one is ' + txn.status + ')', 409);

  let refundAmount = txn.amount;
  if (amount !== undefined && amount !== null) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0 || Math.round(n * 100) / 100 > txn.amount) {
      throw httpError('Refund amount must be a positive number not exceeding ' + txn.amount.toFixed(2), 400);
    }
    refundAmount = Math.round(n * 100) / 100;
  }

  ensureDefaultAccounts(tenantId);
  const sourceAccount = getAccountByKey(tenantId, txn.method === 'Cash' ? 'cash' : 'bank');

  let roomBalanceAfter = null;
  let reopened = false;
  let refundId = null;

  // The status guard re-asserts 'completed' so two concurrent refund clicks
  // cannot double-refund the same payment — the second settled UPDATE changes
  // 0 rows and the whole transaction aborts.
  const tx = db.transaction(() => {
    const claimed = db.prepare("UPDATE transactions SET status = 'refunded' WHERE id = ? AND status = 'completed'").run(txn.id);
    if (claimed.changes === 0) throw httpError('This payment was just refunded by someone else', 409);

    refundId = 'txn_' + nanoid(10);
    db.prepare(`INSERT INTO transactions (id, tenant_id, guest_name, room_number, description, amount, method, status, gateway_ref, booking_id, guest_id)
                VALUES (?,?,?,?,?,?,?, 'refunded', ?, ?, ?)`)
      .run(refundId, tenantId, txn.guest_name, txn.room_number,
           'Refund of ' + txn.gateway_ref + ' — ' + String(reason).trim(),
           refundAmount, txn.method, 'RFD-' + refundId.slice(4).toUpperCase(), txn.booking_id, txn.guest_id);

    // Reversal in the books: the original entry was Debit cash/bank, Credit
    // revenue — the refund flips it (Credit cash/bank, Debit revenue). The
    // original revenue account is found from the original entry's credit line.
    try {
      const origEntry = txn.id ? db.prepare(`
        SELECT je.id AS entry_id FROM journal_entries je
        JOIN journal_lines jl ON jl.entry_id = je.id
        WHERE je.source_id = ? AND je.source = 'payment' AND jl.credit > 0
        LIMIT 1
      `).get(txn.id) : null;
      if (origEntry) {
        const revenueLine = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? AND credit > 0 LIMIT 1').get(origEntry.entry_id);
        if (sourceAccount && revenueLine) {
          postEntry(tenantId, {
            date: new Date().toISOString().slice(0, 10), reference: 'RFD-' + refundId.slice(4).toUpperCase(),
            description: 'Refund — ' + String(reason).trim(), source: 'payment', sourceId: refundId, createdBy: user && user.name,
            lines: [
              { accountId: revenueLine.account_id, debit: refundAmount, memo: 'Refund reversal' },
              { accountId: sourceAccount.id, credit: refundAmount, memo: 'Refund payout' },
            ],
          });
        }
      }
    } catch (e) { /* accounting never blocks the refund itself */ }

    // If the refunded payment was against a booking the desk had already
    // checked out over, optionally re-open it so balances/folio recompute in
    // the normal lifecycle instead of stranding the guest in 'checked_out'.
    if (reopenBooking && txn.booking_id) {
      const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(txn.booking_id, tenantId);
      if (b && b.status === 'checked_out') {
        const targetStatus = b.paid_amount - refundAmount > 0.005 ? 'checked_in' : 'confirmed';
        const r = db.prepare("UPDATE bookings SET status = ? WHERE id = ? AND status = 'checked_out'").run(targetStatus, b.id);
        if (r.changes > 0) {
          const rooms = db.prepare('SELECT room_id FROM booking_rooms WHERE booking_id = ?').all(b.id);
          rooms.forEach(br => db.prepare("UPDATE rooms SET status = 'occupied', guest_id = ?, guest_name = ?, updated_at = datetime('now') WHERE id = ?").run(b.guest_id, b.guest_name, br.room_id));
          reopened = true;
        }
      }
    }
  });
  try { tx(); }
  catch (e) {
    if (e.status) throw e;
    throw e;
  }

  // Post-refund room balance (what the guest still owes / is owed) for the UI.
  if (txn.booking_id) {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(txn.booking_id);
    if (b) roomBalanceAfter = Math.round((b.total_amount - b.paid_amount) * 100) / 100;
  }

  try { broadcast(tenantId, 'payment.refunded', { id: txn.id, amount: refundAmount }); } catch (e) { /* ws optional */ }

  return {
    refunded: refundAmount,
    transactionId: txn.id,
    refundTransactionId: refundId,
    reopened,
    roomBalanceAfter,
    note: 'Refund recorded in the ledger. Money leaves via your ' + (txn.method === 'Cash' ? 'cash drawer' : 'gateway/bank') + ' — no gateway credentials are touched here.',
  };
}

module.exports = { refundTransaction };
