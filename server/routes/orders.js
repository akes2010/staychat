// server/routes/orders.js
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { broadcast } = require('../ws');
const { postEntry, getAccountByKey, ensureDefaultAccounts } = require('./accounting');

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
      const txnId = 'txn_' + nanoid(10);
      const itemsSummary = JSON.parse(order.items || '[]').map(i => i.qty + '× ' + i.name).join(', ');
      db.prepare(`INSERT INTO transactions (id, tenant_id, guest_name, room_number, description, amount, method, status, gateway_ref)
                  VALUES (?,?,?,?,?,?, 'Room Charge', 'pending', ?)`)
        .run(txnId, req.tenantId, order.guest_name || 'Guest', order.room_number,
             'Room Service — ' + (itemsSummary || 'order'), order.total, 'RS-' + order.id.slice(6).toUpperCase());
      db.prepare('UPDATE orders SET paid = 1 WHERE id = ?').run(order.id); // 'paid' = posted to folio
      txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId);

      try {
        ensureDefaultAccounts(req.tenantId);
        const ar = getAccountByKey(req.tenantId, 'ar_room');
        const revenue = getAccountByKey(req.tenantId, 'restaurant_revenue');
        if (ar && revenue) {
          postEntry(req.tenantId, {
            date: new Date().toISOString().slice(0, 10), reference: 'RS-' + order.id.slice(6).toUpperCase(),
            description: 'Room service — Room ' + order.room_number, source: 'order', sourceId: order.id, createdBy: req.user.name,
            lines: [{ accountId: ar.id, debit: order.total, memo: 'Room Charge' }, { accountId: revenue.id, credit: order.total, memo: itemsSummary }],
          });
        }
      } catch (e) { /* accounting postings must never block an order from being delivered */ }
    }
  })();

  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  audit(req, 'order.status_change', 'order', order.id, { status, posted: txn ? txn.amount : undefined });
  broadcast(req.tenantId, 'order.updated', serialize(updated));
  if (txn) broadcast(req.tenantId, 'payment.created', txn);
  res.json({ ...serialize(updated), transaction: txn });
});

module.exports = router;
