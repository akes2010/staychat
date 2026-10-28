// server/routes/eod.js
// End of Day closings — each operational department (front desk, restaurant,
// bar, pool, hall, other services) closes out its own day, aggregating real
// transaction data so totals always tie back to what was actually recorded
// elsewhere in the system (nothing here is manually typed in from memory).
//
// Visibility model (who sees whose EOD):
//   - Users WITHOUT 'eod.manage' (cashiers, barmen, receptionists, …) see ONLY
//     THEIR DEPARTMENT's account — the closing recorded for the department
//     they work in, whoever on that team submitted it — and can only close
//     that department (see deptForUser). Other departments' numbers are
//     invisible both ways: bar can't read front desk, front desk can't read
//     bar or restaurant.
//   - Users WITH 'eod.manage' (owner/hotel_admin/superadmin by default) see
//     and manage EVERY department's closings: full-day overview, reopen,
//     corrections.
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { requireEntitlement } = require('../services/entitlements');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('eod.use'), requireEntitlement('eod'));

const DEPARTMENTS = ['front_desk', 'restaurant', 'bar', 'pool', 'hall', 'misc_services'];

// Admin-defined departments (Users & Permissions → Departments) close books
// under their KEY alongside the built-ins, so a new outlet (Spa, Laundry…)
// gets its own day-end card without touching this module's defaults. Their
// summaries start at zero — there are no per-outlet source tables for an
// arbitrary department yet — while every built-in keeps its real aggregation.
function customDepartments(tenantId) {
  try {
    return db.prepare('SELECT key, name, icon FROM custom_departments WHERE tenant_id = ? ORDER BY created_at').all(tenantId);
  } catch (e) { return []; } // table not migrated yet — behave exactly as before
}
function validDepartmentsFor(tenantId) {
  return DEPARTMENTS.concat(customDepartments(tenantId).map(d => d.key));
}

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

// ── Visibility helpers ──────────────────────────────────────────────────────
const { hasPermission } = require('../utils/permissions');

function canManageEod(req) {
  return hasPermission(req.user, 'eod.manage');
}

// The department a non-manager works in — from their staff record when one
// exists, else the department set on their user account (the Users page lets
// admins assign it directly). Falls back to front_desk when neither exists.
function deptForUser(req) {
  const user = db.prepare('SELECT email, department FROM users WHERE id = ?').get(req.user.id) || {};
  const staff = db.prepare('SELECT department FROM staff WHERE tenant_id = ? AND (user_id = ? OR email = ?) LIMIT 1')
    .get(req.tenantId, req.user.id, (user.email || '').toLowerCase());
  const dept = (staff?.department || user.department || '').toLowerCase();
  // An exact match against a managed custom department wins first — its KEY
  // is the code its closings live under. (Substring rules below would
  // otherwise swallow a custom "Bar & Grille" into the built-in bar books.)
  const custom = customDepartments(req.tenantId)
    .find(d => String(d.name).toLowerCase() === dept.trim());
  if (custom) return custom.key;
  if (dept.includes('bar')) return 'bar';
  if (dept.includes('rest') || dept.includes('kit')) return 'restaurant';
  if (dept.includes('pool')) return 'pool';
  if (dept.includes('hall') || dept.includes('event')) return 'hall';
  if (dept.includes('laundry') || dept.includes('service')) return 'misc_services';
  // Neither record carries a department: fall back to the ROLE's own outlet —
  // the same model the POS uses (cashier runs the restaurant till, barman the
  // bar) — so an unassigned account can never land on another department's
  // books. Everything that isn't a till or a desk stays front_desk, as before.
  const role = String(req.user.role || '').toLowerCase();
  if (role === 'barman' || role === 'waiter') return 'bar';
  if (role === 'cashier' || role === 'server') return 'restaurant';
  return 'front_desk';
}

function serializeClosing(r) {
  return { ...r, totals: JSON.parse(r.totals || '{}') };
}

// GET /api/eod/preview?department=&date= — live totals before closing
router.get('/preview', (req, res) => {
  const { department, date } = req.query;
  if (!department || !validDepartmentsFor(req.tenantId).includes(department)) return res.status(400).json({ error: 'Valid department is required' });
  if (!canManageEod(req) && department !== deptForUser(req)) {
    return res.status(403).json({ error: 'You can only close out your own department' });
  }
  const d = date || new Date().toISOString().slice(0, 10);
  res.json({ department, date: d, ...computeDeptSummary(req.tenantId, department, d) });
});

// GET /api/eod/departments — the closable catalogue: built-in outlets plus
// this tenant's custom ones, each with the label/icon the closing page
// renders. Any signed-in EOD user may read it (their page needs the labels);
// it carries nothing sensitive.
router.get('/departments', (req, res) => {
  const builtIn = [
    { key: 'front_desk', name: 'Front Desk / Receptionist', icon: '🛎' },
    { key: 'restaurant', name: 'Restaurant', icon: '🍽' },
    { key: 'bar', name: 'Bar', icon: '🍸' },
    { key: 'pool', name: 'Pool', icon: '🏊' },
    { key: 'hall', name: 'Halls & Events', icon: '🎪' },
    { key: 'misc_services', name: 'Other Services', icon: '🧺' },
  ].map(d => ({ ...d, custom: false }));
  res.json(builtIn.concat(customDepartments(req.tenantId)
    .map(d => ({ key: d.key, name: d.name, icon: d.icon || '🏷', custom: true }))));
});

// GET /api/eod?date= — closings for a date.
//   Managers: every department (management overview).
//   Everyone else: only THEIR department's closings for that date.
router.get('/', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  let rows;
  if (canManageEod(req)) {
    rows = db.prepare('SELECT * FROM eod_closings WHERE tenant_id = ? AND date = ?').all(req.tenantId, date);
  } else {
    rows = db.prepare('SELECT * FROM eod_closings WHERE tenant_id = ? AND date = ? AND department = ?')
      .all(req.tenantId, date, deptForUser(req));
  }
  res.json(rows.map(serializeClosing));
});

// GET /api/eod/mine?date= — "my department's account" cards for the closing
// user's UI. Returns the closings of the user's OWN department (shared by
// that team — whoever closed it) plus the assigned department, so the page
// knows which department's Close button to offer. Other departments never
// appear here.
router.get('/mine', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const myDept = deptForUser(req);
  const rows = db.prepare('SELECT * FROM eod_closings WHERE tenant_id = ? AND date = ? AND department = ?')
    .all(req.tenantId, date, myDept)
    .map(serializeClosing);
  res.json({ department: myDept, closings: rows, canManageAll: canManageEod(req) });
});

// POST /api/eod/close — submit a close for one department.
// Managers may close any department; staff may only close their own.
// The closing is attributed to the submitting user (closed_by_user_id), so it
// appears in their personal EOD view and in the owner/admin's overview.
router.post('/close', (req, res) => {
  const { date, notes } = req.body;
  // Managers may omit department (a quick "close my day" button) — front desk
  // is the natural default. Non-managers always resolve their own department.
  const department = req.body.department || (canManageEod(req) ? 'front_desk' : deptForUser(req));
  if (!department || !validDepartmentsFor(req.tenantId).includes(department)) return res.status(400).json({ error: 'Valid department is required' });
  if (!canManageEod(req) && department !== deptForUser(req)) {
    return res.status(403).json({ error: 'You can only close out your own department' });
  }
  const d = date || new Date().toISOString().slice(0, 10);

  const existing = db.prepare('SELECT * FROM eod_closings WHERE tenant_id = ? AND department = ? AND date = ?').get(req.tenantId, department, d);
  if (existing && existing.status === 'closed' && !canManageEod(req)) {
    // Already closed: staff simply see the fact; only managers can redo it.
    return res.status(409).json({ error: 'This department has already closed out ' + d });
  }

  const summary = computeDeptSummary(req.tenantId, department, d);
  const id = existing ? existing.id : 'eod_' + nanoid(10);
  // Two concurrent closes for the same department+date both pass the 'existing'
  // check above; the second INSERT hits the UNIQUE(tenant_id, department, date)
  // constraint. Map that to 409 instead of an unhandled 500.
  try {
    if (existing) {
      db.prepare(`UPDATE eod_closings SET closed_by = ?, closed_by_user_id = ?, totals = ?, notes = ?, status = 'closed' WHERE id = ?`)
        .run(req.user.name, req.user.id, JSON.stringify(summary), notes || null, id);
    } else {
      db.prepare(`INSERT INTO eod_closings (id, tenant_id, department, date, closed_by, closed_by_user_id, totals, notes) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, req.tenantId, department, d, req.user.name, req.user.id, JSON.stringify(summary), notes || null);
    }
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'This department has already closed out ' + d });
    }
    throw e;
  }
  const record = db.prepare('SELECT * FROM eod_closings WHERE id = ?').get(id);
  audit(req, 'eod.close', 'eod_closing', id, { department, date: d, grossTotal: summary.grossTotal });
  res.status(201).json(serializeClosing(record));
});

// POST /api/eod/:id/reopen — manager-only correction path. Reopening rolls the
// closing back so the department's user can (and must) close again; the
// record keeps its original closer until resubmitted.
router.post('/:id/reopen', requirePermission('eod.manage'), (req, res) => {
  const record = db.prepare('SELECT * FROM eod_closings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!record) return res.status(404).json({ error: 'Closing not found' });
  db.prepare(`UPDATE eod_closings SET status = 'reopened' WHERE id = ?`).run(record.id);
  audit(req, 'eod.reopen', 'eod_closing', record.id);
  res.json({ ok: true });
});

// GET /api/eod/overview?date= — manager-only: every user's closings grouped by
// user, with per-user and grand totals. This is the owner's reconciliation
// view ("general users' EOD seen and managed by the owner/admin").
router.get('/overview', requirePermission('eod.manage'), (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = db.prepare('SELECT * FROM eod_closings WHERE tenant_id = ? AND date = ?').all(req.tenantId, date)
    .map(serializeClosing);

  const byUser = {};
  rows.forEach(r => {
    const key = r.closed_by_user_id || r.closed_by || 'unknown';
    if (!byUser[key]) {
      let name = r.closed_by || 'Unknown';
      let role = null;
      if (r.closed_by_user_id) {
        const u = db.prepare('SELECT name, role FROM users WHERE id = ?').get(r.closed_by_user_id);
        if (u) { name = u.name; role = u.role; }
      }
      byUser[key] = { userId: r.closed_by_user_id || null, name, role, closings: [], total: 0 };
    }
    byUser[key].closings.push(r);
    byUser[key].total += r.totals.grossTotal || 0;
  });

  res.json({
    date,
    grandTotal: rows.reduce((s, r) => s + (r.totals.grossTotal || 0), 0),
    users: Object.values(byUser).sort((a, b) => b.total - a.total),
  });
});

module.exports = router;
