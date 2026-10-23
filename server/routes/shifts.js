// server/routes/shifts.js
// Shift & Attendance Management. Shifts define recurring work windows
// (e.g. Morning 07:00–15:00). Attendance records one clock-in/out per staff
// member per day, optionally tied to a shift, with a status for reporting.
//
// The module also carries a DUTY ROTATION calendar: an ordered, repeating
// cycle of department blocks — each department holds the duty for N
// consecutive days, then the next department takes over. The seeded default
// is Reception 2 days → Kitchen 2 days → Bar 3 days (a 7-day rotating week);
// hotels can reorder or extend it to cover any other department. The cycle is
// anchored to a start date, so any day in the future (or past) resolves to
// exactly one on-duty department. Entirely additive: the existing shift
// definitions, attendance records and their endpoints are untouched.
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, requireRole, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { requireEntitlement } = require('../services/entitlements');
const { broadcast } = require('../ws');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('attendance.use'), requireEntitlement('staff_shifts'));

// ── Duty rotation (rotating department calendar) ─────────────────────────
// Module-local schema — migrate.js is untouched, same pattern as the gym and
// fitness modules: idempotent, runs before any route below can touch it.
db.transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shift_rotations (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      department TEXT NOT NULL,
      position INTEGER NOT NULL,
      days_on INTEGER NOT NULL DEFAULT 1,
      UNIQUE(tenant_id, department)
    );
    CREATE TABLE IF NOT EXISTS shift_rotation_settings (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      anchor_date TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
})();

// Seeded default: the rotating week the hotel asked for — Reception (2 days)
// → Kitchen (2 days) → Bar (3 days). Any department can be added/edited later.
const DEFAULT_ROTATION = [
  { department: 'Reception', daysOn: 2 },
  { department: 'Kitchen', daysOn: 2 },
  { department: 'Bar', daysOn: 3 },
];

function validDateStr(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z').getTime()); }
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Whole-day difference b −a (both YYYY-MM-DD).
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
// Cycle day 1 starts on the Monday of the current week — a calendar-anchored
// rotation, not "whenever the table happened to be created".
function mondayOfThisWeek() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// First access per tenant seeds the default rotation + anchor (idempotent).
function ensureRotation(tenantId) {
  return db.transaction(() => {
    const count = db.prepare('SELECT COUNT(*) c FROM shift_rotations WHERE tenant_id = ?').get(tenantId).c;
    if (count === 0) {
      const ins = db.prepare('INSERT OR IGNORE INTO shift_rotations (id, tenant_id, department, position, days_on) VALUES (?,?,?,?,?)');
      DEFAULT_ROTATION.forEach((r, i) => ins.run('rot_' + nanoid(10), tenantId, r.department, i, r.daysOn));
    }
    let cfg = db.prepare('SELECT * FROM shift_rotation_settings WHERE tenant_id = ?').get(tenantId);
    if (!cfg) {
      const anchor = mondayOfThisWeek();
      db.prepare(`INSERT OR IGNORE INTO shift_rotation_settings (tenant_id, anchor_date, updated_at) VALUES (?,?,datetime('now'))`)
        .run(tenantId, anchor);
      cfg = db.prepare('SELECT * FROM shift_rotation_settings WHERE tenant_id = ?').get(tenantId);
    }
    return cfg;
  })();
}
function rotationRows(tenantId) {
  return db.prepare('SELECT * FROM shift_rotations WHERE tenant_id = ? ORDER BY position').all(tenantId);
}
// Offset of a date inside the repeating cycle (0-based, negative dates wrap).
function cycleOffset(anchor, total, dateStr) {
  let off = daysBetween(anchor, dateStr) % total;
  if (off < 0) off += total;
  return off;
}
// Which department holds the duty on a given date, and where in its block.
function dutyOn(rows, total, anchor, dateStr) {
  let off = cycleOffset(anchor, total, dateStr);
  for (const r of rows) {
    if (off < r.days_on) return { row: r, dayInBlock: off + 1, cycleDay: off + 1 };
    off -= r.days_on;
  }
  return { row: rows[0], dayInBlock: 1, cycleDay: 1 }; // unreachable when total > 0
}
function rotationView(tenantId, cfg, rows) {
  const total = rows.reduce((s, r) => s + r.days_on, 0);
  let day = 1;
  return {
    anchorDate: cfg.anchor_date,
    totalDays: total,
    rotation: rows.map(r => {
      const entry = { id: r.id, department: r.department, position: r.position, daysOn: r.days_on,
                      cycleDayStart: day, cycleDayEnd: day + r.days_on - 1 };
      day += r.days_on;
      return entry;
    }),
  };
}

// GET /api/shifts/rotation — the cycle itself (seeded on first access).
router.get('/rotation', (req, res) => {
  const cfg = ensureRotation(req.tenantId);
  res.json(rotationView(req.tenantId, cfg, rotationRows(req.tenantId)));
});

// GET /api/shifts/rotation/calendar?from=&to= — every date in the range
// resolved to its on-duty department (defaults: today → +20 days, cap 92).
router.get('/rotation/calendar', (req, res) => {
  const cfg = ensureRotation(req.tenantId);
  const rows = rotationRows(req.tenantId);
  const total = rows.reduce((s, r) => s + r.days_on, 0);
  const today = new Date().toISOString().slice(0, 10);
  const from = req.query.from !== undefined ? String(req.query.from) : today;
  const to = req.query.to !== undefined ? String(req.query.to) : addDaysStr(from, 20);
  if (!validDateStr(from) || !validDateStr(to)) return res.status(400).json({ error: 'from/to must be valid YYYY-MM-DD dates' });
  const span = daysBetween(from, to);
  if (span < 0) return res.status(400).json({ error: 'to must be on or after from' });
  if (span > 92) return res.status(400).json({ error: 'Calendar range is capped at 92 days per request' });

  const days = [];
  for (let i = 0; i <= span; i++) {
    const date = addDaysStr(from, i);
    const d = dutyOn(rows, total, cfg.anchor_date, date);
    const blockStart = addDaysStr(date, -(d.dayInBlock - 1));
    days.push({
      date,
      department: d.row.department,
      dayInBlock: d.dayInBlock,
      blockDays: d.row.days_on,
      blockStart,
      blockEnd: addDaysStr(blockStart, d.row.days_on - 1),
      cycleDay: d.cycleDay,
    });
  }
  res.json({ anchorDate: cfg.anchor_date, totalDays: total, from, to, days });
});

// PUT /api/shifts/rotation — replace the whole ordered cycle (shifts.manage).
// Body: { rotation: [{ department, daysOn }…], anchorDate? }. Every department
// holds the duty for its daysOn consecutive days, then the next one takes over.
router.put('/rotation', requirePermission('shifts.manage'), (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body.rotation) ? body.rotation : null;
  if (!list || list.length === 0) return res.status(400).json({ error: 'rotation must be a non-empty array of { department, daysOn }' });
  if (list.length > 20) return res.status(400).json({ error: 'A rotation can carry at most 20 departments' });

  const seen = new Set();
  const cleaned = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i] || {};
    const dept = String(entry.department || '').trim().slice(0, 60);
    const daysOn = Math.round(Number(entry.daysOn));
    if (!dept) return res.status(400).json({ error: 'Every rotation entry needs a department name (entry ' + (i + 1) + ')' });
    if (seen.has(dept.toLowerCase())) return res.status(400).json({ error: 'Department "' + dept + '" appears more than once in the rotation' });
    if (!Number.isFinite(daysOn) || daysOn < 1 || daysOn > 30) {
      return res.status(400).json({ error: 'Shift days for ' + dept + ' must be between 1 and 30' });
    }
    seen.add(dept.toLowerCase());
    cleaned.push({ dept, daysOn });
  }
  const total = cleaned.reduce((s, r) => s + r.daysOn, 0);
  if (total > 366) return res.status(400).json({ error: 'A rotation cycle cannot exceed 366 days' });

  let anchor = null;
  if (body.anchorDate !== undefined) {
    if (!validDateStr(body.anchorDate)) return res.status(400).json({ error: 'anchorDate must be a valid YYYY-MM-DD date' });
    anchor = String(body.anchorDate);
  }

  // Seed first (guarantees the settings row), then swap the cycle atomically.
  const cfg = ensureRotation(req.tenantId);
  db.transaction(() => {
    db.prepare('DELETE FROM shift_rotations WHERE tenant_id = ?').run(req.tenantId);
    const ins = db.prepare('INSERT INTO shift_rotations (id, tenant_id, department, position, days_on) VALUES (?,?,?,?,?)');
    cleaned.forEach((r, i) => ins.run('rot_' + nanoid(10), req.tenantId, r.dept, i, r.daysOn));
    if (anchor) {
      db.prepare(`UPDATE shift_rotation_settings SET anchor_date = ?, updated_at = datetime('now') WHERE tenant_id = ?`)
        .run(anchor, req.tenantId);
    }
  })();

  const nextCfg = anchor ? { ...cfg, anchor_date: anchor } : cfg;
  audit(req, 'shift_rotation.update', 'shift_rotation', req.tenantId,
    { totalDays: total, anchorDate: nextCfg.anchor_date, departments: cleaned.map(c => c.dept + ':' + c.daysOn) });
  broadcast(req.tenantId, 'shift.rotation.updated', { totalDays: total });
  res.json(rotationView(req.tenantId, nextCfg, rotationRows(req.tenantId)));
});

// ── Shifts (schedule definitions) ───────────────────────────────────────
router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM shifts WHERE tenant_id = ? ORDER BY start_time').all(req.tenantId).map(s => ({ ...s, active: !!s.active })));
});

router.post('/', requirePermission('shifts.manage'), (req, res) => {
  const { name, startTime, endTime, department } = req.body;
  if (!name || !startTime || !endTime) return res.status(400).json({ error: 'name, startTime and endTime are required' });
  const id = 'shift_' + nanoid(10);
  db.prepare('INSERT INTO shifts (id, tenant_id, name, start_time, end_time, department) VALUES (?,?,?,?,?,?)')
    .run(id, req.tenantId, name, startTime, endTime, department || 'All');
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(id);
  audit(req, 'shift.create', 'shift', id, { name });
  res.status(201).json({ ...shift, active: !!shift.active });
});

router.patch('/:id', requirePermission('shifts.manage'), (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  const map = { name: 'name', startTime: 'start_time', endTime: 'end_time', department: 'department', active: 'active' };
  const updates = {};
  Object.entries(map).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = bodyKey === 'active' ? (req.body[bodyKey] ? 1 : 0) : req.body[bodyKey]; });
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE shifts SET ${setClause} WHERE id = @id`).run({ ...updates, id: shift.id });
  const updated = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shift.id);
  res.json({ ...updated, active: !!updated.active });
});

router.delete('/:id', requirePermission('shifts.manage'), (req, res) => {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!shift) return res.status(404).json({ error: 'Shift not found' });
  db.prepare('DELETE FROM shifts WHERE id = ?').run(shift.id);
  audit(req, 'shift.delete', 'shift', shift.id);
  res.json({ ok: true });
});

// ── Attendance ───────────────────────────────────────────────────────
// GET /api/shifts/attendance?date=YYYY-MM-DD
router.get('/attendance', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT a.*, s.name as shift_name FROM attendance a LEFT JOIN shifts s ON s.id = a.shift_id
    WHERE a.tenant_id = ? AND a.date = ? ORDER BY a.clock_in ASC
  `).all(req.tenantId, date);
  res.json(rows);
});

// GET /api/shifts/attendance/summary?from=&to=  — per-staff attendance counts for a range
router.get('/attendance/summary', (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT staff_name, staff_id,
      SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) as present,
      SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) as late,
      SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) as absent,
      SUM(CASE WHEN status = 'on_leave' THEN 1 ELSE 0 END) as on_leave,
      COUNT(*) as total
    FROM attendance WHERE tenant_id = ? AND date BETWEEN ? AND ? GROUP BY staff_id, staff_name ORDER BY staff_name
  `).all(req.tenantId, from, to);
  res.json(rows);
});

// POST /api/shifts/attendance/clock-in
router.post('/attendance/clock-in', (req, res) => {
  const { staffId, shiftId } = req.body;
  const staff = staffId ? db.prepare('SELECT * FROM staff WHERE id = ? AND tenant_id = ?').get(staffId, req.tenantId) : null;
  const staffName = staff ? staff.name : req.user.name;
  const date = new Date().toISOString().slice(0, 10);
  const now = new Date().toTimeString().slice(0, 5);

  const existing = db.prepare('SELECT * FROM attendance WHERE tenant_id = ? AND date = ? AND (staff_id = ? OR (staff_id IS NULL AND staff_name = ?))').get(req.tenantId, date, staffId || null, staffName);
  if (existing) return res.status(409).json({ error: staffName + ' has already clocked in today' });

  let status = 'present';
  if (shiftId) {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ? AND tenant_id = ?').get(shiftId, req.tenantId);
    if (shift && now > shift.start_time) status = 'late';
  }

  const id = 'att_' + nanoid(10);
  db.prepare('INSERT INTO attendance (id, tenant_id, staff_id, staff_name, shift_id, date, clock_in, status) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.tenantId, staffId || null, staffName, shiftId || null, date, now, status);
  const record = db.prepare('SELECT * FROM attendance WHERE id = ?').get(id);
  audit(req, 'attendance.clockin', 'attendance', id, { staffName });
  broadcast(req.tenantId, 'attendance.updated', record);
  res.status(201).json(record);
});

// POST /api/shifts/attendance/:id/clock-out
router.post('/attendance/:id/clock-out', (req, res) => {
  const record = db.prepare('SELECT * FROM attendance WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!record) return res.status(404).json({ error: 'Attendance record not found' });
  if (record.clock_out) return res.status(409).json({ error: 'Already clocked out' });
  const now = new Date().toTimeString().slice(0, 5);
  db.prepare('UPDATE attendance SET clock_out = ? WHERE id = ?').run(now, record.id);
  const updated = db.prepare('SELECT * FROM attendance WHERE id = ?').get(record.id);
  audit(req, 'attendance.clockout', 'attendance', record.id);
  broadcast(req.tenantId, 'attendance.updated', updated);
  res.json(updated);
});

// POST /api/shifts/attendance/mark — admin manually marks absent/on_leave/etc for a staff member+date
router.post('/attendance/mark', requirePermission('shifts.manage'), (req, res) => {
  const { staffId, staffName, date, status, shiftId, notes } = req.body;
  if (!staffName || !date || !status) return res.status(400).json({ error: 'staffName, date and status are required' });
  if (!['present', 'late', 'absent', 'on_leave'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const existing = db.prepare('SELECT * FROM attendance WHERE tenant_id = ? AND date = ? AND (staff_id = ? OR (staff_id IS NULL AND staff_name = ?))').get(req.tenantId, date, staffId || null, staffName);
  if (existing) {
    db.prepare('UPDATE attendance SET status = ?, notes = ?, shift_id = ? WHERE id = ?').run(status, notes || null, shiftId || existing.shift_id, existing.id);
    const updated = db.prepare('SELECT * FROM attendance WHERE id = ?').get(existing.id);
    broadcast(req.tenantId, 'attendance.updated', updated);
    return res.json(updated);
  }
  const id = 'att_' + nanoid(10);
  db.prepare('INSERT INTO attendance (id, tenant_id, staff_id, staff_name, shift_id, date, status, notes) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, req.tenantId, staffId || null, staffName, shiftId || null, date, status, notes || null);
  const record = db.prepare('SELECT * FROM attendance WHERE id = ?').get(id);
  audit(req, 'attendance.mark', 'attendance', id, { staffName, status });
  broadcast(req.tenantId, 'attendance.updated', record);
  res.status(201).json(record);
});

module.exports = router;
