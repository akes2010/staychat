// server/routes/payments.js
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { postEntry, getAccountByKey, ensureDefaultAccounts } = require('./accounting');
const { resolveOutstanding } = require('../utils/balance');
const { broadcast } = require('../ws');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('payments.use'));

router.get('/transactions', (req, res) => {
  const rows = db.prepare('SELECT * FROM transactions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200').all(req.tenantId);
  res.json(rows);
});

// GET /api/payments/transactions/:id — full detail for the View action
router.get('/transactions/:id', (req, res) => {
  const txn = db.prepare('SELECT * FROM transactions WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const booking = txn.booking_id ? db.prepare('SELECT * FROM bookings WHERE id = ?').get(txn.booking_id) : null;
  const guest = txn.guest_id ? db.prepare('SELECT * FROM guests WHERE id = ?').get(txn.guest_id) : null;
  res.json({ ...txn, booking, guest });
});

// POST /api/payments/settle — settle a guest/room/booking's FULL outstanding
// balance in one verified action: the booking's own unpaid room total, plus
// every pending incidental charge (POS, pool, hall, other services) tied to
// the same room/guest/booking. This is what actually clears the way for
// check-out — nothing here is a status label flip without money moving.
// payments.use, not payments.manage: collecting what a guest already owes is
// day-to-day desk work (the .use side of the fraud split). Refunds, voids and
// payment-status edits — changing what is OWED — remain payments.manage.
router.post('/settle', requirePermission('payments.use'), idempotency, (req, res) => {
  const { roomNumber, guestId, bookingId, method, cashReceived, note } = req.body;
  if (!roomNumber && !guestId && !bookingId) return res.status(400).json({ error: 'roomNumber, guestId, or bookingId is required' });
  if (!method) return res.status(400).json({ error: 'A payment method is required to settle a balance' });

  // Resolve the full outstanding picture the SAME way checkout-check does —
  // room balance PLUS every pending charge linked by room_number, guest_id,
  // OR booking_id (not just whichever one field happens to be available).
  // A group booking spans several rooms, so when settling by bookingId, pull
  // every room on that booking too — a charge posted against any one of
  // them (e.g. a hall/pool fee tagged to a specific room_number) still
  // belongs to this bill.
  let roomNumbers;
  if (bookingId) roomNumbers = db.prepare('SELECT room_number FROM booking_rooms WHERE booking_id = ?').all(bookingId).map(r => r.room_number);
  const resolved = resolveOutstanding(req.tenantId, { roomNumber, guestId, bookingId, roomNumbers });
  const booking = resolved.booking;
  const roomBalance = resolved.roomBalance;
  const pending = resolved.transactions;
  const pendingTotal = resolved.pendingTotal;
  const grandTotal = resolved.grandTotal;

  if (grandTotal <= 0.005) return res.status(400).json({ error: 'There is no outstanding balance to settle' });
  if (method === 'cash' && (cashReceived === undefined || Number(cashReceived) < grandTotal)) {
    return res.status(400).json({ error: 'Cash received must cover the full balance of ' + grandTotal.toFixed(2) });
  }

  ensureDefaultAccounts(req.tenantId);
  const debitAccount = getAccountByKey(req.tenantId, method === 'cash' ? 'cash' : 'bank');
  const settledTransactionIds = [];

  let settledRoomBalance = 0;
  const doSettle = db.transaction(() => {
    // 1) Settle the room balance, if any, as one new completed transaction + bump paid_amount.
    //
    // The UPDATE re-asserts the paid_amount we based `roomBalance` on. If a
    // concurrent settlement (a double-clicked "Settle", or a second cashier on
    // another instance) already collected it, `changes` is 0 and we skip — without
    // this the guest was charged the room balance twice and paid_amount overshot
    // total_amount, leaving a negative balance that nothing could reconcile.
    if (roomBalance > 0 && booking) {
      const bumped = db.prepare('UPDATE bookings SET paid_amount = paid_amount + ? WHERE id = ? AND paid_amount = ?')
        .run(roomBalance, booking.id, booking.paid_amount);
      if (bumped.changes === 0) {
        throw Object.assign(new Error('This balance was just settled by someone else — reload to see the current balance'), { status: 409 });
      }
      settledRoomBalance = roomBalance;

      const roomTxnId = 'txn_' + nanoid(10);
      db.prepare(`INSERT INTO transactions (id, tenant_id, guest_name, room_number, description, amount, method, status, gateway_ref, booking_id, guest_id)
                  VALUES (?,?,?,?,?,?,?, 'completed', ?, ?, ?)`)
        .run(roomTxnId, req.tenantId, booking.guest_name, roomNumber || resolved.roomNumber || null, 'Room balance settlement — ' + booking.reference,
             roomBalance, method, 'SETTLE-' + roomTxnId.slice(4).toUpperCase(), booking.id, booking.guest_id);
      settledTransactionIds.push(roomTxnId);

      const roomRevenue = getAccountByKey(req.tenantId, 'room_revenue');
      if (debitAccount && roomRevenue) {
        postEntry(req.tenantId, {
          date: new Date().toISOString().slice(0, 10), reference: booking.reference, description: 'Room balance settled — ' + booking.guest_name,
          source: 'payment', sourceId: roomTxnId, createdBy: req.user.name,
          lines: [{ accountId: debitAccount.id, debit: roomBalance }, { accountId: roomRevenue.id, credit: roomBalance }],
        });
      }
    }

    // 2) Settle every pending incidental transaction. The `status = 'pending'`
    // guard means a charge already collected by a concurrent settlement is skipped
    // rather than being marked paid (and journalled) a second time. Charges get
    // a stable idempotency stamp 'settle:<txnId>' — a retried settle request
    // re-asserts the SAME stamp on each, so the UNIQUE index guarantees one
    // settlement per charge no matter how many times the request replays.
    pending.forEach(t => {
      const r = db.prepare(`UPDATE transactions SET status = 'completed', method = ?, idempotency_key = 'settle:' || id WHERE id = ? AND status = 'pending'`)
        .run(method === 'cash' ? 'Cash' : method === 'card' ? 'Card' : t.method, t.id);
      if (r.changes === 0) return; // someone else settled this charge first
      settledTransactionIds.push(t.id);
      try {
        const arKey = t.method === 'Room Charge' ? 'ar_room' : t.method === 'Group Account' ? 'ar_group' : 'ar_customer';
        const ar = getAccountByKey(req.tenantId, arKey);
        if (debitAccount && ar) {
          postEntry(req.tenantId, {
            date: new Date().toISOString().slice(0, 10), reference: t.gateway_ref, description: 'Settled: ' + (t.description || ''),
            source: 'payment', sourceId: t.id, createdBy: req.user.name,
            lines: [{ accountId: debitAccount.id, debit: t.amount }, { accountId: ar.id, credit: t.amount }],
          });
        }
      } catch (e) { /* non-fatal */ }
    });
  });
  try { doSettle(); }
  catch (e) {
    if (e.status === 409) return res.status(409).json({ error: e.message });
    throw e;
  }

  // Report what was ACTUALLY collected, not what we intended to collect — a
  // concurrent settlement may have taken some of it first.
  const collectedIncidentals = pending
    .filter(t => settledTransactionIds.includes(t.id))
    .reduce((s, t) => s + t.amount, 0);
  const collected = Math.round((settledRoomBalance + collectedIncidentals) * 100) / 100;

  audit(req, 'payment.settle', 'booking_or_guest', booking ? booking.id : (guestId || roomNumber), { method, collected, grandTotal, roomBalance, pendingTotal, note: note || null });
  res.json({
    roomBalance: settledRoomBalance, pendingTotal: collectedIncidentals, grandTotal: collected,
    change: method === 'cash' ? Math.max(0, Number(cashReceived) - collected) : 0,
    settledTransactionIds,
  });
});

// POST /api/payments/refund — issue a refund against a COMPLETED transaction.
// Refunding changes what the hotel owes the guest — that is the .manage side of
// the payments split, never day-to-day desk work. The reversal is written as a
// real 'refunded' transaction (money OUT, reference RFD-…) that every report
// already excludes from revenue, and the original transaction is marked
// 'refunded'. Optionally re-opens a checked-out booking so the desk can re-run
// folio totals. Gateway skips are honest — without real gateway credentials the
// cash/card drawer is the refund, exactly like the rest of this deployment.
router.post('/refund', requirePermission('payments.manage'), (req, res) => {
  const { transactionId, amount, reason, reopenBooking } = req.body || {};
  if (!transactionId) return res.status(400).json({ error: 'transactionId is required' });
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'A written reason is required to issue a refund' });

  const txn = db.prepare('SELECT * FROM transactions WHERE id = ? AND tenant_id = ?').get(transactionId, req.tenantId);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  if (txn.status !== 'completed') return res.status(409).json({ error: 'Only a completed payment can be refunded (this one is ' + txn.status + ')' });

  let refundAmount = txn.amount;
  if (amount !== undefined && amount !== null) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0 || Math.round(n * 100) / 100 > txn.amount) {
      return res.status(400).json({ error: 'Refund amount must be a positive number not exceeding ' + txn.amount.toFixed(2) });
    }
    refundAmount = Math.round(n * 100) / 100;
  }

  ensureDefaultAccounts(req.tenantId);
  const sourceAccount = getAccountByKey(req.tenantId, txn.method === 'Cash' ? 'cash' : 'bank');

  let roomBalanceAfter = null;
  let reopened = false;
  // The status guard re-asserts 'completed' so two concurrent refund clicks
  // cannot double-refund the same payment — the second settled UPDATE changes
  // 0 rows and the whole transaction aborts.
  const tx = db.transaction(() => {
    const claimed = db.prepare("UPDATE transactions SET status = 'refunded' WHERE id = ? AND status = 'completed'").run(txn.id);
    if (claimed.changes === 0) throw Object.assign(new Error('This payment was just refunded by someone else'), { status: 409 });

    const refundId = 'txn_' + nanoid(10);
    db.prepare(`INSERT INTO transactions (id, tenant_id, guest_name, room_number, description, amount, method, status, gateway_ref, booking_id, guest_id)
                VALUES (?,?,?,?,?,?,?, 'refunded', ?, ?, ?)`)
      .run(refundId, req.tenantId, txn.guest_name, txn.room_number,
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
          postEntry(req.tenantId, {
            date: new Date().toISOString().slice(0, 10), reference: 'RFD-' + refundId.slice(4).toUpperCase(),
            description: 'Refund — ' + String(reason).trim(), source: 'payment', sourceId: refundId, createdBy: req.user.name,
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
      const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(txn.booking_id, req.tenantId);
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
    if (e.status === 409) return res.status(409).json({ error: e.message });
    throw e;
  }

  // Post-refund room balance (what the guest still owes / is owed) for the UI.
  if (txn.booking_id) {
    const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(txn.booking_id);
    if (b) roomBalanceAfter = Math.round((b.total_amount - b.paid_amount) * 100) / 100;
  }

  audit(req, 'payment.refund', 'transaction', txn.id, { amount: refundAmount, reason: String(reason).trim(), reopened });
  try { broadcast(req.tenantId, 'payment.refunded', { id: txn.id, amount: refundAmount }); } catch (e) { /* ws optional */ }
  res.json({
    refunded: refundAmount,
    transactionId: txn.id,
    reopened,
    roomBalanceAfter,
    note: 'Refund recorded in the ledger. Money leaves via your ' + (txn.method === 'Cash' ? 'cash drawer' : 'gateway/bank') + ' — no gateway credentials are touched here.',
  });
});

// GET /api/payments/balance?roomNumber=&guestId=&bookingId=
// Looks up how much is already outstanding (pending/unpaid) for a room, a
// guest account, or a group booking — so a cashier can see a customer's
// running balance before posting a new charge to it.
router.get('/balance', (req, res) => {
  const { roomNumber, guestId, bookingId } = req.query;
  if (!roomNumber && !guestId && !bookingId) return res.status(400).json({ error: 'roomNumber, guestId, or bookingId is required' });

  let roomNumbers;
  if (bookingId) roomNumbers = db.prepare('SELECT room_number FROM booking_rooms WHERE booking_id = ?').all(bookingId).map(r => r.room_number);
  const resolved = resolveOutstanding(req.tenantId, { roomNumber, guestId, bookingId, roomNumbers });
  const pending = resolved.transactions.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  let context = null;
  if (bookingId) {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(bookingId, req.tenantId);
    if (booking) context = { label: booking.group_name || booking.guest_name, reference: booking.reference };
  } else if (guestId) {
    const guest = db.prepare('SELECT * FROM guests WHERE id = ? AND tenant_id = ?').get(guestId, req.tenantId);
    if (guest) context = { label: guest.name, reference: guest.room_number };
  } else if (roomNumber) {
    const room = db.prepare('SELECT * FROM rooms WHERE tenant_id = ? AND number = ?').get(req.tenantId, roomNumber);
    if (room) context = { label: room.guest_name || 'Room ' + roomNumber, reference: roomNumber };
  }

  // roomBalance + grandTotal are included so every consumer (settle modal,
  // tests) sees the SAME numbers /settle will act on — the booking's own
  // unpaid total PLUS pending incidentals — with no second lookup needed.
  res.json({ pendingTotal: resolved.pendingTotal, pendingCount: pending.length, transactions: pending, context, roomBalance: resolved.roomBalance, grandTotal: resolved.grandTotal });
});

// Generate a payment link (in production this calls the Paystack/Stripe API
// to create a real checkout session; here we create a pending transaction
// record and a deep link the guest can be sent via WhatsApp).
router.post('/link', (req, res) => {
  const { guestName, roomNumber, amount, description, method } = req.body;
  const numAmount = Number(amount);
  if (!guestName || !amount || !Number.isFinite(numAmount) || numAmount <= 0) {
    return res.status(400).json({ error: 'guestName and a valid positive amount are required' });
  }

  const id = 'txn_' + nanoid(10);
  const ref = (method || 'Paystack').slice(0,2).toUpperCase() + '-' + nanoid(8).toUpperCase();
  db.prepare(`INSERT INTO transactions (id, tenant_id, guest_name, room_number, description, amount, method, status, gateway_ref)
              VALUES (?,?,?,?,?,?,?, 'pending', ?)`)
    .run(id, req.tenantId, guestName, roomNumber || null, description || 'Payment', numAmount, method || 'Paystack', ref);

  const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  const payLink = `${req.protocol}://${req.get('host')}/pay/${ref}`;
  audit(req, 'payment.link_created', 'transaction', id, { amount });
  res.status(201).json({ ...txn, payLink });
});

router.patch('/transactions/:id', requirePermission('payments.manage'), (req, res) => {
  const txn = db.prepare('SELECT * FROM transactions WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!txn) return res.status(404).json({ error: 'Transaction not found' });
  const { status } = req.body;
  if (!['pending','completed','failed','refunded'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE transactions SET status = ? WHERE id = ?').run(status, txn.id);
  const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txn.id);

  // Settling a previously-pending receivable (room charge / customer bill / group
  // account) moves the balance from Accounts Receivable into Cash. A refund
  // reverses the original revenue recognition.
  try {
    if (txn.status === 'pending' && status === 'completed') {
      ensureDefaultAccounts(req.tenantId);
      const cash = getAccountByKey(req.tenantId, 'cash');
      const arKey = txn.method === 'Room Charge' ? 'ar_room' : txn.method === 'Group Account' ? 'ar_group' : 'ar_customer';
      const ar = getAccountByKey(req.tenantId, arKey);
      if (cash && ar) {
        postEntry(req.tenantId, {
          date: new Date().toISOString().slice(0, 10), reference: txn.gateway_ref, description: 'Settled: ' + (txn.description || ''),
          source: 'payment', sourceId: txn.id, createdBy: req.user.name,
          lines: [{ accountId: cash.id, debit: txn.amount, memo: 'Settlement' }, { accountId: ar.id, credit: txn.amount, memo: 'Settlement' }],
        });
      }
    }
  } catch (e) { /* accounting postings must never block a status update */ }

  audit(req, 'payment.status_change', 'transaction', txn.id, { status });
  res.json(updated);
});

module.exports = router;
