// server/routes/rooms.js
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission, hasPermission } = require('../utils/permissions');
const { broadcast } = require('../ws');
const { resolveOutstanding } = require('../utils/balance');
const { assertLimit } = require('../services/entitlements');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

function serialize(room) {
  return { ...room, amenities: JSON.parse(room.amenities || '[]') };
}

// GET /api/rooms
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM rooms WHERE tenant_id = ? ORDER BY floor, number').all(req.tenantId);
  res.json(rows.map(serialize));
});

// GET /api/rooms/housekeeping/today — the housekeeping shift report: how many
// rooms were signed off clean today, per cleaner, with each room's remark.
// This is a REAL count from the log — "available rooms" is not the same thing
// (a room that was never dirty is available but was not cleaned today).
router.get('/housekeeping/today', (req, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));
  const entries = db.prepare(`
    SELECT * FROM housekeeping_log WHERE tenant_id = ? AND cleaned_date = ? ORDER BY created_at DESC
  `).all(req.tenantId, date);
  const byStaff = {};
  entries.forEach(e => {
    const name = e.staff_name || e.created_by || 'Unassigned';
    byStaff[name] = (byStaff[name] || 0) + 1;
  });
  res.json({
    date,
    count: entries.length,
    rooms: [...new Set(entries.map(e => e.room_number))],
    byStaff: Object.entries(byStaff).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    entries,
  });
});

// POST /api/rooms/:id/housekeeping/clean — sign a dirty/in-progress room off
// clean, recording WHO did it and their REMARK against the room number. The
// room status flip and the log row commit together, so the count can never
// disagree with the room board.
router.post('/:id/housekeeping/clean', requirePermission('rooms.manage'), (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.status === 'occupied') return res.status(409).json({ error: 'Room ' + room.number + ' is occupied — check the guest out before cleaning it' });
  if (room.status === 'available') return res.status(409).json({ error: 'Room ' + room.number + ' is already clean and available' });

  const remark = String((req.body && req.body.remark) || '').trim().slice(0, 500) || null;
  const staffId = (req.body && req.body.staffId) || null;
  const staff = staffId ? db.prepare('SELECT * FROM staff WHERE id = ? AND tenant_id = ?').get(staffId, req.tenantId) : null;
  const staffName = staff ? staff.name : (req.user.name || null);
  const logId = 'hkl_' + nanoid(10);
  const today = new Date().toISOString().slice(0, 10);

  db.transaction(() => {
    // Signed off: the room is nobody's to clean any more.
    db.prepare(`UPDATE rooms SET status='available', hk_staff_id=NULL, hk_staff_name=NULL, hk_assigned_at=NULL,
                updated_at=datetime('now') WHERE id=? AND tenant_id=?`).run(room.id, req.tenantId);
    db.prepare(`INSERT INTO housekeeping_log (id, tenant_id, room_id, room_number, staff_id, staff_name, remark, cleaned_date, created_by)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(logId, req.tenantId, room.id, room.number, staff ? staff.id : null, staffName, remark, today, req.user.name || null);
  })();

  const updated = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
  const entry = db.prepare('SELECT * FROM housekeeping_log WHERE id = ?').get(logId);
  audit(req, 'housekeeping.clean', 'room', room.id, { roomNumber: room.number, staffName, remark });
  broadcast(req.tenantId, 'room.updated', serialize(updated));
  broadcast(req.tenantId, 'housekeeping.updated', entry);
  res.json({ room: serialize(updated), entry });
});

// POST /api/rooms/:id/housekeeping/assign — hand a dirty room to a particular
// housekeeping staff member from the room card, without opening the
// Housekeeping module. The assignment is stored on the room (hk_staff_*), so it
// survives reloads and shows up in Housekeeping as "Being Cleaned · <name>".
// The room moves to 'cleaning'; the guest-facing status is unchanged from the
// existing quick-assign flow (PATCH status='cleaning') — this only adds WHO.
router.post('/:id/housekeeping/assign', requirePermission('rooms.manage'), (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.status === 'occupied') return res.status(409).json({ error: 'Room ' + room.number + ' is occupied — check the guest out before assigning housekeeping' });
  if (room.status === 'available') return res.status(409).json({ error: 'Room ' + room.number + ' is already clean and available — nothing to assign' });
  if (room.status !== 'cleaning' && room.status !== 'dirty') {
    return res.status(409).json({ error: 'Room ' + room.number + ' is ' + room.status + ' — resolve that before assigning housekeeping' });
  }

  const staffId = req.body && req.body.staffId ? String(req.body.staffId) : null;
  let staff = null;
  if (staffId) {
    staff = db.prepare('SELECT * FROM staff WHERE id = ? AND tenant_id = ?').get(staffId, req.tenantId);
    if (!staff) return res.status(404).json({ error: 'Staff member not found' });
    if (staff.status !== 'active') return res.status(409).json({ error: staff.name + ' is not an active staff member' });
    if (staff.department !== 'Housekeeping') return res.status(409).json({ error: staff.name + ' is not on the housekeeping team' });
  }
  // No pick = the operator takes it themselves (mirrors the Housekeeping module).
  const staffName = staff ? staff.name : (req.user.name || null);

  db.prepare(`UPDATE rooms SET status='cleaning', hk_staff_id=?, hk_staff_name=?, hk_assigned_at=datetime('now'),
              updated_at=datetime('now') WHERE id=? AND tenant_id=?`)
    .run(staff ? staff.id : null, staffName, room.id, req.tenantId);

  const updated = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
  audit(req, 'housekeeping.assign', 'room', room.id, { roomNumber: room.number, staffId: staff ? staff.id : null, staffName });
  broadcast(req.tenantId, 'room.updated', serialize(updated));
  res.json(serialize(updated));
});

// POST /api/rooms
router.post('/', requirePermission('pricing.manage'), (req, res) => {
  const { number, type, view, floor, rate, capacity, amenities, floorId, categoryId, description } = req.body;
  if (!number) return res.status(400).json({ error: 'Room number is required' });

  const existing = db.prepare('SELECT id FROM rooms WHERE tenant_id = ? AND number = ?').get(req.tenantId, number);
  if (existing) return res.status(409).json({ error: 'A room with this number already exists' });

  // SaaS plan limit — Starter caps at 20 rooms, Pro at 100 (402 on breach).
  const roomCount = db.prepare('SELECT COUNT(*) c FROM rooms WHERE tenant_id = ?').get(req.tenantId).c;
  try { assertLimit(req.tenant, 'maxRooms', roomCount); }
  catch (e) { return res.status(e.status || 402).json({ error: e.message, code: e.code, limitKey: e.limitKey, limit: e.limit, upgradeTo: e.upgradeTo }); }

  let resolvedFloor = floor || 1, resolvedType = type || 'Standard', resolvedRate = rate || 0, resolvedCapacity = capacity || 2;
  if (floorId) {
    const f = db.prepare('SELECT * FROM floors WHERE id = ? AND tenant_id = ?').get(floorId, req.tenantId);
    if (!f) return res.status(404).json({ error: 'Floor not found' });
    resolvedFloor = f.number;
  }
  if (categoryId) {
    const c = db.prepare('SELECT * FROM room_categories WHERE id = ? AND tenant_id = ?').get(categoryId, req.tenantId);
    if (!c) return res.status(404).json({ error: 'Room category not found' });
    resolvedType = type || c.name;
    resolvedRate = rate || c.weekday_rate;
    resolvedCapacity = capacity || c.capacity;
  }

  const newId = 'room_' + nanoid(10);
  db.prepare(`INSERT INTO rooms (id, tenant_id, number, type, view, floor, floor_id, category_id, rate, capacity, status, amenities, description)
              VALUES (?,?,?,?,?,?,?,?,?,?, 'available', ?,?)`)
    .run(newId, req.tenantId, number, resolvedType, view || '', resolvedFloor, floorId || null, categoryId || null, resolvedRate, resolvedCapacity, JSON.stringify(amenities || ['AC','TV','WiFi']), description || null);

  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(newId);
  audit(req, 'room.create', 'room', newId, { number });
  broadcast(req.tenantId, 'room.created', serialize(room));
  res.status(201).json(serialize(room));
});

// PATCH /api/rooms/:id
router.patch('/:id', requirePermission('rooms.manage'), (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const fields = ['number','type','view','floor','rate','capacity','status','checkout_label','issue','floor_id','category_id','description'];
  const pricingFields = ['number', 'type', 'floor', 'rate', 'capacity', 'floor_id', 'category_id'];
  const map = { floorId: 'floor_id', categoryId: 'category_id' };
  const updates = {};
  Object.entries(req.body).forEach(([k, v]) => {
    const col = map[k] || k;
    if (fields.includes(col)) updates[col] = v;
  });
  if (req.body.amenities !== undefined) updates.amenities = JSON.stringify(req.body.amenities);

  const touchesPricing = Object.keys(updates).some(k => pricingFields.includes(k));
  if (touchesPricing && !hasPermission(req.user, 'pricing.manage')) {
    return res.status(403).json({ error: 'Only a manager or owner can change room number, type, floor, rate, or capacity' });
  }
  if (updates.status === 'occupied' && room.status !== 'occupied') {
    return res.status(400).json({ error: 'Use Check-in to occupy a room — it requires a linked guest account' });
  }

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  // A status the operator set by hand is not a cleaning assignment: drop the
  // saved cleaner unless the room is still being cleaned.
  if (updates.status !== undefined && updates.status !== 'cleaning') {
    updates.hk_staff_id = null; updates.hk_staff_name = null; updates.hk_assigned_at = null;
  }

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE rooms SET ${setClause}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...updates, id: room.id });

  const updated = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
  audit(req, 'room.update', 'room', room.id, updates);
  broadcast(req.tenantId, 'room.updated', serialize(updated));
  res.json(serialize(updated));
});

// POST /api/rooms/:id/checkin
// POST /api/rooms/:id/checkin — a real Guest record is required; no "dummy" free-text guests.
router.post('/:id/checkin', requirePermission('bookings.manage'), idempotency, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.status !== 'available') return res.status(409).json({ error: 'Room is not available for check-in (currently ' + room.status + ')' });

  const { guestId } = req.body;
  if (!guestId) return res.status(400).json({ error: 'Select an existing guest, or create one first — a room cannot be checked in without a linked guest account' });
  const guest = db.prepare('SELECT * FROM guests WHERE id = ? AND tenant_id = ?').get(guestId, req.tenantId);
  if (!guest) return res.status(404).json({ error: 'Guest not found' });

  // Claim the room atomically: the UPDATE re-asserts status='available', so two
  // concurrent walk-in check-ins cannot both occupy the same room.
  let claimed = true;
  db.transaction(() => {
    const r = db.prepare(`UPDATE rooms SET status='occupied', guest_id=?, guest_name=?, updated_at=datetime('now') WHERE id=? AND status='available'`)
      .run(guest.id, guest.name, room.id);
    if (r.changes === 0) { claimed = false; return; }
    db.prepare(`UPDATE guests SET room_number = ? WHERE id = ?`).run(room.number, guest.id);
  })();
  if (!claimed) return res.status(409).json({ error: 'Room ' + room.number + ' was just taken by another check-in' });

  const updated = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
  audit(req, 'room.checkin', 'room', room.id, { guestId: guest.id, guestName: guest.name });
  broadcast(req.tenantId, 'room.updated', serialize(updated));
  res.json(serialize(updated));
});

// GET /api/rooms/:id/checkout-check — outstanding balance preview before checkout is attempted
router.get('/:id/checkout-check', (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.guest_id) return res.json({ hasGuest: false, pendingTotal: 0, pendingCount: 0, grandTotal: 0, transactions: [] });
  const balance = resolveOutstanding(req.tenantId, { roomId: room.id });
  res.json({ hasGuest: true, guestName: room.guest_name, ...balance });
});

// POST /api/rooms/:id/checkout — blocked unless the room has a real linked guest with no outstanding balance
router.post('/:id/checkout', requirePermission('bookings.manage'), idempotency, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.status !== 'occupied') return res.status(409).json({ error: 'Room is not currently occupied' });
  if (!room.guest_id) return res.status(400).json({ error: 'This room has no linked guest account on record — link a guest before it can be checked out' });

  const balance = resolveOutstanding(req.tenantId, { roomId: room.id });
  const booking = balance.booking;
  if (balance.grandTotal > 0.005 && !req.body.forceOverride) {
    return res.status(409).json({
      error: 'Guest has an outstanding balance of ' + balance.grandTotal.toFixed(2) + ' (' + balance.roomBalance.toFixed(2) + ' room + ' + balance.pendingTotal.toFixed(2) + ' other charges) — settle this before checking out',
      ...balance,
    });
  }
  if (req.body.forceOverride) {
    if (!hasPermission(req.user, 'payments.manage')) return res.status(403).json({ error: 'Only a manager or owner can check out a guest with an outstanding balance' });
    if (!req.body.overrideReason || !req.body.overrideReason.trim()) return res.status(400).json({ error: 'A written reason is required to override checkout with an outstanding balance' });
  }

  // Checked out → dirty for housekeeping, with no cleaner carried over from
  // the previous stay: the room card offers a fresh assignment.
  db.prepare(`UPDATE rooms SET status='dirty', guest_id=NULL, guest_name=NULL, checkout_label=NULL,
              hk_staff_id=NULL, hk_staff_name=NULL, hk_assigned_at=NULL, updated_at=datetime('now') WHERE id=?`).run(room.id);

  // If this room belonged to a booking, and every other room on that booking is
  // already checked out (not occupied), the booking itself is now fully checked out.
  if (booking) {
    const otherRoomIds = db.prepare('SELECT room_id FROM booking_rooms WHERE booking_id = ?').all(booking.id).map(r => r.room_id);
    const stillOccupied = otherRoomIds.some(rid => {
      if (rid === room.id) return false; // this one was just checked out above
      const r = db.prepare('SELECT status FROM rooms WHERE id = ?').get(rid);
      return r && r.status === 'occupied';
    });
    if (!stillOccupied) {
      db.prepare(`UPDATE bookings SET status='checked_out', updated_at=datetime('now') WHERE id=?`).run(booking.id);
      broadcast(req.tenantId, 'booking.updated', db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id));
    }
  }

  const updated = db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id);
  audit(req, 'room.checkout', 'room', room.id, {
    forced: !!req.body.forceOverride, grandTotal: balance.grandTotal,
    overrideReason: req.body.forceOverride ? req.body.overrideReason.trim() : undefined,
    guestName: room.guest_name,
  });
  broadcast(req.tenantId, 'room.updated', serialize(updated));
  res.json(serialize(updated));
});

// DELETE /api/rooms/:id — inventory change, so it needs pricing.manage (owner/manager),
// and it must not silently strip rooms out from under live reservations:
// booking_rooms cascades on delete, which would leave the booking with no rooms
// while still holding a balance.
router.delete('/:id', requirePermission('pricing.manage'), (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.status === 'occupied') return res.status(409).json({ error: 'Room ' + room.number + ' is occupied — check the guest out before deleting it' });
  const live = db.prepare(`
    SELECT COUNT(*) c FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id
    WHERE br.room_id = ? AND b.status IN ('confirmed','checked_in')
  `).get(room.id).c;
  if (live > 0) return res.status(409).json({ error: 'Room ' + room.number + ' has ' + live + ' active reservation(s) — cancel or move them first' });
  db.prepare('DELETE FROM rooms WHERE id = ?').run(room.id);
  audit(req, 'room.delete', 'room', room.id);
  broadcast(req.tenantId, 'room.deleted', { id: room.id });
  res.json({ ok: true });
});

module.exports = router;
