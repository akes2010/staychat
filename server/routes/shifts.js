// server/routes/shifts.js
// Shift & Attendance Management. Shifts define recurring work windows
// (e.g. Morning 07:00–15:00). Attendance records one clock-in/out per staff
// member per day, optionally tied to a shift, with a status for reporting.
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, requireRole, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { requireEntitlement } = require('../services/entitlements');
const { broadcast } = require('../ws');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('attendance.use'), requireEntitlement('staff_shifts'));

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
