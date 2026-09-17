// server/routes/payments.js
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { postEntry, getAccountByKey, ensureDefaultAccounts } = require('./accounting');
const { resolveOutstanding } = require('../utils/balance');

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
router.post('/settle', requirePermission('payments.manage'), (req, res) => {
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
    // rather than being marked paid (and journalled) a second time.
    pending.forEach(t => {
      const r = db.prepare(`UPDATE transactions SET status = 'completed', method = ? WHERE id = ? AND status = 'pending'`)
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

  res.json({ pendingTotal: resolved.pendingTotal, pendingCount: pending.length, transactions: pending, context });
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
