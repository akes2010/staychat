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
const { postCharge, reverseCharge } = require('../services/charges');
const { refundTransaction } = require('../services/refunds');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('pos.use'));

// ── Load-time schema upgrade (this module's own table — additive) ──────────
// pos_tickets' original CHECK constraints only knew open/closed/void and the
// four pre-group payment methods, so charging a ticket to a group booking
// ('group_account') failed at the constraint, and a refund had no status to
// live in. SQLite cannot ALTER a CHECK, so rebuild ONLY this table
// transactionally (create wider → copy every row → drop → rename → re-index),
// exactly like server/routes/gym.js does for gym_bookings. Idempotent.
(function upgradePosTickets() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pos_tickets'").get();
  if (!row || (row.sql.includes("'refunded'") && row.sql.includes("'group_account'"))) return;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE pos_tickets_new (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          outlet TEXT NOT NULL DEFAULT 'restaurant' CHECK(outlet IN ('restaurant','bar')),
          label TEXT NOT NULL DEFAULT 'Walk-in',
          table_id TEXT REFERENCES pos_tables(id) ON DELETE SET NULL,
          covers INTEGER,
          guest_name TEXT,
          guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL,
          room_number TEXT,
          items TEXT NOT NULL DEFAULT '[]',
          subtotal REAL NOT NULL DEFAULT 0,
          discount_pct REAL NOT NULL DEFAULT 0,
          service_pct REAL NOT NULL DEFAULT 0,
          tax_pct REAL NOT NULL DEFAULT 0,
          total REAL NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','void','refunded')),
          payment_method TEXT CHECK(payment_method IN ('cash','card','room_charge','customer_bill','group_account')),
          transaction_id TEXT,
          note TEXT,
          opened_by TEXT,
          closed_by TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          closed_at TEXT,
          booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
          cashier_name TEXT,
          void_reason TEXT,
          refund_reason TEXT,
          refunded_amount REAL NOT NULL DEFAULT 0,
          refunded_at TEXT,
          refunded_by TEXT
        );
        INSERT INTO pos_tickets_new (id, tenant_id, outlet, label, table_id, covers, guest_name, guest_id, room_number,
          items, subtotal, discount_pct, service_pct, tax_pct, total, status, payment_method, transaction_id, note,
          opened_by, closed_by, created_at, updated_at, closed_at, booking_id, cashier_name,
          void_reason, refund_reason, refunded_amount, refunded_at, refunded_by)
          SELECT id, tenant_id, outlet, label, table_id, covers, guest_name, guest_id, room_number,
          items, subtotal, discount_pct, service_pct, tax_pct, total, status, payment_method, transaction_id, note,
          opened_by, closed_by, created_at, updated_at, closed_at, booking_id, cashier_name,
          void_reason, refund_reason, refunded_amount, refunded_at, refunded_by FROM pos_tickets;
        DROP TABLE pos_tickets;
        ALTER TABLE pos_tickets_new RENAME TO pos_tickets;
        CREATE INDEX IF NOT EXISTS idx_pos_tenant ON pos_tickets(tenant_id, status);
        CREATE INDEX IF NOT EXISTS idx_pos_outlet ON pos_tickets(tenant_id, outlet, status);
        CREATE INDEX IF NOT EXISTS idx_pos_table ON pos_tickets(table_id, status);
      `);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
})();

function serialize(t) {
  return { ...t, items: JSON.parse(t.items || '[]') };
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

// ── Outlet lock (fraud control) ───────────────────────────────────────
// A till operator's role pins their terminal: a barman works the BAR terminal
// ALONE, a cashier the RESTAURANT terminal ALONE. The UI already hides the
// other terminal — this is the server-side half, so driving the API by hand
// cannot read, open, edit, void or settle the OTHER outlet's tickets (the
// classic shrinkage route: touching the neighbouring till's takings).
// Managers/owners (hotel_admin, superadmin, staff on a till) have no lock.
function lockedOutlet(user) {
  if (user && user.role === 'barman') return 'bar';
  if (user && user.role === 'cashier') return 'restaurant';
  // Floor staff pin to their outlet the same way: waiter → bar, server →
  // restaurant (built in; custom roles choose their terminal freely).
  if (user && user.role === 'waiter') return 'bar';
  if (user && user.role === 'server') return 'restaurant';
  return null;
}
const OUTLET_NAMES = { bar: 'Bar', restaurant: 'Restaurant' };
function lockedOutletError(lock, other) {
  return 'This account is locked to the ' + OUTLET_NAMES[lock] + ' terminal — it cannot work the ' + OUTLET_NAMES[other] + ' terminal';
}

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
  // A locked till only ever receives its own outlet's tickets — the query
  // string cannot widen it (asking for the other outlet is ignored, not honoured).
  const lock = lockedOutlet(req.user);
  const effOutlet = lock || outlet;
  let sql = 'SELECT * FROM pos_tickets WHERE tenant_id = ?';
  const params = [req.tenantId];
  if (effOutlet) { sql += ' AND outlet = ?'; params.push(effOutlet); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  else { sql += " AND (status = 'open' OR date(created_at) = date('now'))"; }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(serialize));
});

// GET /api/pos/summary — today's POS snapshot for the header cards
router.get('/summary', (req, res) => {
  const tenantId = req.tenantId;
  const lock = lockedOutlet(req.user);
  const outlets = lock ? [lock] : ['restaurant', 'bar'];
  const summary = {};
  outlets.forEach(outlet => {
    const open = db.prepare(`SELECT COUNT(*) c FROM pos_tickets WHERE tenant_id = ? AND outlet = ? AND status = 'open'`).get(tenantId, outlet).c;
    const closedToday = db.prepare(`SELECT COALESCE(SUM(total),0) rev, COUNT(*) c FROM pos_tickets WHERE tenant_id = ? AND outlet = ? AND status = 'closed' AND date(closed_at) = date('now')`).get(tenantId, outlet);
    summary[outlet] = { openTickets: open, revenueToday: closedToday.rev, ticketsClosedToday: closedToday.c };
  });
  res.json(summary);
});

// GET /api/pos/tables — table picker data for the New Ticket flow: this
// tenant's ACTIVE tables with live occupancy (an open ticket seated at them).
// Rides the router's own pos.use gate, so any terminal operator can pick a
// table without needing the Tables & Seating management page.
router.get('/tables', (req, res) => {
  const lock = lockedOutlet(req.user);
  const tables = db.prepare('SELECT * FROM pos_tables WHERE tenant_id = ? AND active = 1 ORDER BY location, name').all(req.tenantId)
    .filter(t => !lock || t.location === lock); // a locked till only seats its own outlet
  const seated = db.prepare("SELECT id, table_id FROM pos_tickets WHERE tenant_id = ? AND status = 'open' AND table_id IS NOT NULL").all(req.tenantId);
  const seatedBy = new Map(seated.map(s => [s.table_id, s.id]));
  res.json(tables.map(t => ({
    id: t.id, name: t.name, sitting: t.sitting, chairs: t.chairs, persons: t.persons, location: t.location,
    occupied: seatedBy.has(t.id), ticketId: seatedBy.get(t.id) || null,
  })));
});

// ── Table-picker validation (shared by open + re-seat) ────────────────────
function cleanCovers(v) {
  if (v === undefined) return { covers: undefined };
  if (v === null || v === '') return { covers: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 50) return { error: 'covers must be a whole number between 1 and 50' };
  return { covers: n };
}
// The picked table must exist, be active, belong to this terminal's outlet,
// be free of OTHER open tickets, and have room for the party.
function validateSeat(tenantId, outlet, tableId, covers, excludeTicketId) {
  const table = db.prepare('SELECT * FROM pos_tables WHERE id = ? AND tenant_id = ?').get(tableId, tenantId);
  if (!table) return { status: 404, error: 'Table not found' };
  if (!table.active) return { status: 409, error: table.name + ' is not active' };
  if (table.location !== outlet) {
    return { status: 400, error: table.name + ' is a ' + table.location + ' table — it cannot seat a ' + outlet + ' ticket' };
  }
  const clash = db.prepare(`SELECT id FROM pos_tickets WHERE tenant_id = ? AND status = 'open' AND table_id = ?${excludeTicketId ? ' AND id != ?' : ''}`)
    .get(...(excludeTicketId ? [tenantId, table.id, excludeTicketId] : [tenantId, table.id]));
  if (clash) return { status: 409, error: table.name + ' is already seated (open ticket ' + clash.id + ')' };
  if (covers && covers > table.persons) {
    return { status: 400, error: table.name + ' seats ' + table.persons + ' persons — a party of ' + covers + ' does not fit' };
  }
  return { table };
}

router.get('/tickets/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM pos_tickets WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  const lock = lockedOutlet(req.user);
  if (lock && t.outlet !== lock) return res.status(403).json({ error: lockedOutletError(lock, t.outlet) });
  res.json(serialize(t));
});

// POST /api/pos/tickets — open a new ticket
router.post('/tickets', (req, res) => {
  const { outlet, label, guestName, guestId, roomNumber, note, cashierName } = req.body;
  if (!['restaurant', 'bar'].includes(outlet)) return res.status(400).json({ error: 'outlet must be "restaurant" or "bar"' });
  const lock = lockedOutlet(req.user);
  if (lock && outlet !== lock) return res.status(403).json({ error: lockedOutletError(lock, outlet) });

  // ── Table picker: validate the seat before the ticket exists ────────────
  const coversClean = cleanCovers(req.body.covers);
  if (coversClean.error) return res.status(400).json({ error: coversClean.error });
  const seatCovers = coversClean.covers === undefined ? null : coversClean.covers;
  let seatTableId = null;
  let seatLabel = null;
  if (req.body.tableId) {
    const seat = validateSeat(req.tenantId, outlet, req.body.tableId, seatCovers, null);
    if (seat.error) return res.status(seat.status).json({ error: seat.error });
    seatTableId = seat.table.id;
    seatLabel = seat.table.name; // the ticket label mirrors the table, so every
                                 // existing view (cards, receipts, closed list)
                                 // shows it without touching that code
  }

  const id = 'pos_' + nanoid(10);
  const taxPct = req.tenant.pos_tax_pct || 0;
  const servicePct = req.tenant.pos_service_pct || 0;
  db.prepare(`INSERT INTO pos_tickets (id, tenant_id, outlet, label, guest_name, guest_id, room_number, note, tax_pct, service_pct, opened_by, cashier_name)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, outlet, label || (outlet === 'bar' ? 'Bar Tab' : 'Walk-in'), guestName || null, guestId || null, roomNumber || null, note || null, taxPct, servicePct, req.user.name, cashierName || req.user.name);

  // Seat the ticket at the picked table / record the party size. The INSERT
  // above stays untouched — label only changes when a table was picked.
  if (seatTableId !== null || seatCovers !== null) {
    const seatCols = { table_id: seatTableId, covers: seatCovers };
    if (seatLabel !== null) seatCols.label = seatLabel;
    const seatSet = Object.keys(seatCols).map(k => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE pos_tickets SET ${seatSet} WHERE id = @id`).run({ ...seatCols, id });
    audit(req, 'pos.ticket_seat', 'pos_ticket', id, { tableId: seatTableId, covers: seatCovers });
  }

  const ticket = db.prepare('SELECT * FROM pos_tickets WHERE id = ?').get(id);
  audit(req, 'pos.ticket_open', 'pos_ticket', id, { outlet, label });
  broadcast(req.tenantId, 'pos.ticket.created', serialize(ticket));
  res.status(201).json(serialize(ticket));
});

function getOpenTicket(req, res) {
  const t = db.prepare('SELECT * FROM pos_tickets WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!t) { res.status(404).json({ error: 'Ticket not found' }); return null; }
  // Single choke point for every ticket mutation (edit, items, void,
  // checkout): a locked till never touches the other outlet's ticket.
  const lock = lockedOutlet(req.user);
  if (lock && t.outlet !== lock) { res.status(403).json({ error: lockedOutletError(lock, t.outlet) }); return null; }
  if (t.status !== 'open') { res.status(409).json({ error: 'Ticket is ' + t.status + ' and can no longer be modified' }); return null; }
  return t;
}

// PATCH /api/pos/tickets/:id — edit label/guest/room/note/discount while open
router.patch('/tickets/:id', (req, res) => {
  const t = getOpenTicket(req, res); if (!t) return;
  const fields = { label: 'label', guestName: 'guest_name', guestId: 'guest_id', roomNumber: 'room_number', note: 'note', discountPct: 'discount_pct', servicePct: 'service_pct', taxPct: 'tax_pct' };
  const updates = {};
  Object.entries(fields).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = req.body[bodyKey]; });
  // ── Table picker while open: re-seat the ticket or adjust the party ─────
  if (req.body.tableId !== undefined || req.body.covers !== undefined) {
    const seatCoversClean = cleanCovers(req.body.covers);
    if (seatCoversClean.error) return res.status(400).json({ error: seatCoversClean.error });
    if (seatCoversClean.covers !== undefined) updates.covers = seatCoversClean.covers;
    if (req.body.tableId !== undefined) {
      if (req.body.tableId === null || req.body.tableId === '') {
        updates.table_id = null; // unseated — the label stays as-is
      } else {
        const party = 'covers' in updates ? updates.covers : t.covers;
        const seat = validateSeat(req.tenantId, t.outlet, req.body.tableId, party, t.id);
        if (seat.error) return res.status(seat.status).json({ error: seat.error });
        updates.table_id = seat.table.id;
        updates.label = seat.table.name; // re-seat syncs the label
      }
    }
    // covers-only change must still fit the table the ticket already sits at
    if ('covers' in updates && !('table_id' in updates) && t.table_id && updates.covers) {
      const cur = db.prepare('SELECT name, persons FROM pos_tables WHERE id = ?').get(t.table_id);
      if (cur && updates.covers > cur.persons) {
        return res.status(400).json({ error: cur.name + ' seats ' + cur.persons + ' persons — a party of ' + updates.covers + ' does not fit' });
      }
    }
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  // Discount / service / tax percentages change what the guest is charged, so they
  // are a pricing decision — a plain pos.use terminal operator must not set them.
  const priceLevers = ['discount_pct', 'service_pct', 'tax_pct'].filter(k => updates[k] !== undefined);
  if (priceLevers.length && !hasPermission(req.user, 'pos.manage_products')) {
    return res.status(403).json({ error: 'Only a manager or owner can change discount, service or tax rates on a ticket (pos.manage_products)' });
  }
  // Seat changes are part of the record — audit them like opens are (only
  // once every validation above has passed).
  if ('table_id' in updates || 'covers' in updates) {
    audit(req, 'pos.ticket_seat', 'pos_ticket', t.id, {
      tableId: 'table_id' in updates ? updates.table_id : t.table_id,
      covers: 'covers' in updates ? updates.covers : t.covers,
    });
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

// POST /api/pos/tickets/:id/void — body { reason }
// A void throws away an order nobody paid for; the written reason is what makes
// it reviewable (why was a full tab abandoned?) rather than an unexplained gap
// in the shift's takings. Required — the terminal asks for it before confirming.
router.post('/tickets/:id/void', (req, res) => {
  const t = getOpenTicket(req, res); if (!t) return;
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 300);
  if (!reason) return res.status(400).json({ error: 'A written reason is required to void a ticket' });
  db.prepare(`UPDATE pos_tickets SET status = 'void', void_reason = ?, closed_by = ?, closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`)
    .run(reason, req.user.name, t.id);
  const updated = db.prepare('SELECT * FROM pos_tickets WHERE id = ?').get(t.id);
  audit(req, 'pos.ticket_void', 'pos_ticket', t.id, { reason });
  broadcast(req.tenantId, 'pos.ticket.voided', serialize(updated));
  res.json(serialize(updated));
});

// POST /api/pos/tickets/:id/refund — body { reason }
// Money leaving the till is the .manage side of the POS split (payments.manage),
// never a cashier's day-to-day action. The original payment is reversed through
// the ONE refund pipeline (completed cash/card) or the pending-charge reverser
// (room charge / customer bill / group account), then the ticket itself is
// marked 'refunded' with the reason attached for the shift report.
router.post('/tickets/:id/refund', requirePermission('payments.manage'), (req, res) => {
  const t = db.prepare('SELECT * FROM pos_tickets WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!t) return res.status(404).json({ error: 'Ticket not found' });
  const lock = lockedOutlet(req.user);
  if (lock && t.outlet !== lock) return res.status(403).json({ error: lockedOutletError(lock, t.outlet) });
  if (t.status === 'void') return res.status(409).json({ error: 'A voided ticket was never charged — nothing to refund' });
  if (t.status === 'open') return res.status(409).json({ error: 'This ticket is still open — void it instead of refunding' });
  if (t.status === 'refunded') return res.status(409).json({ error: 'This ticket has already been refunded' });
  if (t.status !== 'closed') return res.status(409).json({ error: 'Only a settled ticket can be refunded' });

  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 300);
  if (!reason) return res.status(400).json({ error: 'A written reason is required to issue a refund' });
  if (!t.transaction_id) return res.status(409).json({ error: 'This ticket has no recorded payment to refund' });

  // Tickets settled before the id fix above stored a placeholder id; the charge
  // itself is still findable by its idempotency key, so refunds keep working
  // for those rows.
  let txn = db.prepare('SELECT * FROM transactions WHERE id = ? AND tenant_id = ?').get(t.transaction_id, req.tenantId);
  if (!txn) txn = db.prepare('SELECT * FROM transactions WHERE tenant_id = ? AND idempotency_key = ?').get(req.tenantId, 'pos:' + t.id);
  if (!txn) return res.status(409).json({ error: 'The payment for this ticket is missing from the ledger — check the Payments page' });
  if (txn.status === 'refunded' || txn.status === 'failed') {
    return res.status(409).json({ error: 'This payment has already been refunded or reversed' });
  }

  try {
    if (txn.status === 'completed') {
      refundTransaction({ tenantId: req.tenantId, transactionId: txn.id, reason, user: req.user });
    } else if (txn.status === 'pending') {
      // Unsettled folio charge: cancel it rather than refund money that was
      // never collected. reverseCharge is idempotent on 'pos:<ticketId>'.
      reverseCharge(req.tenantId, 'pos:' + t.id, reason, req.user.name);
    } else {
      return res.status(409).json({ error: 'This payment is ' + txn.status + ' and cannot be refunded' });
    }

    const r = db.prepare(`UPDATE pos_tickets SET status = 'refunded', refund_reason = ?, refunded_amount = ?,
                refunded_at = datetime('now'), refunded_by = ?, updated_at = datetime('now')
                WHERE id = ? AND status = 'closed'`)
      .run(reason, t.total, req.user.name, t.id);
    if (r.changes === 0) return res.status(409).json({ error: 'This ticket was just refunded by someone else' });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }

  const updated = db.prepare('SELECT * FROM pos_tickets WHERE id = ?').get(t.id);
  audit(req, 'pos.ticket_refund', 'pos_ticket', t.id, { amount: t.total, reason, transactionId: txn.id });
  broadcast(req.tenantId, 'pos.ticket.refunded', serialize(updated));
  res.json({ ticket: serialize(updated), refunded: updated.refunded_amount, reason });
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
    // postCharge owns transaction ids; the ticket must point at the REAL ledger
    // row (the placeholder above only claims the seat atomically). Without this
    // the ticket's payment reference dangles and refunds cannot find the money.
    if (txn && txn.id && txn.id !== txnId) {
      db.prepare('UPDATE pos_tickets SET transaction_id = ? WHERE id = ?').run(txn.id, t.id);
    }
  })();
  if (!claimed) return res.status(409).json({ error: 'This ticket has already been settled' });

  const updated = db.prepare('SELECT * FROM pos_tickets WHERE id = ?').get(t.id);

  audit(req, 'pos.ticket_checkout', 'pos_ticket', t.id, { paymentMethod, total });
  broadcast(req.tenantId, 'pos.ticket.closed', serialize(updated));
  if (!isImmediate) broadcast(req.tenantId, 'payment.created', txn);
  res.json({ ticket: serialize(updated), transaction: txn });
});

module.exports = router;
