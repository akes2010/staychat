// server/routes/pool.js
// Pool Booking module — guests reserve a time slot at the pool. Capacity per
// tenant (tenants.pool_capacity) caps how many concurrent guests can be booked
// into overlapping time slots on the same day.
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { broadcast } = require('../ws');
const { requirePermission, hasPermission } = require('../utils/permissions');
const { requireEntitlement } = require('../services/entitlements');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('pool.use'), requireEntitlement('pool_bookings'));

// GET /api/pool?date=YYYY-MM-DD
router.get('/', (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const rows = db.prepare('SELECT * FROM pool_bookings WHERE tenant_id = ? AND date = ? ORDER BY start_time ASC').all(req.tenantId, date);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM pool_bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Pool booking not found' });
  res.json(b);
});

function overlappingHeadcount(tenantId, date, startTime, endTime, excludeId) {
  const rows = db.prepare(`
    SELECT * FROM pool_bookings WHERE tenant_id = ? AND date = ? AND status IN ('confirmed','checked_in')
      AND NOT (end_time <= ? OR start_time >= ?)
  `).all(tenantId, date, startTime, endTime);
  return rows.filter(r => r.id !== excludeId).reduce((s, r) => s + r.party_size, 0);
}

// POST /api/pool — create a booking
router.post('/', (req, res) => {
  const { guestName, guestPhone, roomNumber, guestId, date, startTime, endTime, partySize, area, price, notes, poolId } = req.body;
  if (!guestName || !date || !startTime || !endTime) return res.status(400).json({ error: 'guestName, date, startTime and endTime are required' });
  if (endTime <= startTime) return res.status(400).json({ error: 'endTime must be after startTime' });

  let resolvedArea = area || 'Main Pool', resolvedPrice = price;
  if (poolId) {
    const pool = db.prepare('SELECT * FROM pools WHERE id = ? AND tenant_id = ?').get(poolId, req.tenantId);
    if (!pool) return res.status(404).json({ error: 'Pool not found' });
    resolvedArea = pool.name;
    resolvedPrice = price !== undefined ? price : pool.price;
  }

  const size = Math.max(1, Number(partySize) || 1);
  const capacity = req.tenant.pool_capacity || 20;
  const current = overlappingHeadcount(req.tenantId, date, startTime, endTime);
  if (current + size > capacity) {
    return res.status(409).json({ error: 'Pool capacity (' + capacity + ') would be exceeded for that time slot — ' + current + ' already booked' });
  }

  const id = 'pool_' + nanoid(10);
  db.prepare(`INSERT INTO pool_bookings (id, tenant_id, guest_name, guest_phone, room_number, guest_id, date, start_time, end_time, party_size, area, pool_id, price, created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, guestName, guestPhone || null, roomNumber || null, guestId || null, date, startTime, endTime, size, resolvedArea, poolId || null, Number(resolvedPrice) || 0, req.user.name);
  if (notes) db.prepare('UPDATE pool_bookings SET notes = ? WHERE id = ?').run(notes, id);

  const booking = db.prepare('SELECT * FROM pool_bookings WHERE id = ?').get(id);
  audit(req, 'pool.create', 'pool_booking', id, { date, startTime, endTime });
  broadcast(req.tenantId, 'pool.created', booking);
  res.status(201).json(booking);
});

// PATCH /api/pool/:id
router.patch('/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM pool_bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Pool booking not found' });

  const fields = ['guest_name', 'guest_phone', 'room_number', 'date', 'start_time', 'end_time', 'party_size', 'area', 'price', 'paid', 'status', 'notes'];
  const map = { guestName: 'guest_name', guestPhone: 'guest_phone', roomNumber: 'room_number', startTime: 'start_time', endTime: 'end_time', partySize: 'party_size' };
  const updates = {};
  Object.entries(req.body).forEach(([k, v]) => {
    const col = map[k] || (fields.includes(k) ? k : null);
    if (col && fields.includes(col)) updates[col] = v;
  });
  if ((updates.price !== undefined || updates.paid !== undefined) && !hasPermission(req.user, 'pool.manage')) {
    return res.status(403).json({ error: 'Only a manager or owner can change the price or paid status of a pool booking' });
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  // Re-check capacity if the slot/size is changing
  const nextDate = updates.date || b.date, nextStart = updates.start_time || b.start_time, nextEnd = updates.end_time || b.end_time;
  const nextSize = updates.party_size !== undefined ? Number(updates.party_size) : b.party_size;
  if (updates.date || updates.start_time || updates.end_time || updates.party_size !== undefined) {
    const capacity = req.tenant.pool_capacity || 20;
    const current = overlappingHeadcount(req.tenantId, nextDate, nextStart, nextEnd, b.id);
    if (current + nextSize > capacity) return res.status(409).json({ error: 'Pool capacity would be exceeded for that time slot' });
  }

  if (updates.paid !== undefined) updates.paid = updates.paid ? 1 : 0;
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE pool_bookings SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: b.id });

  const updated = db.prepare('SELECT * FROM pool_bookings WHERE id = ?').get(b.id);
  audit(req, 'pool.update', 'pool_booking', b.id, updates);
  broadcast(req.tenantId, 'pool.updated', updated);
  res.json(updated);
});

// POST /api/pool/:id/checkin | /checkout | /cancel | /no-show
['checkin', 'checkout', 'cancel', 'no-show'].forEach(action => {
  const statusMap = { checkin: 'checked_in', checkout: 'completed', cancel: 'cancelled', 'no-show': 'no_show' };
  const guard = action === 'cancel' ? [requirePermission('pool.manage')] : [];
  router.post('/:id/' + action, ...guard, (req, res) => {
    const b = db.prepare('SELECT * FROM pool_bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
    if (!b) return res.status(404).json({ error: 'Pool booking not found' });
    db.prepare(`UPDATE pool_bookings SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(statusMap[action], b.id);
    const updated = db.prepare('SELECT * FROM pool_bookings WHERE id = ?').get(b.id);
    audit(req, 'pool.' + action, 'pool_booking', b.id);
    broadcast(req.tenantId, 'pool.updated', updated);
    res.json(updated);
  });
});

module.exports = router;
