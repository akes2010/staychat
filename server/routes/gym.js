// server/routes/gym.js
// Gym Management & Booking — fitness-centre inventory (gyms) plus their member
// registrations (gym_bookings). Each gym carries its name, type, facilities,
// capacity and the daily/monthly/yearly registration prices a member pays. A
// registration is a date-ranged membership ([start_date, end_date] inclusive,
// derived from the registration type) with per-gym capacity enforcement over
// overlapping periods — mirroring the halls/pool module structure.
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission, hasPermission } = require('../utils/permissions');
const { requireEntitlement } = require('../services/entitlements');
const { broadcast } = require('../ws');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('gym.use'), requireEntitlement('gym_bookings'));

const REGISTRATION_TYPES = ['daily', 'monthly', 'yearly'];

function serializeGym(g) { return { ...g, facilities: JSON.parse(g.facilities || '[]'), active: !!g.active }; }
function serializeRegistration(r) { return { ...r, paid: !!r.paid }; }

// ── Date helpers ─────────────────────────────────────────────────────────
// Registration periods are calendar-correct: a monthly membership bought on
// Jan 15 runs through Feb 14 (start + 1 month − 1 day, inclusive end).
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonths(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.toISOString().slice(0, 10);
}
function registrationPeriod(type, start) {
  if (type === 'monthly') return { start, end: addDays(addMonths(start, 1), -1) };
  if (type === 'yearly') return { start, end: addDays(addMonths(start, 12), -1) };
  return { start, end: start }; // daily
}
function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z').getTime()); }

// ── Gyms (inventory) ─────────────────────────────────────────────────────
router.get('/gyms', (req, res) => {
  const rows = db.prepare('SELECT * FROM gyms WHERE tenant_id = ? ORDER BY name').all(req.tenantId);
  res.json(rows.map(serializeGym));
});

router.post('/gyms', requirePermission('gym.manage'), (req, res) => {
  const { name, type, facilities, description, capacity, priceDaily, priceMonthly, priceYearly } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = 'gym_' + nanoid(10);
  db.prepare(`INSERT INTO gyms (id, tenant_id, name, type, facilities, description, capacity, price_daily, price_monthly, price_yearly)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, name, type || 'Standard', JSON.stringify(facilities || []), description || null,
         Math.max(1, Number(capacity) || 20), Number(priceDaily) || 0, Number(priceMonthly) || 0, Number(priceYearly) || 0);
  const gym = db.prepare('SELECT * FROM gyms WHERE id = ?').get(id);
  audit(req, 'gym.create', 'gym', id, { name });
  broadcast(req.tenantId, 'gym.created', serializeGym(gym));
  res.status(201).json(serializeGym(gym));
});

router.patch('/gyms/:id', requirePermission('gym.manage'), (req, res) => {
  const gym = db.prepare('SELECT * FROM gyms WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!gym) return res.status(404).json({ error: 'Gym not found' });
  const map = { name: 'name', type: 'type', description: 'description', capacity: 'capacity',
                priceDaily: 'price_daily', priceMonthly: 'price_monthly', priceYearly: 'price_yearly', active: 'active' };
  const updates = {};
  Object.entries(map).forEach(([bodyKey, col]) => {
    if (req.body[bodyKey] !== undefined) updates[col] = bodyKey === 'active' ? (req.body[bodyKey] ? 1 : 0) : req.body[bodyKey];
  });
  if (req.body.facilities !== undefined) updates.facilities = JSON.stringify(req.body.facilities || []);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE gyms SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: gym.id });
  const updated = db.prepare('SELECT * FROM gyms WHERE id = ?').get(gym.id);
  audit(req, 'gym.update', 'gym', gym.id, updates);
  broadcast(req.tenantId, 'gym.updated', serializeGym(updated));
  res.json(serializeGym(updated));
});

router.delete('/gyms/:id', requirePermission('gym.manage'), (req, res) => {
  const gym = db.prepare('SELECT * FROM gyms WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!gym) return res.status(404).json({ error: 'Gym not found' });
  const activeRegs = db.prepare(`SELECT COUNT(*) c FROM gym_bookings WHERE gym_id = ? AND status = 'active'`).get(gym.id).c;
  if (activeRegs > 0) return res.status(409).json({ error: 'Cannot delete a gym with active registrations — cancel them first' });
  db.prepare('DELETE FROM gyms WHERE id = ?').run(gym.id);
  audit(req, 'gym.delete', 'gym', gym.id);
  res.json({ ok: true });
});

// ── Gym Registrations (bookings / memberships) ───────────────────────────
// GET /api/gym/registrations?from=&to=&gymId=
router.get('/registrations', (req, res) => {
  const { from, to, gymId } = req.query;
  let sql = 'SELECT * FROM gym_bookings WHERE tenant_id = ?';
  const params = [req.tenantId];
  if (gymId) { sql += ' AND gym_id = ?'; params.push(gymId); }
  if (from) { sql += ' AND end_date >= ?'; params.push(from); }
  if (to) { sql += ' AND start_date <= ?'; params.push(to); }
  sql += ' ORDER BY start_date ASC, created_at ASC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(serializeRegistration));
});

// Active (status='active') registrations whose [start_date, end_date] period
// overlaps the candidate period — the gym's capacity is a cap on concurrent
// memberships, exactly like the pool module caps concurrent headcount.
function overlappingRegistrations(tenantId, gymId, start, end, excludeId) {
  return db.prepare(`
    SELECT COUNT(*) c FROM gym_bookings
     WHERE tenant_id = ? AND gym_id = ? AND status = 'active'
       AND NOT (end_date < ? OR start_date > ?)
       ${excludeId ? 'AND id != ?' : ''}
  `).get(...(excludeId ? [tenantId, gymId, start, end, excludeId] : [tenantId, gymId, start, end])).c;
}

router.post('/registrations', (req, res) => {
  const { gymId, memberName, memberPhone, memberEmail, roomNumber, registrationType, startDate, amount, paid, notes } = req.body;
  if (!gymId || !memberName || !registrationType || !startDate) {
    return res.status(400).json({ error: 'gymId, memberName, registrationType and startDate are required' });
  }
  if (!REGISTRATION_TYPES.includes(registrationType)) return res.status(400).json({ error: 'registrationType must be daily, monthly or yearly' });
  if (!validDate(startDate)) return res.status(400).json({ error: 'startDate must be a valid YYYY-MM-DD date' });

  const gym = db.prepare('SELECT * FROM gyms WHERE id = ? AND tenant_id = ?').get(gymId, req.tenantId);
  if (!gym) return res.status(404).json({ error: 'Gym not found' });
  if (!gym.active) return res.status(409).json({ error: gym.name + ' is not accepting registrations right now' });

  const period = registrationPeriod(registrationType, startDate);
  if (overlappingRegistrations(req.tenantId, gymId, period.start, period.end) >= gym.capacity) {
    return res.status(409).json({ error: gym.name + ' is at full capacity (' + gym.capacity + ' active members) for that period' });
  }

  // Price defaults to the gym's registration price for the chosen type; only
  // a manager can override it (same rule as pool pricing).
  const canPrice = hasPermission(req.user, 'gym.manage');
  const defaultPrice = Number(gym['price_' + registrationType]) || 0;
  const finalAmount = (canPrice && amount !== undefined) ? Number(amount) || 0 : defaultPrice;
  const finalPaid = canPrice && paid ? 1 : 0;

  const id = 'gr_' + nanoid(10);
  db.prepare(`INSERT INTO gym_bookings (id, tenant_id, gym_id, member_name, member_phone, member_email, room_number,
              registration_type, start_date, end_date, amount, paid, status, notes, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, gymId, memberName, memberPhone || null, memberEmail || null, roomNumber || null,
         registrationType, period.start, period.end, finalAmount, finalPaid, 'active', notes || null, req.user.name);

  const booking = db.prepare('SELECT * FROM gym_bookings WHERE id = ?').get(id);
  audit(req, 'gym_registration.create', 'gym_booking', id, { memberName, gymId, registrationType });
  broadcast(req.tenantId, 'gymbooking.created', serializeRegistration(booking));
  res.status(201).json(serializeRegistration(booking));
});

router.patch('/registrations/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM gym_bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Gym registration not found' });
  if (['completed', 'cancelled'].includes(b.status)) return res.status(409).json({ error: 'This registration is ' + b.status + ' and can no longer be edited' });

  const map = {
    gymId: 'gym_id', memberName: 'member_name', memberPhone: 'member_phone', memberEmail: 'member_email',
    roomNumber: 'room_number', registrationType: 'registration_type', startDate: 'start_date', notes: 'notes', status: 'status',
  };
  const updates = {};
  Object.entries(map).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = req.body[bodyKey]; });
  // amount/paid/status are not in the field map (added below), so gate on the
  // raw body keys — otherwise a non-manager could reprice a membership or
  // cancel it through PATCH, bypassing the POST /cancel manage gate.
  if ((req.body.amount !== undefined || req.body.paid !== undefined || req.body.status !== undefined) && !hasPermission(req.user, 'gym.manage')) {
    return res.status(403).json({ error: 'Only a manager or owner can change the amount, paid status or status of a gym registration' });
  }
  if (req.body.amount !== undefined) updates.amount = Number(req.body.amount) || 0;
  if (req.body.paid !== undefined) updates.paid = req.body.paid ? 1 : 0;
  if (updates.registration_type && !REGISTRATION_TYPES.includes(updates.registration_type)) {
    return res.status(400).json({ error: 'registrationType must be daily, monthly or yearly' });
  }
  if (updates.status && !['active', 'completed', 'cancelled'].includes(updates.status)) {
    return res.status(400).json({ error: 'status must be active, completed or cancelled' });
  }
  if (updates.start_date && !validDate(updates.start_date)) return res.status(400).json({ error: 'startDate must be a valid YYYY-MM-DD date' });
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  // Moving the membership re-derives its end date and re-runs the capacity
  // check against everyone ELSE currently overlapping the new period.
  const nextType = updates.registration_type || b.registration_type;
  const nextStart = updates.start_date || b.start_date;
  const nextGym = updates.gym_id || b.gym_id;
  if (updates.registration_type || updates.start_date || updates.gym_id) {
    const period = registrationPeriod(nextType, nextStart);
    updates.end_date = period.end;
    const gym = db.prepare('SELECT * FROM gyms WHERE id = ? AND tenant_id = ?').get(nextGym, req.tenantId);
    if (!gym) return res.status(404).json({ error: 'Gym not found' });
    if (overlappingRegistrations(req.tenantId, nextGym, period.start, period.end, b.id) >= gym.capacity) {
      return res.status(409).json({ error: gym.name + ' would be over its capacity (' + gym.capacity + ') for the new period' });
    }
  }

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE gym_bookings SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: b.id });
  const updated = db.prepare('SELECT * FROM gym_bookings WHERE id = ?').get(b.id);
  audit(req, 'gym_registration.update', 'gym_booking', b.id, updates);
  broadcast(req.tenantId, 'gymbooking.updated', serializeRegistration(updated));
  res.json(serializeRegistration(updated));
});

// Cancel needs pricing-level authority (mirrors halls/pool); completing a
// membership is a day-to-day desk action.
router.post('/registrations/:id/cancel', requirePermission('gym.manage'), (req, res) => {
  const b = db.prepare('SELECT * FROM gym_bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Gym registration not found' });
  db.prepare(`UPDATE gym_bookings SET status='cancelled', updated_at=datetime('now') WHERE id=?`).run(b.id);
  const updated = db.prepare('SELECT * FROM gym_bookings WHERE id = ?').get(b.id);
  audit(req, 'gym_registration.cancel', 'gym_booking', b.id);
  broadcast(req.tenantId, 'gymbooking.updated', serializeRegistration(updated));
  res.json(serializeRegistration(updated));
});

router.post('/registrations/:id/complete', (req, res) => {
  const b = db.prepare('SELECT * FROM gym_bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Gym registration not found' });
  db.prepare(`UPDATE gym_bookings SET status='completed', updated_at=datetime('now') WHERE id=?`).run(b.id);
  const updated = db.prepare('SELECT * FROM gym_bookings WHERE id = ?').get(b.id);
  audit(req, 'gym_registration.complete', 'gym_booking', b.id);
  broadcast(req.tenantId, 'gymbooking.updated', serializeRegistration(updated));
  res.json(serializeRegistration(updated));
});

module.exports = router;
