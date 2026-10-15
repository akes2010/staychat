// server/routes/guests.js
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

// READ is deliberately open to every authenticated staff member (POS customer
// bills, check-in guest pickers and booking forms all consume the guest list),
// but writes are floored at guests.manage — loyalty balances and the guest
// ledger are money-adjacent, and minimal roles (cashier, barman, staff) must
// not be able to rewrite or erase guest records via the API.
function serialize(g) {
  return { ...g, preferences: JSON.parse(g.preferences || '[]') };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM guests WHERE tenant_id = ? ORDER BY created_at DESC').all(req.tenantId);
  res.json(rows.map(serialize));
});

router.get('/:id', (req, res) => {
  const g = db.prepare('SELECT * FROM guests WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!g) return res.status(404).json({ error: 'Guest not found' });
  res.json(serialize(g));
});

router.post('/', requirePermission('rooms.manage'), idempotency, (req, res) => {
  const { name, phone, email, roomNumber, checkInDate, checkOutDate } = req.body;
  if (!name) return res.status(400).json({ error: 'Guest name is required' });
  const id = 'guest_' + nanoid(10);
  db.prepare(`INSERT INTO guests (id, tenant_id, name, phone, email, room_number, loyalty_tier, loyalty_points, stays, total_spent, preferences, check_in_date, check_out_date)
              VALUES (?,?,?,?,?,?, 'Bronze', 0, 1, 0, '[]', ?, ?)`)
    .run(id, req.tenantId, name, phone || null, email || null, roomNumber || null, checkInDate || null, checkOutDate || null);
  const g = db.prepare('SELECT * FROM guests WHERE id = ?').get(id);
  audit(req, 'guest.create', 'guest', id, { name });
  res.status(201).json(serialize(g));
});

router.patch('/:id', requirePermission('guests.manage'), (req, res) => {
  const g = db.prepare('SELECT * FROM guests WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!g) return res.status(404).json({ error: 'Guest not found' });

  const fieldMap = { name:'name', phone:'phone', email:'email', roomNumber:'room_number', loyaltyTier:'loyalty_tier',
    loyaltyPoints:'loyalty_points', stays:'stays', totalSpent:'total_spent', checkInDate:'check_in_date', checkOutDate:'check_out_date' };
  const updates = {};
  Object.entries(fieldMap).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = req.body[bodyKey]; });
  if (req.body.preferences !== undefined) updates.preferences = JSON.stringify(req.body.preferences);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE guests SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: g.id });
  const updated = db.prepare('SELECT * FROM guests WHERE id = ?').get(g.id);
  audit(req, 'guest.update', 'guest', g.id, updates);
  res.json(serialize(updated));
});

router.post('/:id/loyalty/add', requirePermission('guests.manage'), (req, res) => {
  const g = db.prepare('SELECT * FROM guests WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!g) return res.status(404).json({ error: 'Guest not found' });
  const points = Number(req.body.points || 100);
  db.prepare(`UPDATE guests SET loyalty_points = loyalty_points + ?, updated_at = datetime('now') WHERE id = ?`).run(points, g.id);
  const updated = db.prepare('SELECT * FROM guests WHERE id = ?').get(g.id);
  audit(req, 'guest.loyalty_add', 'guest', g.id, { points });
  res.json(serialize(updated));
});

router.delete('/:id', requirePermission('guests.manage'), (req, res) => {
  const g = db.prepare('SELECT * FROM guests WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!g) return res.status(404).json({ error: 'Guest not found' });
  db.prepare('DELETE FROM guests WHERE id = ?').run(g.id);
  audit(req, 'guest.delete', 'guest', g.id);
  res.json({ ok: true });
});

module.exports = router;
