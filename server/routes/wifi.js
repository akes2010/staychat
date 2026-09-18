// server/routes/wifi.js
// Per-room guest Wi-Fi sessions tied to bookings.
// Staff (bookings.manage) provision on check-in or manually, extend for late
// stays, and revoke on early departure. Guests can self-serve credentials with
// their room number + booking reference (both printed on the key sleeve).
'use strict';

const express = require('express');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { hasPermission, requirePermission } = require('../utils/permissions');
const { requireEntitlement } = require('../services/entitlements');
const { decrypt } = require('../utils/crypto-store');
const wifi = require('../services/wifi');
const { broadcast } = require('../ws');

const router = express.Router();

function serialize(row, { withPassword = false } = {}) {
  const out = {
    id: row.id,
    bookingId: row.booking_id,
    roomNumber: row.room_number,
    guestName: row.guest_name,
    controller: row.controller,
    identity: row.identity,
    speedDownMbps: row.speed_down_mbps,
    speedUpMbps: row.speed_up_mbps,
    quotaGb: row.quota_gb,
    status: row.status,
    auto: !!row.auto,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    createdAt: row.created_at,
  };
  if (withPassword && row.password_enc) out.password = decrypt(row.password_enc);
  return out;
}

function getProvision(req, res) {
  const row = db.prepare('SELECT * FROM wifi_provisions WHERE id = ? AND tenant_id = ?')
    .get(req.params.id, req.tenantId);
  if (!row) {
    res.status(404).json({ error: 'Wi-Fi provision not found' });
    return null;
  }
  return row;
}

// ── Staff endpoints (front desk owns guest access) ─────────────────────────

// GET /api/wifi — all sessions, newest first (?status=active to filter)
router.get('/', requireAuth, resolveTenant, requireTenant, requirePermission('bookings.manage'), (req, res) => {
  const { status, bookingId } = req.query;
  let sql = 'SELECT * FROM wifi_provisions WHERE tenant_id = ?';
  const params = [req.tenantId];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (bookingId) { sql += ' AND booking_id = ?'; params.push(bookingId); }
  sql += ' ORDER BY created_at DESC LIMIT 500';
  res.json(db.prepare(sql).all(...params).map(r => serialize(r)));
});

// POST /api/wifi — provision for a booking (auto on check-in; manual here)
router.post('/', requireAuth, resolveTenant, requireTenant, requirePermission('bookings.manage'), requireEntitlement('guest_wifi'), async (req, res) => {
  const { bookingId, mac, speedDown, speedUp, quotaGb } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'bookingId is required' });

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(bookingId, req.tenantId);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status === 'checked_out' || booking.status === 'cancelled') {
    return res.status(409).json({ error: `Cannot provision Wi-Fi for a ${booking.status.replace('_', ' ')} booking` });
  }

  try {
    const result = await wifi.provisionForBooking(req.tenantId, booking, {
      mac: mac || null,
      speedDown: speedDown ? Number(speedDown) : null,
      speedUp: speedUp ? Number(speedUp) : null,
      quotaGb: quotaGb !== undefined && quotaGb !== null && quotaGb !== '' ? Number(quotaGb) : undefined,
      grantedBy: req.user.id,
      auto: false,
    });
    audit(req, 'wifi.provision', 'wifi', result.id, {
      bookingId, room: result.room_number, controller: result.controller,
      reused: !!result.reused, pushed: !!(result.push && result.push.pushed),
    });
    broadcast(req.tenantId, 'wifi.updated', serialize(result));
    res.status(result.reused ? 200 : 201).json(serialize(result, { withPassword: true }));
  } catch (e) {
    res.status(500).json({ error: e.message || 'Wi-Fi provisioning failed' });
  }
});

// ── Guest self-service ───────────────────────────────────────────────────────
// GET /api/wifi/my?room=101&reference=BK-XXXX — both values are printed on the
// key sleeve; knowing the pair is treated as proof of presence in the room.
// Returns only what a guest needs, and only for a live stay.
// NOTE: declared BEFORE /:id so Express doesn't route "my" into the auth'd
// detail handler.
router.get('/my', (req, res) => {
  const room = String(req.query.room || '').trim();
  const reference = String(req.query.reference || '').trim();
  if (!room || !reference) return res.status(400).json({ error: 'room and reference are required' });

  const row = db.prepare(`
    SELECT w.* FROM wifi_provisions w
    JOIN bookings b ON b.id = w.booking_id
    WHERE w.tenant_id = b.tenant_id
      AND w.room_number = ? AND b.reference = ?
      AND w.status = 'active' AND b.status = 'checked_in'
    ORDER BY w.created_at DESC LIMIT 1
  `).get(room, reference);

  if (!row) return res.status(404).json({ error: 'No active Wi-Fi session for that room and reference' });
  res.json({
    roomNumber: row.room_number,
    identity: row.identity,
    password: row.password_enc ? decrypt(row.password_enc) : null,
    speedDownMbps: row.speed_down_mbps,
    speedUpMbps: row.speed_up_mbps,
    expiresAt: row.expires_at,
  });
});

// GET /api/wifi/:id — detail incl. the guest password (front desk hands it over)
router.get('/:id', requireAuth, resolveTenant, requireTenant, requirePermission('bookings.manage'), (req, res) => {
  const row = getProvision(req, res);
  if (!row) return;
  res.json(serialize(row, { withPassword: true }));
});

// POST /api/wifi/:id/extend — late checkout / tier upgrade
router.post('/:id/extend', requireAuth, resolveTenant, requireTenant, requirePermission('bookings.manage'), async (req, res) => {
  const row = getProvision(req, res);
  if (!row) return;
  if (row.status !== 'active') return res.status(409).json({ error: 'Only active sessions can be extended' });

  const { expiresAt, speedDown, speedUp, quotaGb } = req.body || {};
  if (expiresAt && !/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(expiresAt)) {
    return res.status(400).json({ error: 'expiresAt must be YYYY-MM-DD or YYYY-MM-DD HH:MM' });
  }
  const result = await wifi.extendProvision(req.tenantId, row.id, {
    expiresAt: expiresAt || null,
    speedDown: speedDown ? Number(speedDown) : null,
    speedUp: speedUp ? Number(speedUp) : null,
    quotaGb: quotaGb !== undefined && quotaGb !== null && quotaGb !== '' ? Number(quotaGb) : undefined,
  });
  audit(req, 'wifi.extend', 'wifi', row.id, { expiresAt: expiresAt || undefined, speedDown: speedDown || undefined });
  broadcast(req.tenantId, 'wifi.updated', serialize(result));
  res.json(serialize(result));
});

// POST /api/wifi/:id/revoke — early departure, guest request, security
router.post('/:id/revoke', requireAuth, resolveTenant, requireTenant, requirePermission('bookings.manage'), async (req, res) => {
  const row = getProvision(req, res);
  if (!row) return;
  if (row.status !== 'active') return res.status(409).json({ error: 'Session is already ' + row.status });

  const reason = (req.body && req.body.reason) || 'manual revoke';
  await wifi.revokeProvision(req.tenantId, row.id, reason);
  audit(req, 'wifi.revoke', 'wifi', row.id, { reason });
  broadcast(req.tenantId, 'wifi.updated', serialize({ ...row, status: 'revoked' }));
  res.json(serialize(db.prepare('SELECT * FROM wifi_provisions WHERE id = ?').get(row.id)));
});

module.exports = router;
