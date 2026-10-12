// server/routes/orders.js
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { broadcast } = require('../ws');
const { postCharge } = require('../services/charges');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('orders.manage'));

function serialize(o) {
  return { ...o, items: JSON.parse(o.items || '[]'), paid: !!o.paid };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM orders WHERE tenant_id = ? ORDER BY created_at DESC').all(req.tenantId);
  res.json(rows.map(serialize));
});

router.post('/', (req, res) => {
  const { roomNumber, guestName, items, note } = req.body;
  if (!roomNumber || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'roomNumber and at least one item are required' });
  }
  // Reject malformed / negative line items before they reach the total.
  for (const i of items) {
    const p = Number(i.price), q = Number(i.qty);
    if (!Number.isFinite(p) || p < 0) return res.status(400).json({ error: 'Every item needs a non-negative numeric price' });
    if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ error: 'Every item needs a positive quantity' });
  }
  const total = Math.round(items.reduce((s, i) => s + (Number(i.price) * Number(i.qty)), 0) * 100) / 100;
  const id = 'order_' + nanoid(10);
  db.prepare(`INSERT INTO orders (id, tenant_id, room_number, guest_name, items, total, status, note, paid)
              VALUES (?,?,?,?,?,?, 'pending', ?, 0)`)
    .run(id, req.tenantId, roomNumber, guestName || 'Guest', JSON.stringify(items), total, note || null);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  audit(req, 'order.create', 'order', id, { roomNumber, total });
  broadcast(req.tenantId, 'order.created', serialize(order));
  res.status(201).json(serialize(order));
});

// PATCH /api/orders/:id/status
//
// Delivering a room-service order is the moment the hotel has earned the money.
// Previously nothing happened financially: no transaction was written, so the
// charge never appeared on the guest's folio, never blocked check-out, and never
// reached the ledger — a guest could order 300 of room service and walk out clean.
// Delivery now posts the order to the room folio exactly like a POS room_charge:
// a pending 'Room Charge' transaction, settled at check-out via /api/payments/settle.
router.patch('/:id/status', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { status } = req.body;
  if (!['pending','preparing','delivered','cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  let txn = null;
  db.transaction(() => {
    const r = db.prepare(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ? AND status != ?`).run(status, order.id, status);
    if (r.changes === 0) return; // already in that state — nothing to post

    if (status === 'delivered' && !order.paid && order.total > 0) {
      const itemsSummary = JSON.parse(order.items || '[]').map(i => i.qty + '× ' + i.name).join(', ');
      // Resolve this room's ACTIVE booking so the charge lands on that folio —
      // /api/bookings/:id/folio and settle both key on booking_id, so a charge
      // with only a room_number would be invisible to the booking lifecycle.
      const bn = db.prepare('SELECT id, number FROM rooms WHERE tenant_id = ? AND number = ?').get(req.tenantId, order.room_number);
      const active = bn ? db.prepare(`SELECT b.id, b.guest_id FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id
        WHERE br.room_id = ? AND b.tenant_id = ? AND b.status = 'checked_in'`).get(bn.id, req.tenantId) : null;
      // ONE money pipeline: idempotent (delivery retry posts once), ledger-real
      // (restaurant_revenue), folio-visible (pending Room Charge → settled at
      // checkout via /api/payments/settle).
      const posted = postCharge(req.tenantId, {
        source: 'order', sourceId: order.id, idempotencyKey: 'order:' + order.id,
        amount: order.total, method: 'Room Charge',
        description: 'Room Service — ' + (itemsSummary || 'order'),
        bookingId: active ? active.id : null,
        guestId: active ? active.guest_id : null,
        roomNumber: order.room_number, guestName: order.guest_name || 'Guest',
        gatewayRef: 'RS-' + order.id.slice(6).toUpperCase(), createdBy: req.user.name,
      });
      db.prepare('UPDATE orders SET paid = 1 WHERE id = ?').run(order.id); // 'paid' = posted to folio
      txn = posted.transaction;
    }
  })();

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  audit(req, 'order.status_change', 'order', order.id, { status, posted: txn ? txn.amount : undefined });
  broadcast(req.tenantId, 'order.updated', serialize(updated));
  if (txn) broadcast(req.tenantId, 'payment.created', txn);
  res.json({ ...serialize(updated), transaction: txn });
});

module.exports = router;
