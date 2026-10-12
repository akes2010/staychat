// server/routes/reports.js
// Report Management — one endpoint per operational area of the hotel, each
// filterable by daily/weekly/monthly/quarterly/yearly (or a custom date
// range), so every module has its own clear report instead of one giant
// undifferentiated dump. Nothing here invents data: every report queries the
// same tables the rest of the app already writes to.
const express = require('express');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('analytics.view'));

// ── Period resolution ────────────────────────────────────────────────
function resolveRange(period, dateStr, fromStr, toStr) {
  if (period === 'custom' && fromStr && toStr) return { from: fromStr, to: toStr };
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const iso = (x) => x.toISOString().slice(0, 10);

  if (period === 'weekly') {
    const day = d.getDay() === 0 ? 7 : d.getDay(); // Mon=1..Sun=7
    const monday = new Date(d); monday.setDate(d.getDate() - day + 1);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    return { from: iso(monday), to: iso(sunday) };
  }
  if (period === 'monthly') {
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return { from: iso(first), to: iso(last) };
  }
  if (period === 'quarterly') {
    const q = Math.floor(d.getMonth() / 3);
    const first = new Date(d.getFullYear(), q * 3, 1);
    const last = new Date(d.getFullYear(), q * 3 + 3, 0);
    return { from: iso(first), to: iso(last) };
  }
  if (period === 'yearly') {
    return { from: d.getFullYear() + '-01-01', to: d.getFullYear() + '-12-31' };
  }
  // daily (default)
  return { from: iso(d), to: iso(d) };
}

router.get('/types', (req, res) => {
  res.json([
    { id: 'transactions', label: 'Transactions', category: 'Finance' },
    { id: 'charges', label: 'Charges & Postings', category: 'Finance' },
    { id: 'discounts', label: 'Discounts Given', category: 'Finance' },
    { id: 'purchasing', label: 'Purchasing / Expenses', category: 'Finance' },
    { id: 'walkins', label: 'Walk-In Guests', category: 'Front Desk' },
    { id: 'bookings', label: 'Bookings & Reservations', category: 'Front Desk' },
    { id: 'receptionist', label: 'Receptionist Activity', category: 'Front Desk' },
    { id: 'rooms', label: 'Room Occupancy', category: 'Rooms' },
    { id: 'floors', label: 'Floors', category: 'Rooms' },
    { id: 'categories', label: 'Room Categories', category: 'Rooms' },
    { id: 'housekeeping', label: 'Housekeeping', category: 'Rooms' },
    { id: 'maintenance', label: 'Maintenance', category: 'Rooms' },
    { id: 'restaurant', label: 'Restaurant (POS)', category: 'Outlets' },
    { id: 'bar', label: 'Bar (POS)', category: 'Outlets' },
    { id: 'room_service', label: 'Room Service', category: 'Outlets' },
    { id: 'pool', label: 'Pool', category: 'Outlets' },
    { id: 'hall', label: 'Halls & Events', category: 'Outlets' },
    { id: 'other_services', label: 'Other Services (Car, Laundry, Shoe Care…)', category: 'Outlets' },
    { id: 'activity', label: 'All Activity (Audit Log)', category: 'System' },
  ]);
});

// ── CSV helpers ──────────────────────────────────────────────────────
// Escapes a value for RFC-4180 CSV: quotes doubled, commas/quotes/newlines
// wrapped. Numbers, booleans and null pass through as plain text.
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvRow(cells) { return cells.map(csvCell).join(','); }

// Flattens one report row for CSV: every column the JSON endpoint returns,
// with nested objects serialized as JSON so no data is silently dropped.
function rowCells(row) {
  const keys = Object.keys(row).sort((a, b) => (a === 'id' ? -1 : b === 'id' ? 1 : 0));
  return keys.map(k => {
    let v = row[k];
    if (v && typeof v === 'object') try { v = JSON.stringify(v); } catch (e) { v = String(v); }
    return v;
  });
}

// GET /api/reports/:type/csv — the same report as a real CSV download.
// Same permission, same data path, so what you see on screen is exactly
// what lands in the file — no separate "export" logic to drift out of sync.
router.get('/:type/csv', (req, res) => {
  req.params.type = req.params.type.replace(/\.csv$/i, '');
  // Reuse the JSON handler by faking a JSON capture, so both endpoints stay
  // one implementation.
  const fakeRes = {
    status(code) { this._code = code; return this; },
    json(payload) { this._payload = payload; return this; },
  };
  runReport(req, fakeRes, () => {
    if (fakeRes._code) return res.status(fakeRes._code).json(fakeRes._payload);
    const { rows } = fakeRes._payload;
    const header = rows.length ? Object.keys(rows[0]).sort((a, b) => (a === 'id' ? -1 : b === 'id' ? 1 : 0)) : [];
    const lines = [header.length ? csvRow(header) : 'no data'];
    rows.forEach(r => lines.push(csvRow(rowCells(r))));
    const csv = lines.join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="staychat-' + req.params.type + '-' + new Date().toISOString().slice(0, 10) + '.csv"');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(csv);
  });
});

// The shared report engine — extracted from the JSON handler below so the CSV
// endpoint can run the exact same queries.
function runReport(req, res, done) {
  const { period, date, from, to } = req.query;
  const range = resolveRange(period || 'daily', date, from, to);
  const t = req.tenantId;
  const type = req.params.type;

  try {
    let result;
    switch (type) {
      case 'transactions': {
        const rows = db.prepare(`SELECT * FROM transactions WHERE tenant_id = ? AND date(created_at) BETWEEN ? AND ? ORDER BY created_at DESC`).all(t, range.from, range.to);
        result = { rows, summary: { count: rows.length, total: rows.reduce((s, r) => s + r.amount, 0), completed: rows.filter(r => r.status === 'completed').reduce((s, r) => s + r.amount, 0), pending: rows.filter(r => r.status === 'pending').reduce((s, r) => s + r.amount, 0) } };
        break;
      }
      case 'charges': {
        const rows = db.prepare(`SELECT * FROM transactions WHERE tenant_id = ? AND method IN ('Room Charge','Customer Bill','Group Account') AND date(created_at) BETWEEN ? AND ? ORDER BY created_at DESC`).all(t, range.from, range.to);
        result = { rows, summary: { count: rows.length, total: rows.reduce((s, r) => s + r.amount, 0) } };
        break;
      }
      case 'discounts': {
        const rows = db.prepare(`SELECT * FROM pos_tickets WHERE tenant_id = ? AND discount_pct > 0 AND status = 'closed' AND date(closed_at) BETWEEN ? AND ? ORDER BY closed_at DESC`).all(t, range.from, range.to);
        const withDiscount = rows.map(r => ({ ...r, discountAmount: r.subtotal * r.discount_pct / 100 }));
        result = { rows: withDiscount, summary: { count: rows.length, totalDiscount: withDiscount.reduce((s, r) => s + r.discountAmount, 0) } };
        break;
      }
      case 'purchasing': {
        const rows = db.prepare(`
          SELECT jl.*, je.date, je.reference, je.description, a.code, a.name as account_name FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id JOIN accounts a ON a.id = jl.account_id
          WHERE jl.tenant_id = ? AND a.type = 'expense' AND je.date BETWEEN ? AND ? ORDER BY je.date DESC
        `).all(t, range.from, range.to);
        result = { rows, summary: { count: rows.length, total: rows.reduce((s, r) => s + r.debit, 0) } };
        break;
      }
      case 'walkins': {
        const rows = db.prepare(`SELECT * FROM bookings WHERE tenant_id = ? AND source = 'direct' AND date(created_at) BETWEEN ? AND ? ORDER BY created_at DESC`).all(t, range.from, range.to);
        result = { rows, summary: { count: rows.length, total: rows.reduce((s, r) => s + r.total_amount, 0) } };
        break;
      }
      case 'bookings': {
        const rows = db.prepare(`SELECT * FROM bookings WHERE tenant_id = ? AND date(created_at) BETWEEN ? AND ? ORDER BY created_at DESC`).all(t, range.from, range.to);
        result = {
          rows, summary: {
            count: rows.length, total: rows.reduce((s, r) => s + r.total_amount, 0),
            group: rows.filter(r => r.is_group).length, individual: rows.filter(r => !r.is_group).length,
            cancelled: rows.filter(r => r.status === 'cancelled').length,
          },
        };
        break;
      }
      case 'receptionist': {
        const rows = db.prepare(`
          SELECT al.*, u.name as user_name, u.role as user_role FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
          WHERE al.tenant_id = ? AND al.action IN ('booking.create','booking.checkin','booking.checkout','booking.cancel','room.checkin','room.checkout')
          AND date(al.created_at) BETWEEN ? AND ? ORDER BY al.created_at DESC
        `).all(t, range.from, range.to);
        result = { rows, summary: { count: rows.length } };
        break;
      }
      case 'rooms': {
        const rooms = db.prepare('SELECT * FROM rooms WHERE tenant_id = ?').all(t);
        const overlapping = db.prepare(`
          SELECT br.room_id, COUNT(*) c FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id
          WHERE b.tenant_id = ? AND b.status IN ('checked_in','checked_out') AND NOT (b.check_out < ? OR b.check_in > ?)
          GROUP BY br.room_id
        `).all(t, range.from, range.to);
        const byRoom = Object.fromEntries(overlapping.map(o => [o.room_id, o.c]));
        result = {
          rows: rooms.map(r => ({ ...r, staysInPeriod: byRoom[r.id] || 0 })),
          summary: { total: rooms.length, available: rooms.filter(r => r.status === 'available').length, occupied: rooms.filter(r => r.status === 'occupied').length, dirty: rooms.filter(r => r.status === 'dirty').length, maintenance: rooms.filter(r => r.status === 'maintenance').length },
        };
        break;
      }
      case 'floors': {
        const floors = db.prepare('SELECT * FROM floors WHERE tenant_id = ?').all(t);
        result = { rows: floors.map(f => ({ ...f, roomCount: db.prepare('SELECT COUNT(*) c FROM rooms WHERE floor_id = ?').get(f.id).c, occupied: db.prepare("SELECT COUNT(*) c FROM rooms WHERE floor_id = ? AND status = 'occupied'").get(f.id).c })), summary: { count: floors.length } };
        break;
      }
      case 'categories': {
        const cats = db.prepare('SELECT * FROM room_categories WHERE tenant_id = ?').all(t);
        result = {
          rows: cats.map(c => ({ ...c, roomCount: db.prepare('SELECT COUNT(*) c FROM rooms WHERE category_id = ?').get(c.id).c })),
          summary: { count: cats.length },
        };
        break;
      }
      case 'housekeeping': {
        const rows = db.prepare(`
          SELECT al.*, u.name as user_name FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
          WHERE al.tenant_id = ? AND al.action = 'room.update' AND (al.details LIKE '%cleaning%' OR al.details LIKE '%dirty%')
          AND date(al.created_at) BETWEEN ? AND ? ORDER BY al.created_at DESC
        `).all(t, range.from, range.to);
        result = { rows, summary: { count: rows.length } };
        break;
      }
      case 'maintenance': {
        const rows = db.prepare(`SELECT * FROM maintenance_requests WHERE tenant_id = ? AND date(created_at) BETWEEN ? AND ? ORDER BY created_at DESC`).all(t, range.from, range.to);
        result = { rows, summary: { count: rows.length, open: rows.filter(r => r.status !== 'resolved' && r.status !== 'completed').length } };
        break;
      }
      case 'restaurant':
      case 'bar': {
        const rows = db.prepare(`SELECT * FROM pos_tickets WHERE tenant_id = ? AND outlet = ? AND status = 'closed' AND date(closed_at) BETWEEN ? AND ? ORDER BY closed_at DESC`).all(t, type, range.from, range.to);
        result = { rows, summary: { count: rows.length, total: rows.reduce((s, r) => s + r.total, 0) } };
        break;
      }
      case 'room_service': {
        const rows = db.prepare(`SELECT * FROM orders WHERE tenant_id = ? AND date(created_at) BETWEEN ? AND ? ORDER BY created_at DESC`).all(t, range.from, range.to);
        result = { rows, summary: { count: rows.length, total: rows.reduce((s, r) => s + r.total, 0) } };
        break;
      }
      case 'pool': {
        const rows = db.prepare(`SELECT * FROM pool_bookings WHERE tenant_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC`).all(t, range.from, range.to);
        result = { rows, summary: { count: rows.length, total: rows.reduce((s, r) => s + r.price, 0) } };
        break;
      }
      case 'hall': {
        const rows = db.prepare(`SELECT * FROM hall_bookings WHERE tenant_id = ? AND event_date BETWEEN ? AND ? ORDER BY event_date DESC`).all(t, range.from, range.to);
        result = { rows, summary: { count: rows.length, total: rows.reduce((s, r) => s + r.total_amount, 0) } };
        break;
      }
      case 'other_services': {
        const rows = db.prepare(`SELECT * FROM misc_service_orders WHERE tenant_id = ? AND date(created_at) BETWEEN ? AND ? ORDER BY created_at DESC`).all(t, range.from, range.to);
        result = { rows, summary: { count: rows.length, total: rows.reduce((s, r) => s + r.total, 0) } };
        break;
      }
      case 'activity': {
        const rows = db.prepare(`
          SELECT al.*, u.name as user_name, u.role as user_role FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
          WHERE al.tenant_id = ? AND date(al.created_at) BETWEEN ? AND ? ORDER BY al.created_at DESC LIMIT 1000
        `).all(t, range.from, range.to);
        result = { rows, summary: { count: rows.length } };
        break;
      }
      default:
        return res.status(404).json({ error: 'Unknown report type: ' + type });
    }
    res.json({ type, period: period || 'daily', range, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate report: ' + err.message });
  }
  if (done) done();
}

// GET /api/reports/:type — the JSON report the Reports page renders.
router.get('/:type', (req, res) => { runReport(req, res); });

module.exports = router;
