// server/routes/printers.js
// Printer setup & management: thermal receipt printers (80mm for full
// receipts, 58mm for compact tickets) for Restaurant/Bar, and A4 printers
// for the front desk (folios, invoices, registration forms).
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requirePermission('printers.manage'));

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM printers WHERE tenant_id = ? ORDER BY department, name').all(req.tenantId).map(p => ({ ...p, active: !!p.active, isDefault: !!p.is_default })));
});

router.post('/', (req, res) => {
  const { name, type, department, connection, address, isDefault } = req.body;
  if (!name || !type) return res.status(400).json({ error: 'name and type are required' });
  if (!['thermal_80', 'thermal_58', 'a4'].includes(type)) return res.status(400).json({ error: 'Invalid printer type' });
  const id = 'prn_' + nanoid(10);
  if (isDefault) db.prepare('UPDATE printers SET is_default = 0 WHERE tenant_id = ? AND department = ?').run(req.tenantId, department || 'Front Desk');
  db.prepare(`INSERT INTO printers (id, tenant_id, name, type, department, connection, address, is_default) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, req.tenantId, name, type, department || 'Front Desk', connection || 'usb', address || null, isDefault ? 1 : 0);
  const printer = db.prepare('SELECT * FROM printers WHERE id = ?').get(id);
  audit(req, 'printer.create', 'printer', id, { name, type });
  res.status(201).json({ ...printer, active: !!printer.active, isDefault: !!printer.is_default });
});

router.patch('/:id', (req, res) => {
  const printer = db.prepare('SELECT * FROM printers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  const map = { name: 'name', type: 'type', department: 'department', connection: 'connection', address: 'address', active: 'active', isDefault: 'is_default' };
  const updates = {};
  Object.entries(map).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = ['active', 'isDefault'].includes(bodyKey) ? (req.body[bodyKey] ? 1 : 0) : req.body[bodyKey]; });
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });
  if (updates.is_default) db.prepare('UPDATE printers SET is_default = 0 WHERE tenant_id = ? AND department = ?').run(req.tenantId, updates.department || printer.department);
  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE printers SET ${setClause} WHERE id = @id`).run({ ...updates, id: printer.id });
  const updated = db.prepare('SELECT * FROM printers WHERE id = ?').get(printer.id);
  res.json({ ...updated, active: !!updated.active, isDefault: !!updated.is_default });
});

router.delete('/:id', (req, res) => {
  const printer = db.prepare('SELECT * FROM printers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!printer) return res.status(404).json({ error: 'Printer not found' });
  db.prepare('DELETE FROM printers WHERE id = ?').run(printer.id);
  audit(req, 'printer.delete', 'printer', printer.id);
  res.json({ ok: true });
});

module.exports = router;
