// server/routes/eod.js
// End of Day closings — each operational department (front desk, restaurant,
// bar, pool, hall, other services) closes out its own day, aggregating real
// transaction data so totals always tie back to what was actually recorded
// elsewhere in the system (nothing here is manually typed in from memory).
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('eod.use'));

const DEPARTMENTS = ['front_desk', 'restaurant', 'bar', 'pool', 'hall', 'misc_services'];

function summarizeByMethod(rows, amountKey, methodKey) {
  const totals = {};
  rows.forEach(r => { const m = r[methodKey] || 'unknown'; totals[m] = (totals[m] || 0) + r[amountKey]; });
  return totals;
}

/** Build today's (or a given date's) real totals for one department. */
function computeDeptSummary(tenantId, department, date) {
  if (department === 'restaurant' || department === 'bar') {
    const rows = db.prepare(`SELECT * FROM pos_tickets WHERE tenant_id = ? AND outlet = ? AND status = 'closed' AND date(closed_at) = ?`)
      .all(tenantId, department, date);
    return { count: rows.length, grossTotal: rows.reduce((s, r) => s + r.total, 0), byMethod: summarizeByMethod(rows, 'total', 'payment_method') };
  }
  if (department === 'front_desk') {
    const checkins = db.prepare(`SELECT * FROM bookings WHERE tenant_id = ? AND status = 'checked_in' AND date(updated_at) = ?`).all(tenantId, date);
    const checkouts = db.prepare(`SELECT * FROM bookings WHERE tenant_id = ? AND status = 'checked_out' AND date(updated_at) = ?`).all(tenantId, date);
    const txns = db.prepare(`SELECT * FROM transactions WHERE tenant_id = ? AND status = 'completed' AND date(created_at) = ? AND (room_number IS NOT NULL OR booking_id IS NOT NULL)`).all(tenantId, date);
    return { count: checkins.length + checkouts.length, checkins: checkins.length, checkouts: checkouts.length, grossTotal: txns.reduce((s, t) => s + t.amount, 0), byMethod: summarizeByMethod(txns, 'amount', 'method') };
  }
  if (department === 'pool') {
    const rows = db.prepare(`SELECT * FROM pool_bookings WHERE tenant_id = ? AND date = ? AND status IN ('completed','checked_in')`).all(tenantId, date);
    return { count: rows.length, grossTotal: rows.reduce((s, r) => s + r.price, 0), byMethod: { paid: rows.filter(r => r.paid).reduce((s, r) => s + r.price, 0), unpaid: rows.filter(r => !r.paid).reduce((s, r) => s + r.price, 0) } };
  }
  if (department === 'hall') {
    const rows = db.prepare(`SELECT * FROM hall_bookings WHERE tenant_id = ? AND event_date = ?`).all(tenantId, date);
    return { count: rows.length, grossTotal: rows.reduce((s, r) => s + r.total_amount, 0), byMethod: {} };
  }
  if (department === 'misc_services') {
    const rows = db.prepare(`SELECT * FROM misc_service_orders WHERE tenant_id = ? AND status = 'completed' AND date(completed_at) = ?`).all(tenantId, date);
    return { count: rows.length, grossTotal: rows.reduce((s, r) => s + r.total, 0), byMethod: summarizeByMethod(rows, 'total', 'payment_method') };
  }
  return { count: 0, grossTotal: 0, byMethod: {} };
}

// GET /api/eod/preview?department=&date= — live totals before closing
router.get('/preview', (req, res) => {
  const { department, date } = req.query;
  if (!department || !DEPARTMENTS.includes(department)) return res.status(400).json({ error: 'Valid department is required' });
  const d = date || new Date().toISOString().slice(0, 10);
  res.json({ department, date: d, ...computeDeptSummary(req.tenantId, department, d) });
});

// GET /api/eod?date= — all closings for a date (management overview)
router.get('/', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = db.prepare('SELECT * FROM eod_closings WHERE tenant_id = ? AND date = ?').all(req.tenantId, date)
    .map(r => ({ ...r, totals: JSON.parse(r.totals || '{}') }));
  res.json(rows);
});

// POST /api/eod/close — submit today's close for one department
router.post('/close', (req, res) => {
  const { department, date, notes } = req.body;
  if (!department || !DEPARTMENTS.includes(department)) return res.status(400).json({ error: 'Valid department is required' });
  const d = date || new Date().toISOString().slice(0, 10);

  const existing = db.prepare('SELECT * FROM eod_closings WHERE tenant_id = ? AND department = ? AND date = ?').get(req.tenantId, department, d);
  if (existing && existing.status === 'closed') return res.status(409).json({ error: 'This department has already closed out ' + d });

  const summary = computeDeptSummary(req.tenantId, department, d);
  const id = existing ? existing.id : 'eod_' + nanoid(10);
  // Two concurrent closes for the same department+date both pass the 'existing'
  // check above; the second INSERT hits the UNIQUE(tenant_id, department, date)
  // constraint. Map that to 409 instead of an unhandled 500.
  try {
    if (existing) {
      db.prepare(`UPDATE eod_closings SET closed_by = ?, totals = ?, notes = ?, status = 'closed' WHERE id = ?`)
        .run(req.user.name, JSON.stringify(summary), notes || null, id);
    } else {
      db.prepare(`INSERT INTO eod_closings (id, tenant_id, department, date, closed_by, totals, notes) VALUES (?,?,?,?,?,?,?)`)
        .run(id, req.tenantId, department, d, req.user.name, JSON.stringify(summary), notes || null);
    }
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'This department has already closed out ' + d });
    }
    throw e;
  }
  const record = db.prepare('SELECT * FROM eod_closings WHERE id = ?').get(id);
  audit(req, 'eod.close', 'eod_closing', id, { department, date: d, grossTotal: summary.grossTotal });
  res.status(201).json({ ...record, totals: JSON.parse(record.totals) });
});

// POST /api/eod/:id/reopen — admin-only correction path
router.post('/:id/reopen', requirePermission('eod.manage'), (req, res) => {
  const record = db.prepare('SELECT * FROM eod_closings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!record) return res.status(404).json({ error: 'Closing not found' });
  db.prepare(`UPDATE eod_closings SET status = 'reopened' WHERE id = ?`).run(record.id);
  audit(req, 'eod.reopen', 'eod_closing', record.id);
  res.json({ ok: true });
});

module.exports = router;
