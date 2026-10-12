// server/routes/misc-services.js
// "Other Services" — shoe shine, laundry, car wash/repair, and any other
// ad-hoc paid service a hotel offers outside of Room Service/POS/Pool/Hall.
// Mirrors the POS pattern: a catalog of sellable services + orders against it.
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { broadcast } = require('../ws');
const { postCharge } = require('../services/charges');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('orders.manage'));

// ── Catalog ──────────────────────────────────────────────────────────
router.get('/services', (req, res) => {
  res.json(db.prepare('SELECT * FROM misc_services WHERE tenant_id = ? ORDER BY category, name').all(req.tenantId).map(s => ({ ...s, active: !!s.active })));
});

router.post('/services', (req, res) => {
  const { name, category, price } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = 'msvc_' + nanoid(10);
  db.prepare('INSERT INTO misc_services (id, tenant_id, name, category, price) VALUES (?,?,?,?,?)').run(id, req.tenantId, name, category || 'Other', Number(price) || 0);
  const svc = db.prepare('SELECT * FROM misc_services WHERE id = ?').get(id);
  audit(req, 'miscservice.create', 'misc_service', id, { name });
  res.status(201).json({ ...svc, active: !!svc.active });
});

router.patch('/services/:id', (req, res) => {
  const svc = db.prepare('SELECT * FROM misc_services WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!svc) return res.status(404).json({ error: 'Service not found' });
  const map = { name: 'name', category: 'category', price: 'price', active: 'active' };
  const updates = {};
  Object.entries(map).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = bodyKey === 'active' ? (req.body[bodyKey] ? 1 : 0) : req.body[bodyKey]; });
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE misc_services SET ${setClause} WHERE id = @id`).run({ ...updates, id: svc.id });
  const updated = db.prepare('SELECT * FROM misc_services WHERE id = ?').get(svc.id);
  res.json({ ...updated, active: !!updated.active });
});

router.delete('/services/:id', (req, res) => {
  const svc = db.prepare('SELECT * FROM misc_services WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!svc) return res.status(404).json({ error: 'Service not found' });
  db.prepare('DELETE FROM misc_services WHERE id = ?').run(svc.id);
  res.json({ ok: true });
});

// ── Orders ───────────────────────────────────────────────────────────
router.get('/orders', (req, res) => {
  const { date } = req.query;
  let sql = 'SELECT * FROM misc_service_orders WHERE tenant_id = ?';
  const params = [req.tenantId];
  if (date) { sql += ' AND date(created_at) = ?'; params.push(date); }
  else { sql += " AND (status != 'completed' OR date(created_at) = date('now'))"; }
  sql += ' ORDER BY created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

router.post('/orders', (req, res) => {
  const { serviceId, guestName, roomNumber, qty } = req.body;
  const service = serviceId ? db.prepare('SELECT * FROM misc_services WHERE id = ? AND tenant_id = ?').get(serviceId, req.tenantId) : null;
  const name = service ? service.name : req.body.serviceName;
  const price = service ? service.price : Number(req.body.price) || 0;
  if (!name) return res.status(400).json({ error: 'serviceId or serviceName is required' });
  const quantity = Math.max(1, Number(qty) || 1);
  const id = 'msord_' + nanoid(10);
  db.prepare(`INSERT INTO misc_service_orders (id, tenant_id, service_id, service_name, guest_name, room_number, qty, price, total, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, serviceId || null, name, guestName || null, roomNumber || null, quantity, price, price * quantity, req.user.name);
  const order = db.prepare('SELECT * FROM misc_service_orders WHERE id = ?').get(id);
  audit(req, 'miscorder.create', 'misc_service_order', id, { name });
  broadcast(req.tenantId, 'miscorder.created', order);
  res.status(201).json(order);
});

// POST /api/misc-services/orders/:id/complete — deliver the service and charge for it.
//
// Completing is a money event, so it must happen exactly once. Previously the
// handler read the order, then unconditionally inserted a transaction and marked it
// completed — clicking "Complete" twice (or a retried request) charged the guest
// twice for one shoe shine. The status transition now guards the insert inside a
// single transaction, and only an order that is still open can be completed.
const IMMEDIATE_METHODS = ['cash', 'card'];
const METHOD_LABELS = { cash: 'Cash', card: 'Card', room_charge: 'Room Charge', customer_bill: 'Customer Bill' };

router.post('/orders/:id/complete', (req, res) => {
  const order = db.prepare('SELECT * FROM misc_service_orders WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { paymentMethod } = req.body;
  if (!paymentMethod) return res.status(400).json({ error: 'paymentMethod is required' });
  if (!METHOD_LABELS[paymentMethod]) return res.status(400).json({ error: 'Invalid payment method' });
  if (order.status === 'completed') return res.status(409).json({ error: 'This service order has already been completed and charged' });
  if (order.status === 'cancelled') return res.status(409).json({ error: 'This service order was cancelled' });
  if (paymentMethod === 'room_charge' && !order.room_number) {
    return res.status(400).json({ error: 'This order has no room number — it cannot be posted to a room folio' });
  }

  const txnId = 'txn_' + nanoid(10);
  const methodLabel = METHOD_LABELS[paymentMethod];
  const isImmediate = IMMEDIATE_METHODS.includes(paymentMethod);
  let claimed = true;
  let txn = null;

  db.transaction(() => {
    const r = db.prepare(`UPDATE misc_service_orders SET status = 'completed', payment_method = ?, transaction_id = ?, completed_at = datetime('now')
                          WHERE id = ? AND status IN ('pending','in_progress')`)
      .run(paymentMethod, txnId, order.id);
    if (r.changes === 0) { claimed = false; return; }

    // Resolve this room's ACTIVE booking so a room-posted service lands on the
    // guest's BOOKING folio (charges keyed only by room_number are invisible to
    // /api/bookings/:id/folio and to booking-scoped settlement).
    let bookingId = null, guestId = null;
    if (order.room_number) {
      const bn = db.prepare('SELECT id FROM rooms WHERE tenant_id = ? AND number = ?').get(req.tenantId, order.room_number);
      const active = bn ? db.prepare(`SELECT b.id, b.guest_id FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id
        WHERE br.room_id = ? AND b.tenant_id = ? AND b.status = 'checked_in'`).get(bn.id, req.tenantId) : null;
      if (active) { bookingId = active.id; guestId = active.guest_id; }
    }
    // ONE money pipeline: idempotent posting, misc_revenue attribution,
    // debit side chosen from the payment method (room folio → ar_room,
    // customer bill → ar_customer, cash/card → cash/bank).
    const posted = postCharge(req.tenantId, {
      source: 'misc_service', sourceId: order.id, idempotencyKey: 'misc-service:' + order.id,
      amount: order.total, method: methodLabel,
      description: 'Service: ' + order.service_name,
      bookingId, guestId,
      roomNumber: order.room_number, guestName: order.guest_name || 'Walk-in Customer',
      gatewayRef: 'SVC-' + order.id.slice(6).toUpperCase(), immediate: isImmediate,
      createdBy: req.user.name,
    });
    txn = posted.transaction;
  })();

  if (!claimed) return res.status(409).json({ error: 'This service order has already been completed and charged' });
  audit(req, 'miscorder.complete', 'misc_service_order', order.id, { paymentMethod, amount: order.total });
  broadcast(req.tenantId, 'miscorder.updated', updated);
  if (!isImmediate) broadcast(req.tenantId, 'payment.created', txn);
  res.json({ ...updated, transaction: txn });
});

router.post('/orders/:id/cancel', (req, res) => {
  const order = db.prepare('SELECT * FROM misc_service_orders WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'completed') return res.status(409).json({ error: 'This order was already completed and charged — reverse the payment instead of cancelling' });
  db.prepare(`UPDATE misc_service_orders SET status = 'cancelled' WHERE id = ? AND status != 'completed'`).run(order.id);
  broadcast(req.tenantId, 'miscorder.updated', db.prepare('SELECT * FROM misc_service_orders WHERE id = ?').get(order.id));
  res.json({ ok: true });
});

module.exports = router;
