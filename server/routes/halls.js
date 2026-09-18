// server/routes/halls.js
// Halls & Events — banquet/meeting-room inventory (halls) plus their event
// bookings (hall_bookings), with date/time overlap conflict checking per hall.
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, requireRole, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { requireEntitlement } = require('../services/entitlements');
const { broadcast } = require('../ws');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('halls.use'), requireEntitlement('hall_events'));

function serializeHall(h) { return { ...h, amenities: JSON.parse(h.amenities || '[]'), active: !!h.active }; }
function serializeBooking(b) { return { ...b, catering: !!b.catering }; }

// ── Halls (inventory) ───────────────────────────────────────────────────
router.get('/halls', (req, res) => {
  const rows = db.prepare('SELECT * FROM halls WHERE tenant_id = ? ORDER BY name').all(req.tenantId);
  res.json(rows.map(serializeHall));
});

router.post('/halls', requirePermission('halls.manage'), (req, res) => {
  const { name, capacity, hourlyRate, dayRate, amenities, description, category } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = 'hall_' + nanoid(10);
  db.prepare(`INSERT INTO halls (id, tenant_id, name, capacity, hourly_rate, day_rate, amenities, description, category) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, name, Number(capacity) || 50, Number(hourlyRate) || 0, Number(dayRate) || 0, JSON.stringify(amenities || []), description || null, category || 'Standard');
  const hall = db.prepare('SELECT * FROM halls WHERE id = ?').get(id);
  audit(req, 'hall.create', 'hall', id, { name });
  res.status(201).json(serializeHall(hall));
});

router.patch('/halls/:id', requirePermission('halls.manage'), (req, res) => {
  const hall = db.prepare('SELECT * FROM halls WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!hall) return res.status(404).json({ error: 'Hall not found' });
  const map = { name: 'name', capacity: 'capacity', hourlyRate: 'hourly_rate', dayRate: 'day_rate', active: 'active', description: 'description', category: 'category' };
  const updates = {};
  Object.entries(map).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = bodyKey === 'active' ? (req.body[bodyKey] ? 1 : 0) : req.body[bodyKey]; });
  if (req.body.amenities !== undefined) updates.amenities = JSON.stringify(req.body.amenities);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE halls SET ${setClause} WHERE id = @id`).run({ ...updates, id: hall.id });
  const updated = db.prepare('SELECT * FROM halls WHERE id = ?').get(hall.id);
  audit(req, 'hall.update', 'hall', hall.id, updates);
  res.json(serializeHall(updated));
});

router.delete('/halls/:id', requirePermission('halls.manage'), (req, res) => {
  const hall = db.prepare('SELECT * FROM halls WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!hall) return res.status(404).json({ error: 'Hall not found' });
  const activeBookings = db.prepare(`SELECT COUNT(*) c FROM hall_bookings WHERE hall_id = ? AND status IN ('tentative','confirmed') AND event_date >= date('now')`).get(hall.id).c;
  if (activeBookings > 0) return res.status(409).json({ error: 'Cannot delete a hall with upcoming bookings — cancel them first' });
  db.prepare('DELETE FROM halls WHERE id = ?').run(hall.id);
  audit(req, 'hall.delete', 'hall', hall.id);
  res.json({ ok: true });
});

// ── Hall Bookings ────────────────────────────────────────────────────────
// GET /api/halls/bookings?from=&to=&hallId=
router.get('/bookings', (req, res) => {
  const { from, to, hallId } = req.query;
  let sql = 'SELECT * FROM hall_bookings WHERE tenant_id = ?';
  const params = [req.tenantId];
  if (hallId) { sql += ' AND hall_id = ?'; params.push(hallId); }
  if (from) { sql += ' AND event_date >= ?'; params.push(from); }
  if (to) { sql += ' AND event_date <= ?'; params.push(to); }
  sql += ' ORDER BY event_date ASC, start_time ASC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(serializeBooking));
});

function conflictCheck(tenantId, hallId, date, start, end, excludeId) {
  const row = db.prepare(`
    SELECT * FROM hall_bookings WHERE tenant_id = ? AND hall_id = ? AND event_date = ? AND status IN ('tentative','confirmed')
      AND NOT (end_time <= ? OR start_time >= ?) ${excludeId ? 'AND id != ?' : ''}
  `).get(...(excludeId ? [tenantId, hallId, date, start, end, excludeId] : [tenantId, hallId, date, start, end]));
  return row;
}

router.post('/bookings', (req, res) => {
  const {
    hallId, eventName, eventType, organizerName, organizerPhone, organizerEmail,
    eventDate, startTime, endTime, guestCount, setupStyle, catering, totalAmount, depositAmount, notes, status,
  } = req.body;
  if (!hallId || !eventName || !organizerName || !eventDate || !startTime || !endTime) {
    return res.status(400).json({ error: 'hallId, eventName, organizerName, eventDate, startTime and endTime are required' });
  }
  if (endTime <= startTime) return res.status(400).json({ error: 'endTime must be after startTime' });

  const hall = db.prepare('SELECT * FROM halls WHERE id = ? AND tenant_id = ?').get(hallId, req.tenantId);
  if (!hall) return res.status(404).json({ error: 'Hall not found' });
  if (guestCount && Number(guestCount) > hall.capacity) return res.status(400).json({ error: hall.name + ' has a capacity of ' + hall.capacity + ' guests' });

  const conflict = conflictCheck(req.tenantId, hallId, eventDate, startTime, endTime);
  if (conflict) return res.status(409).json({ error: hall.name + ' is already booked (' + conflict.event_name + ') during that time' });

  const id = 'hb_' + nanoid(10);
  db.prepare(`INSERT INTO hall_bookings (id, tenant_id, hall_id, event_name, event_type, organizer_name, organizer_phone, organizer_email,
              event_date, start_time, end_time, guest_count, setup_style, catering, total_amount, deposit_amount, status, notes, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, hallId, eventName, eventType || 'Meeting', organizerName, organizerPhone || null, organizerEmail || null,
         eventDate, startTime, endTime, Number(guestCount) || 1, setupStyle || 'Theatre', catering ? 1 : 0,
         Number(totalAmount) || 0, Number(depositAmount) || 0, status || 'tentative', notes || null, req.user.name);

  const booking = db.prepare('SELECT * FROM hall_bookings WHERE id = ?').get(id);
  audit(req, 'hall_booking.create', 'hall_booking', id, { eventName, hallId });
  broadcast(req.tenantId, 'hallbooking.created', serializeBooking(booking));
  res.status(201).json(serializeBooking(booking));
});

router.patch('/bookings/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM hall_bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Hall booking not found' });
  if (['completed', 'cancelled'].includes(b.status)) return res.status(409).json({ error: 'This booking is ' + b.status + ' and can no longer be edited' });

  const map = {
    hallId: 'hall_id', eventName: 'event_name', eventType: 'event_type', organizerName: 'organizer_name',
    organizerPhone: 'organizer_phone', organizerEmail: 'organizer_email', eventDate: 'event_date', startTime: 'start_time',
    endTime: 'end_time', guestCount: 'guest_count', setupStyle: 'setup_style', totalAmount: 'total_amount',
    depositAmount: 'deposit_amount', notes: 'notes', status: 'status',
  };
  const updates = {};
  Object.entries(map).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = req.body[bodyKey]; });
  if (req.body.catering !== undefined) updates.catering = req.body.catering ? 1 : 0;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const nextHall = updates.hall_id || b.hall_id, nextDate = updates.event_date || b.event_date;
  const nextStart = updates.start_time || b.start_time, nextEnd = updates.end_time || b.end_time;
  if (updates.hall_id || updates.event_date || updates.start_time || updates.end_time) {
    const conflict = conflictCheck(req.tenantId, nextHall, nextDate, nextStart, nextEnd, b.id);
    if (conflict) return res.status(409).json({ error: 'That hall is already booked during the new time (' + conflict.event_name + ')' });
  }

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE hall_bookings SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: b.id });
  const updated = db.prepare('SELECT * FROM hall_bookings WHERE id = ?').get(b.id);
  audit(req, 'hall_booking.update', 'hall_booking', b.id, updates);
  broadcast(req.tenantId, 'hallbooking.updated', serializeBooking(updated));
  res.json(serializeBooking(updated));
});

router.post('/bookings/:id/cancel', requirePermission('halls.manage'), (req, res) => {
  const b = db.prepare('SELECT * FROM hall_bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Hall booking not found' });
  db.prepare(`UPDATE hall_bookings SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(b.id);
  const updated = db.prepare('SELECT * FROM hall_bookings WHERE id = ?').get(b.id);
  audit(req, 'hall_booking.cancel', 'hall_booking', b.id);
  broadcast(req.tenantId, 'hallbooking.updated', serializeBooking(updated));
  res.json(serializeBooking(updated));
});

router.post('/bookings/:id/complete', (req, res) => {
  const b = db.prepare('SELECT * FROM hall_bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Hall booking not found' });
  db.prepare(`UPDATE hall_bookings SET status='completed', updated_at=datetime('now') WHERE id=?`).run(b.id);
  const updated = db.prepare('SELECT * FROM hall_bookings WHERE id = ?').get(b.id);
  audit(req, 'hall_booking.complete', 'hall_booking', b.id);
  broadcast(req.tenantId, 'hallbooking.updated', serializeBooking(updated));
  res.json(serializeBooking(updated));
});

module.exports = router;
