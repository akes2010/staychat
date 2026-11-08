// server/routes/training.js
// In-app welcome & training tracker — the digital version of the one-page
// checklist PDF. One JSON document per hotel: setup/orientation tick-offs,
// per-role trainer sign-off (trainer, date, notes) and the go-live sign-off.
// Kept as a single tenant-scoped blob because the checklist is a form, not
// relational data; it grows only when the printed checklist does.
'use strict';

const express = require('express');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, requireRole, audit } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant, requireRole('hotel_admin', 'superadmin'));

const MAX_BYTES = 64 * 1024;
const EMPTY = { trainer: '', goLiveDate: '', setup: {}, orientation: {}, roles: {}, goLive: {}, review: {} };

function readRow(tenantId) {
  const row = db.prepare('SELECT * FROM training_checklist WHERE tenant_id = ?').get(tenantId);
  if (!row) return { data: EMPTY, updatedAt: null, updatedBy: null };
  let data;
  try { data = JSON.parse(row.data || '{}'); } catch (e) { data = {}; }
  return { data: Object.assign({}, EMPTY, data), updatedAt: row.updated_at, updatedBy: row.updated_by };
}

router.get('/', (req, res) => {
  res.json(readRow(req.tenantId));
});

router.put('/', (req, res) => {
  try {
    const data = req.body && req.body.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'data must be an object' });
    }
    const json = JSON.stringify(data);
    if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) {
      return res.status(413).json({ error: 'Training checklist is too large' });
    }
    const by = (req.user && (req.user.name || req.user.email)) || null;
    db.prepare(`INSERT INTO training_checklist (tenant_id, data, updated_by, updated_at)
                VALUES (?, ?, ?, datetime('now'))
                ON CONFLICT(tenant_id) DO UPDATE SET data = excluded.data,
                  updated_by = excluded.updated_by, updated_at = datetime('now')`)
      .run(req.tenantId, json, by);
    audit(req, 'training.update', 'training_checklist', req.tenantId, {});
    res.json(readRow(req.tenantId));
  } catch (err) {
    console.error('Error saving training checklist:', err);
    res.status(500).json({ error: 'Failed to save the training checklist' });
  }
});

module.exports = router;
