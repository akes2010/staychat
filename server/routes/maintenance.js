// server/routes/maintenance.js
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { broadcast } = require('../ws');
const { requirePermission } = require('../utils/permissions');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM maintenance_requests WHERE tenant_id = ? ORDER BY created_at DESC').all(req.tenantId);
  res.json(rows);
});

// Writes require the same capability the Maintenance page itself is gated by
// (maintenance.manage) — read stays open to all authenticated staff so the
// dashboard and task lists render everywhere they already do.
router.post('/', requirePermission('maintenance.manage'), (req, res) => {
  const { roomNumber, issue, priority } = req.body;
  if (!roomNumber || !issue) return res.status(400).json({ error: 'roomNumber and issue are required' });
  const id = 'maint_' + nanoid(10);
  db.prepare(`INSERT INTO maintenance_requests (id, tenant_id, room_number, issue, priority, status) VALUES (?,?,?,?,?, 'pending')`)
    .run(id, req.tenantId, roomNumber, issue, priority || 'medium');
  const reqRow = db.prepare('SELECT * FROM maintenance_requests WHERE id = ?').get(id);
  audit(req, 'maintenance.create', 'maintenance_request', id, { roomNumber });
  broadcast(req.tenantId, 'maintenance.created', reqRow);
  res.status(201).json(reqRow);
});

router.patch('/:id', requirePermission('maintenance.manage'), (req, res) => {
  const item = db.prepare('SELECT * FROM maintenance_requests WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!item) return res.status(404).json({ error: 'Request not found' });

  const fields = ['roomNumber','issue','priority','status','assignee'];
  const colMap = { roomNumber: 'room_number' };
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[colMap[f] || f] = req.body[f]; });
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE maintenance_requests SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: item.id });
  const updated = db.prepare('SELECT * FROM maintenance_requests WHERE id = ?').get(item.id);
  audit(req, 'maintenance.update', 'maintenance_request', item.id, updates);
  broadcast(req.tenantId, 'maintenance.updated', updated);
  res.json(updated);
});

router.delete('/:id', requirePermission('maintenance.manage'), (req, res) => {
  const item = db.prepare('SELECT * FROM maintenance_requests WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!item) return res.status(404).json({ error: 'Request not found' });
  db.prepare('DELETE FROM maintenance_requests WHERE id = ?').run(item.id);
  audit(req, 'maintenance.delete', 'maintenance_request', item.id);
  res.json({ ok: true });
});

module.exports = router;
