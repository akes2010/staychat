// server/routes/pos.js
// Point of Sale — Restaurant & Bar ticket management.
// A "ticket" is an open tab (a table, bar seat, or walk-in) that accumulates
// items until it's checked out. Checkout settles the ticket via one of:
//   cash / card        -> paid immediately, posts a completed transaction
//   room_charge        -> posts a pending transaction against a room/guest folio,
//                          to be settled at checkout (via the Payments page)
//   customer_bill       -> posts a pending transaction against a guest's running
//                          account (house account / city ledger), not tied to a room
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { broadcast } = require('../ws');
const { requirePermission, hasPermission } = require('../utils/permissions');
const { postCharge } = require('../services/charges');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('pos.use'));

function serialize(t) {
  return { ...t, items: JSON.parse(t.items || '[]') };
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// Clamp a percentage into [0, max]. Guards against a bad/hostile discount that
// would zero out or invert a bill (e.g. discountPct = 200 → negative total).
function clampPct(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

function computeTotals(items, discountPct, servicePct, taxPct) {
  const subtotal = items.reduce((s, i) => s + (Number(i.price) * Number(i.qty)), 0);
  const discountAmount = subtotal * clampPct(discountPct, 100) / 100;
  const serviceAmount = subtotal * clampPct(servicePct, 100) / 100;
  const taxableBase = subtotal - discountAmount + serviceAmount;
  const taxAmount = taxableBase * clampPct(taxPct, 100) / 100;
  const total = taxableBase + taxAmount;
  return {
    subtotal: round2(subtotal),
    discountAmount: round2(discountAmount),
    serviceAmount: round2(serviceAmount),
    taxAmount: round2(taxAmount),
    total: round2(total),
  };
}

function recalc(ticket) {
  const items = JSON.parse(ticket.items || '[]');
  const { subtotal, total } = computeTotals(items, ticket.discount_pct, ticket.service_pct, ticket.tax_pct);
  db.prepare('UPDATE pos_tickets SET subtotal = ?, total = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(subtotal, total, ticket.id);
  return db.prepare('SELECT * FROM pos_tickets WHERE id = ?').get(ticket.id);
}

// GET /api/pos/tickets?outlet=restaurant|bar&status=open
router.get('/tickets', (req, res) => {
  const { outlet, status } = req.query;
  let sql = 'SELECT * FROM pos_tickets WHERE tenant_id = ?';
  const params = [req.tenantId];
  if (outlet) { sql += ' AND outlet = ?'; params.push(outlet); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  else { sql += " AND (status = 'open' OR date(created_at) = date('now'))"; }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(serialize));
});

// GET /api/pos/summary — today's POS snapshot for the header cards
router.get('/summary', (req, res) => {
  const tenantId = req.tenantId;
  const outlets = ['restaurant', 'bar'];
  const summary = {};
  outlets.forEach(outlet => {
    const open = db.prepare(`SELECT COUNT(*) c FROM pos_tickets WHERE tenant_id = ? AND outlet = ? AND status = 'open'`).get(tenantId, outlet).c;
    const closedToday = db.prepare(`SELECT COALESCE(SUM(total),0) rev, COUNT(*) c FROM pos_tickets WHERE tenant_id = ? AND outlet = ? AND status = 'closed' AND date(closed_at) = date('now')`).get(tenantId, outlet);
    summary[outlet] = { openTickets: open, revenueToday: closedToday.rev, ticketsClosedToday: closedToday.c };
  });
  res.json(summary);
});

router.get('/tickets/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM pos_tickets WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  res.json(serialize(t));
});

// POST /api/pos/tickets — open a new ticket
router.post('/tickets', (req, res) => {
  const { outlet, label, guestName, guestId, roomNumber, note, cashierName } = req.body;
  if (!['restaurant', 'bar'].includes(outlet)) return res.status(400).json({ error: 'outlet must be "restaurant" or "bar"' });

  const id = 'pos_' + nanoid(10);
  const taxPct = req.tenant.pos_tax_pct || 0;
  const servicePct = req.tenant.pos_service_pct || 0;
  db.prepare(`INSERT INTO pos_tickets (id, tenant_id, outlet, label, guest_name, guest_id, room_number, note, tax_pct, service_pct, opened_by, cashier_name)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, outlet, label || (outlet === 'bar' ? 'Bar Tab' : 'Walk-in'), guestName || null, guestId || null, roomNumber || null, note || null, taxPct, servicePct, req.user.name, cashierName || req.user.name);

  const ticket = db.prepare('SELECT * FROM pos_tickets WHERE id = ?').get(id);
  audit(req, 'pos.ticket_open', 'pos_ticket', id, { outlet, label });
  broadcast(req.tenantId, 'pos.ticket.created', serialize(ticket));
  res.status(201).json(serialize(ticket));
});

function getOpenTicket(req, res) {
  const t = db.prepare('SELECT * FROM pos_tickets WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!t) { res.status(404).json({ error: 'Ticket not found' }); return null; }
  if (t.status !== 'open') { res.status(409).json({ error: 'Ticket is ' + t.status + ' and can no longer be modified' }); return null; }
  return t;
}

// PATCH /api/pos/tickets/:id — edit label/guest/room/note/discount while open
router.patch('/tickets/:id', (req, res) => {
  const t = getOpenTicket(req, res); if (!t) return;
  const fields = { label: 'label', guestName: 'guest_name', guestId: 'guest_id', roomNumber: 'room_number', note: 'note', discountPct: 'discount_pct', servicePct: 'service_pct', taxPct: 'tax_pct' };
  const updates = {};
  Object.entries(fields).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = req.body[bodyKey]; });
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  // Discount / service / tax percentages change what the guest is charged, so they
  // are a pricing decision — a plain pos.use terminal operator must not set them.
  const priceLevers = ['discount_pct', 'service_pct', 'tax_pct'].filter(k => updates[k] !== undefined);
  if (priceLevers.length && !hasPermission(req.user, 'pos.manage_products')) {
    return res.status(403).json({ error: 'Only a manager or owner can change discount, service or tax rates on a ticket (pos.manage_products)' });
  }
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE pos_tickets SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: t.id });
  const updated = recalc(db.prepare('SELECT * FROM pos_tickets WHERE id = ?').get(t.id));
  broadcast(req.tenantId, 'pos.ticket.updated', serialize(updated));
  res.json(serialize(updated));
});

// POST /api/pos/tickets/:id/items — add a line item { menuItemId?, name, price, qty }
router.post('/tickets/:id/items', (req, res) => {
  const t = getOpenTicket(req, res); if (!t) return;
  const { menuItemId, name, price, qty } = req.body;
  let itemName = name, itemPrice = price;
  if (menuItemId) {
    const m = db.prepare('SELECT * FROM menu_items WHERE id = ? AND tenant_id = ?').get(menuItemId, req.tenantId);
    if (!m) return res.status(404).json({ error: 'Menu item not found' });
    itemName = m.name; itemPrice = m.price;
  }
  if (!itemName || itemPrice === undefined) return res.status(400).json({ error: 'name/price (or menuItemId) required' });

  // Guard against negative prices/quantities that would compromise the bill total.
  const numPrice = Number(itemPrice);
  const numQty = Number(qty) || 1;
  if (!Number.isFinite(numPrice) || numPrice < 0) return res.status(400).json({ error: 'Price must be a non-negative number' });
  if (!Number.isFinite(numQty) || numQty < 0) return res.status(400).json({ error: 'Quantity must be a non-negative number' });
  const q = Math.max(1, numQty);

  const items = JSON.parse(t.items || '[]');
  const existing = items.find(i => i.menuItemId && i.menuItemId === menuItemId);
  if (existing) existing.qty += q;
  else items.push({ id: nanoid(8), menuItemId: menuItemId || null, name: itemName, price: numPrice, qty: q });

  db.prepare('UPDATE pos_tickets SET items = ? WHERE id = ?').run(JSON.stringify(items), t.id);
  const updated = recalc(db.prepare('SELECT * FROM pos_tickets WHERE id = ?').get(t.id));
  broadcast(req.tenantId, 'pos.ticket.updated', serialize(updated));
  res.json(serialize(updated));
});

// PATCH /api/pos/tickets/:id/items/:itemId — set quantity (0 removes it)
router.patch('/tickets/:id/items/:itemId', (req, res) => {
  const t = getOpenTicket(req, res); if (!t) return;
  const { qty } = req.body;
  let items = JSON.parse(t.items || '[]');
  const line = items.find(i => i.id === req.params.itemId);
  if (!line) return res.status(404).json({ error: 'Line item not found' });
  const q = Number(qty);
  if (!Number.isFinite(q) || q <= 0) items = items.filter(i => i.id !== req.params.itemId);
  else line.qty = q;

  db.prepare('UPDATE pos_tickets SET items = ? WHERE id = ?').run(JSON.stringify(items), t.id);
  const updated = recalc(db.prepare('SELECT * FROM pos_tickets WHERE id = ?').get(t.id));
  broadcast(req.tenantId, 'pos.ticket.updated', serialize(updated));
  res.json(serialize(updated));
});

// DELETE /api/pos/tickets/:id/items/:itemId
router.delete('/tickets/:id/items/:itemId', (req, res) => {
  const t = getOpenTicket(req, res); if (!t) return;
  const items = JSON.parse(t.items || '[]').filter(i => i.id !== req.params.itemId);
  db.prepare('UPDATE pos_tickets SET items = ? WHERE id = ?').run(JSON.stringify(items), t.id);
  const updated = recalc(db.prepare('SELECT * FROM pos_tickets WHERE id = ?').get(t.id));
  broadcast(req.tenantId, 'pos.ticket.updated', serialize(updated));
  res.json(serialize(updated));
});

// POST /api/pos/tickets/:id/void
router.post('/tickets/:id/void', (req, res) => {
  const t = getOpenTicket(req, res); if (!t) return;
  db.prepare(`UPDATE pos_tickets SET status = 'void', closed_by = ?, closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(req.user.name, t.id);
  const updated = db.prepare('SELECT * FROM pos_tickets WHERE id = ?').get(t.id);
  audit(req, 'pos.ticket_void', 'pos_ticket', t.id);
  broadcast(req.tenantId, 'pos.ticket.voided', serialize(updated));
  res.json(serialize(updated));
});

// POST /api/pos/tickets/:id/checkout — settle the ticket
// body: { paymentMethod: 'cash'|'card'|'room_charge'|'customer_bill'|'group_account', roomNumber?, guestId?, guestName?, discountPct?, bookingId? }
router.post('/tickets/:id/checkout', (req, res) => {
  const t = getOpenTicket(req, res); if (!t) return;
  const items = JSON.parse(t.items || '[]');
  if (items.length === 0) return res.status(400).json({ error: 'Cannot checkout an empty ticket' });

  const { paymentMethod } = req.body;
  if (!['cash', 'card', 'room_charge', 'customer_bill', 'group_account'].includes(paymentMethod)) {
    return res.status(400).json({ error: 'Invalid payment method' });
  }

  // A discount applied at the moment of settlement is the classic POS shrinkage
  // route: the operator rings up the full order, then zeroes the bill on checkout
  // and pockets the cash. Applying a discount here requires the same authority as
  // setting one on the ticket.
  let discountPct = t.discount_pct;
  if (req.body.discountPct !== undefined && Number(req.body.discountPct) !== Number(t.discount_pct)) {
    if (!hasPermission(req.user, 'pos.manage_products')) {
      return res.status(403).json({ error: 'Only a manager or owner can apply a discount at checkout (pos.manage_products)' });
    }
    discountPct = Number(req.body.discountPct);
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
      return res.status(400).json({ error: 'discountPct must be between 0 and 100' });
    }
  }
  const { subtotal, total } = computeTotals(items, discountPct, t.service_pct, t.tax_pct);

  let roomNumber = req.body.roomNumber || t.room_number || null;
  let guestName = req.body.guestName || t.guest_name || null;
  let guestId = req.body.guestId || t.guest_id || null;
  let bookingId = null;

  if (paymentMethod === 'room_charge') {
    if (!roomNumber) return res.status(400).json({ error: 'roomNumber is required to post to room charge' });
    const room = db.prepare('SELECT * FROM rooms WHERE tenant_id = ? AND number = ?').get(req.tenantId, roomNumber);
    if (!room) return res.status(404).json({ error: 'Room ' + roomNumber + ' not found' });
    guestName = guestName || room.guest_name || 'Guest';
  }
  if (paymentMethod === 'customer_bill') {
    if (guestId) {
      const g = db.prepare('SELECT * FROM guests WHERE id = ? AND tenant_id = ?').get(guestId, req.tenantId);
      if (!g) return res.status(404).json({ error: 'Guest not found' });
      guestName = g.name;
      roomNumber = roomNumber || g.room_number || null;
    } else if (!guestName) {
      return res.status(400).json({ error: 'guestId or guestName is required to bill a customer account' });
    }
  }
  if (paymentMethod === 'group_account') {
    bookingId = req.body.bookingId || t.booking_id;
    if (!bookingId) return res.status(400).json({ error: 'bookingId is required to charge a group account' });
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(bookingId, req.tenantId);
    if (!booking) return res.status(404).json({ error: 'Group booking not found' });
    if (!booking.is_group) return res.status(400).json({ error: 'That booking is not a group booking' });
    if (!['confirmed', 'checked_in'].includes(booking.status)) return res.status(409).json({ error: 'That group booking is ' + booking.status + ' and cannot accept new charges' });
    guestName = booking.group_name || booking.guest_name;
    roomNumber = null;
  }

  const methodLabel = { cash: 'Cash', card: 'Card', room_charge: 'Room Charge', customer_bill: 'Customer Bill', group_account: 'Group Account' }[paymentMethod];
  const isImmediate = paymentMethod === 'cash' || paymentMethod === 'card';
  const outletLabel = t.outlet === 'bar' ? 'Bar' : 'Restaurant';
  const itemsSummary = items.map(i => i.qty + '× ' + i.name).join(', ');

  // Close the ticket and post the charge through the ONE money pipeline in a
  // single transaction, with the UPDATE re-asserting status='open'. The
  // pipeline itself is idempotent ('pos:<ticketId>'), so even if a retried
  // request slips past the status guard, the charge cannot be posted twice.
  let claimed = true;
  let txn = null;
  const txnId = 'txn_' + nanoid(10);
  db.transaction(() => {
    const r = db.prepare(`UPDATE pos_tickets SET status = 'closed', payment_method = ?, transaction_id = ?, guest_name = ?, room_number = ?, guest_id = ?,
                booking_id = ?, discount_pct = ?, subtotal = ?, total = ?, closed_by = ?, closed_at = datetime('now'), updated_at = datetime('now')
                WHERE id = ? AND status = 'open'`)
      .run(paymentMethod, txnId, guestName, roomNumber, guestId, bookingId, discountPct, subtotal, total, req.user.name, t.id);
    if (r.changes === 0) { claimed = false; return; }

    const posted = postCharge(req.tenantId, {
      source: 'pos', sourceId: t.id, idempotencyKey: 'pos:' + t.id,
      amount: total, method: methodLabel,
      description: outletLabel + ' POS — ' + itemsSummary,
      bookingId, guestId, roomNumber, guestName: guestName || 'Walk-in Customer',
      outlet: t.outlet, gatewayRef: 'POS-' + t.id.slice(4).toUpperCase(),
      immediate: isImmediate, createdBy: req.user.name,
    });
    txn = posted.transaction;
  })();
  if (!claimed) return res.status(409).json({ error: 'This ticket has already been settled' });

  const updated = db.prepare('SELECT * FROM pos_tickets WHERE id = ?').get(t.id);

  audit(req, 'pos.ticket_checkout', 'pos_ticket', t.id, { paymentMethod, total });
  broadcast(req.tenantId, 'pos.ticket.closed', serialize(updated));
  if (!isImmediate) broadcast(req.tenantId, 'payment.created', txn);
  res.json({ ticket: serialize(updated), transaction: txn });
});

module.exports = router;
