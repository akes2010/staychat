// server/routes/room-setup.js
// Floor management + Room Categories with tiered pricing (weekday/weekend/holiday/discount).
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, requireRole, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

function serializeCategory(c) { return { ...c, amenities: JSON.parse(c.amenities || '[]'), active: !!c.active }; }

/**
 * Effective nightly rate for a category on a given date:
 *   festive > holiday > weekend > weekday, then a flat discount_pct is applied on top.
 * A "holiday" row's `type` column distinguishes a regular holiday from a premium
 * "festive" date (e.g. Christmas, New Year's Eve) which uses the higher festive_rate.
 */
function effectiveRate(category, dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const holidayRow = db.prepare('SELECT * FROM holidays WHERE tenant_id = ? AND date = ?').get(category.tenant_id, dateStr);
  const isFestive = holidayRow && holidayRow.type === 'festive';
  const isHoliday = holidayRow && holidayRow.type !== 'festive';
  const isWeekend = d.getDay() === 0 || d.getDay() === 6;

  let base = category.weekday_rate;
  let tier = 'weekday';
  if (isWeekend) { base = category.weekend_rate || category.weekday_rate; tier = 'weekend'; }
  if (isHoliday) { base = category.holiday_rate || category.weekend_rate || category.weekday_rate; tier = 'holiday'; }
  if (isFestive) { base = category.festive_rate || category.holiday_rate || category.weekend_rate || category.weekday_rate; tier = 'festive'; }

  const discount = base * (category.discount_pct || 0) / 100;
  return { date: dateStr, tier, baseRate: base, discountAmount: discount, rate: Math.max(0, base - discount) };
}

// ── Floors ────────────────────────────────────────────────────────────
router.get('/floors', (req, res) => {
  const rows = db.prepare('SELECT * FROM floors WHERE tenant_id = ? ORDER BY number').all(req.tenantId);
  const withCounts = rows.map(f => ({ ...f, roomCount: db.prepare('SELECT COUNT(*) c FROM rooms WHERE tenant_id = ? AND floor_id = ?').get(req.tenantId, f.id).c }));
  res.json(withCounts);
});

router.post('/floors', requirePermission('pricing.manage'), (req, res) => {
  const { number, name, description } = req.body;
  if (number === undefined || !name) return res.status(400).json({ error: 'number and name are required' });
  const existing = db.prepare('SELECT id FROM floors WHERE tenant_id = ? AND number = ?').get(req.tenantId, number);
  if (existing) return res.status(409).json({ error: 'A floor with this number already exists' });
  const id = 'floor_' + nanoid(10);
  db.prepare('INSERT INTO floors (id, tenant_id, number, name, description) VALUES (?,?,?,?,?)').run(id, req.tenantId, Number(number), name, description || null);
  const floor = db.prepare('SELECT * FROM floors WHERE id = ?').get(id);
  audit(req, 'floor.create', 'floor', id, { name });
  res.status(201).json(floor);
});

router.patch('/floors/:id', requirePermission('pricing.manage'), (req, res) => {
  const floor = db.prepare('SELECT * FROM floors WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!floor) return res.status(404).json({ error: 'Floor not found' });
  const updates = {};
  ['number', 'name', 'description'].forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE floors SET ${setClause} WHERE id = @id`).run({ ...updates, id: floor.id });
  res.json(db.prepare('SELECT * FROM floors WHERE id = ?').get(floor.id));
});

router.delete('/floors/:id', requirePermission('pricing.manage'), (req, res) => {
  const floor = db.prepare('SELECT * FROM floors WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!floor) return res.status(404).json({ error: 'Floor not found' });
  const roomCount = db.prepare('SELECT COUNT(*) c FROM rooms WHERE floor_id = ?').get(floor.id).c;
  if (roomCount > 0) return res.status(409).json({ error: 'Move or delete the ' + roomCount + ' room(s) on this floor first' });
  db.prepare('DELETE FROM floors WHERE id = ?').run(floor.id);
  audit(req, 'floor.delete', 'floor', floor.id);
  res.json({ ok: true });
});

// ── Room Categories (tiered pricing) ────────────────────────────────────
router.get('/categories', (req, res) => {
  const rows = db.prepare('SELECT * FROM room_categories WHERE tenant_id = ? ORDER BY name').all(req.tenantId);
  res.json(rows.map(serializeCategory));
});

router.get('/categories/:id/rate', (req, res) => {
  const category = db.prepare('SELECT * FROM room_categories WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!category) return res.status(404).json({ error: 'Category not found' });
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  res.json(effectiveRate(category, date));
});

router.post('/categories', requirePermission('pricing.manage'), (req, res) => {
  const { name, description, weekdayRate, weekendRate, holidayRate, festiveRate, discountPct, capacity, amenities } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = 'roomcat_' + nanoid(10);
  db.prepare(`INSERT INTO room_categories (id, tenant_id, name, description, weekday_rate, weekend_rate, holiday_rate, festive_rate, discount_pct, capacity, amenities)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, name, description || null, Number(weekdayRate) || 0, Number(weekendRate) || Number(weekdayRate) || 0,
         Number(holidayRate) || Number(weekendRate) || Number(weekdayRate) || 0, Number(festiveRate) || Number(holidayRate) || Number(weekendRate) || Number(weekdayRate) || 0,
         Number(discountPct) || 0, Number(capacity) || 2, JSON.stringify(amenities || []));
  const category = db.prepare('SELECT * FROM room_categories WHERE id = ?').get(id);
  audit(req, 'roomcategory.create', 'room_category', id, { name });
  res.status(201).json(serializeCategory(category));
});

router.patch('/categories/:id', requirePermission('pricing.manage'), (req, res) => {
  const category = db.prepare('SELECT * FROM room_categories WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!category) return res.status(404).json({ error: 'Category not found' });
  const map = { name: 'name', description: 'description', weekdayRate: 'weekday_rate', weekendRate: 'weekend_rate', holidayRate: 'holiday_rate', festiveRate: 'festive_rate', discountPct: 'discount_pct', capacity: 'capacity', active: 'active' };
  const updates = {};
  Object.entries(map).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = bodyKey === 'active' ? (req.body[bodyKey] ? 1 : 0) : req.body[bodyKey]; });
  if (req.body.amenities !== undefined) updates.amenities = JSON.stringify(req.body.amenities);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE room_categories SET ${setClause} WHERE id = @id`).run({ ...updates, id: category.id });
  const updated = db.prepare('SELECT * FROM room_categories WHERE id = ?').get(category.id);
  audit(req, 'roomcategory.update', 'room_category', category.id, updates);
  res.json(serializeCategory(updated));
});

router.delete('/categories/:id', requirePermission('pricing.manage'), (req, res) => {
  const category = db.prepare('SELECT * FROM room_categories WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!category) return res.status(404).json({ error: 'Category not found' });
  const roomCount = db.prepare('SELECT COUNT(*) c FROM rooms WHERE category_id = ?').get(category.id).c;
  if (roomCount > 0) return res.status(409).json({ error: 'Reassign the ' + roomCount + ' room(s) in this category first' });
  db.prepare('DELETE FROM room_categories WHERE id = ?').run(category.id);
  audit(req, 'roomcategory.delete', 'room_category', category.id);
  res.json({ ok: true });
});

// ── Holidays ─────────────────────────────────────────────────────────
router.get('/holidays', (req, res) => {
  res.json(db.prepare('SELECT * FROM holidays WHERE tenant_id = ? ORDER BY date').all(req.tenantId));
});
router.post('/holidays', requirePermission('pricing.manage'), (req, res) => {
  const { date, name, type } = req.body;
  if (!date || !name) return res.status(400).json({ error: 'date and name are required' });
  const id = 'hol_' + nanoid(10);
  try {
    db.prepare('INSERT INTO holidays (id, tenant_id, date, name, type) VALUES (?,?,?,?,?)').run(id, req.tenantId, date, name, type === 'festive' ? 'festive' : 'holiday');
  } catch (e) {
    return res.status(409).json({ error: 'A holiday is already set for that date' });
  }
  res.status(201).json(db.prepare('SELECT * FROM holidays WHERE id = ?').get(id));
});
router.delete('/holidays/:id', requirePermission('pricing.manage'), (req, res) => {
  const h = db.prepare('SELECT * FROM holidays WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!h) return res.status(404).json({ error: 'Holiday not found' });
  db.prepare('DELETE FROM holidays WHERE id = ?').run(h.id);
  res.json({ ok: true });
});

// ── Pools (categorized bookable pool areas) ─────────────────────────────
router.get('/pools', (req, res) => {
  const rows = db.prepare('SELECT * FROM pools WHERE tenant_id = ? ORDER BY name').all(req.tenantId);
  res.json(rows.map(p => ({ ...p, active: !!p.active })));
});

router.post('/pools', requirePermission('pool.manage'), (req, res) => {
  const { name, category, description, price, capacity } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = 'pool_' + nanoid(10);
  db.prepare('INSERT INTO pools (id, tenant_id, name, category, description, price, capacity) VALUES (?,?,?,?,?,?,?)')
    .run(id, req.tenantId, name, category || 'Standard', description || null, Number(price) || 0, Number(capacity) || 20);
  const pool = db.prepare('SELECT * FROM pools WHERE id = ?').get(id);
  audit(req, 'pool.create', 'pool', id, { name });
  res.status(201).json({ ...pool, active: !!pool.active });
});

router.patch('/pools/:id', requirePermission('pool.manage'), (req, res) => {
  const pool = db.prepare('SELECT * FROM pools WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!pool) return res.status(404).json({ error: 'Pool not found' });
  const map = { name: 'name', category: 'category', description: 'description', price: 'price', capacity: 'capacity', active: 'active' };
  const updates = {};
  Object.entries(map).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = bodyKey === 'active' ? (req.body[bodyKey] ? 1 : 0) : req.body[bodyKey]; });
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE pools SET ${setClause} WHERE id = @id`).run({ ...updates, id: pool.id });
  const updated = db.prepare('SELECT * FROM pools WHERE id = ?').get(pool.id);
  audit(req, 'pool.update', 'pool', pool.id, updates);
  res.json({ ...updated, active: !!updated.active });
});

router.delete('/pools/:id', requirePermission('pool.manage'), (req, res) => {
  const pool = db.prepare('SELECT * FROM pools WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!pool) return res.status(404).json({ error: 'Pool not found' });
  const upcoming = db.prepare(`SELECT COUNT(*) c FROM pool_bookings WHERE pool_id = ? AND status IN ('confirmed','checked_in') AND date >= date('now')`).get(pool.id).c;
  if (upcoming > 0) return res.status(409).json({ error: 'Cancel or complete the ' + upcoming + ' upcoming booking(s) for this pool first' });
  db.prepare('DELETE FROM pools WHERE id = ?').run(pool.id);
  audit(req, 'pool.delete', 'pool', pool.id);
  res.json({ ok: true });
});

module.exports = { router, effectiveRate };
