// server/routes/blocklist.js
// Per-tenant blocked phone numbers. A desk-level spam/abuse control: a blocked
// phone can never submit a booking through the self-OTA engine (rooms, halls or
// pool). Desk-visible CRUD; writes are guests.manage (front desk owns guest
// data everywhere else in the app), deletes included.
'use strict';

const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

// ── Normalisation ───────────────────────────────────────────────────────────
// Compare on the LAST 10 significant digits. WhatsApp hands the desk E.164
// (+2348099999999) while hotel staff type local formats (08099999999 or
// 8099999999) — stripping a trunk zero does NOT reconcile those, because the
// country code 234 remains. The last 10 digits are the local-number part and
// are identical across all spellings, so that is the match key.
function normalizePhone(raw) {
  return String(raw || '').replace(/[^\d]/g, '');
}

/** Match key for a phone: last 10 digits, or the digits when shorter. */
function phoneKey(raw) {
  const digits = normalizePhone(raw);
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Is this phone blocked for the tenant? Used by the booking-engine service. */
function isBlocked(tenantId, phone) {
  const key = phoneKey(phone);
  if (!key) return false;
  const rows = db.prepare('SELECT phone FROM blocked_numbers WHERE tenant_id = ?').all(tenantId);
  return rows.some(r => phoneKey(r.phone) === key);
}

function serialize(row) {
  return { ...row, phoneOriginal: row.phone, blockedBy: row.blocked_by, createdAt: row.created_at };
}

// GET /api/blocklist — full list, newest first
router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM blocked_numbers WHERE tenant_id = ? ORDER BY created_at DESC').all(req.tenantId).map(serialize));
});

// POST /api/blocklist — add a number
router.post('/', requirePermission('guests.manage'), (req, res) => {
  const { phone, reason } = req.body || {};
  if (!phoneKey(phone)) return res.status(400).json({ error: 'A phone number is required' });

  // Idempotent on purpose: re-blocking an already blocked number is a no-op
  // (returns the existing row) instead of a UNIQUE-constraint 500.
  const existing = db.prepare('SELECT * FROM blocked_numbers WHERE tenant_id = ?').all(req.tenantId)
    .find(r => phoneKey(r.phone) === phoneKey(phone));
  if (existing) return res.json(serialize(existing));

  const id = 'blk_' + nanoid(10);
  db.prepare('INSERT INTO blocked_numbers (id, tenant_id, phone, reason, blocked_by) VALUES (?,?,?,?,?)')
    .run(id, req.tenantId, String(phone).trim(), (reason && String(reason).trim()) || null, req.user.name);
  audit(req, 'blocklist.add', 'blocked_number', id, { phone: String(phone).trim() });
  res.status(201).json(serialize(db.prepare('SELECT * FROM blocked_numbers WHERE id = ?').get(id)));
});

// DELETE /api/blocklist/:id — unblock
router.delete('/:id', requirePermission('guests.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM blocked_numbers WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!row) return res.status(404).json({ error: 'Blocked number not found' });
  db.prepare('DELETE FROM blocked_numbers WHERE id = ?').run(row.id);
  audit(req, 'blocklist.remove', 'blocked_number', row.id, { phone: row.phone });
  res.json({ ok: true });
});

module.exports = router;
module.exports.isBlocked = isBlocked;
module.exports.normalizePhone = normalizePhone;
module.exports.phoneKey = phoneKey;
module.exports.phoneKey = phoneKey;
