// server/routes/booking-engine.js
// Public booking-engine API + per-tenant admin controls.
//
// Public (no auth, resolved by hotel subdomain, global rate limit applies):
//   GET  /hotels                          — hotels with the engine enabled
//   GET  /config?subdomain=               — branding + notice for the widget
//   GET  /availability?subdomain=&dates   — sellable rooms with rate-card pricing
//   POST /book                            — submit a reservation → { reference, code }
//
// Authenticated (hotel_admin/superadmin, settings.manage):
//   GET  /admin/config                    — current engine settings
//   PUT  /admin/config                    — enable/disable, notice, daily cap
'use strict';

const express = require('express');
const db = require('../db/connection');
const qrcode = require('qrcode-generator');
const { requireAuth, resolveTenant, requireTenant } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const engine = require('../services/booking-engine');
const { notifyStaffOfSubmission } = require('../services/engine-notifications');
const emailSvc = require('../services/email');
const billing = require('../services/billing');

const router = express.Router();

function engineEnabled(tenantId) {
  const cfg = db.prepare('SELECT * FROM booking_engine_config WHERE tenant_id = ?').get(tenantId);
  return !!(cfg && cfg.enabled);
}

function resolveSubdomain(req) {
  // Query param wins (widget pages pass it explicitly); else the Host header's
  // subdomain part (hotel-a.staychat.io → hotel-a).
  if (req.query.subdomain) return String(req.query.subdomain).trim().toLowerCase();
  const host = String(req.headers.host || '').split(':')[0];
  const parts = host.split('.');
  if (parts.length > 2) return parts[0].toLowerCase();
  return null;
}

function publicTenant(res, subdomain) {
  // 'trial' hotels are on a full-feature 14-day trial: their public booking
  // channel MUST work (it's the core feature they are trying). Only 'suspended'
  // (expired trial / deactivated) hotels are closed.
  const tenant = db.prepare(`SELECT * FROM tenants WHERE subdomain = ? AND status IN ('active','trial')`).get(subdomain);
  if (!tenant) {
    res.status(404).json({ error: 'Hotel not found or not accepting online bookings' });
    return null;
  }
  if (!engineEnabled(tenant.id)) {
    res.status(503).json({ error: 'Online booking is currently closed for this hotel' });
    return null;
  }
  return tenant;
}

// ── Public endpoints ────────────────────────────────────────────────────────

// GET /api/booking-engine/hotels — hotels with the engine on (guest picks one)
router.get('/hotels', (req, res) => {
  const rows = db.prepare(`
    SELECT t.id, t.name, t.subdomain, t.country, t.currency FROM tenants t
    JOIN booking_engine_config c ON c.tenant_id = t.id
    WHERE t.status = 'active' AND c.enabled = 1
    ORDER BY t.name
  `).all();
  res.json(rows);
});

// GET /api/booking-engine/config?subdomain= — branding for the widget
router.get('/config', (req, res) => {
  const subdomain = resolveSubdomain(req);
  if (!subdomain) return res.status(400).json({ error: 'subdomain is required' });
  const tenant = publicTenant(res, subdomain);
  if (!tenant) return;
  const cfg = db.prepare('SELECT notice FROM booking_engine_config WHERE tenant_id = ?').get(tenant.id);
  res.json({
    hotelName: tenant.name,
    subdomain: tenant.subdomain,
    currency: tenant.currency || '$',
    notice: cfg ? cfg.notice : null,
  });
});

// GET /api/booking-engine/availability?subdomain=&checkIn=&checkOut=
router.get('/availability', (req, res) => {
  const subdomain = resolveSubdomain(req);
  const { checkIn, checkOut } = req.query;
  if (!subdomain) return res.status(400).json({ error: 'subdomain is required' });
  if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn and checkOut are required (YYYY-MM-DD)' });
  if (new Date(checkOut) <= new Date(checkIn)) return res.status(400).json({ error: 'checkOut must be after checkIn' });
  const tenant = publicTenant(res, subdomain);
  if (!tenant) return;

  const rooms = engine.availableRooms(tenant.id, checkIn, checkOut).map(r => {
    const q = engine.quoteRoom(tenant.id, r, checkIn, checkOut);
    return {
      roomId: r.id, number: r.number, type: r.type, view: r.view, capacity: r.capacity,
      nights: q.nights, rate: q.rate, total: q.total, currency: tenant.currency || '$',
    };
  });
  res.json({ hotel: { name: tenant.name, currency: tenant.currency || '$' }, rooms });
});

// POST /api/booking-engine/book — submit a reservation
router.post('/book', (req, res) => {
  const { subdomain, guestName, guestPhone, guestEmail, checkIn, checkOut, roomIds, adults, children } = req.body || {};
  if (!subdomain) return res.status(400).json({ error: 'subdomain is required' });
  const tenant = db.prepare(`SELECT * FROM tenants WHERE subdomain = ? AND status IN ('active','trial')`).get(String(subdomain).toLowerCase());
  if (!tenant) return res.status(404).json({ error: 'Hotel not found' });
  // The widget hides itself when the engine is off — enforce it server-side too,
  // so a disabled hotel can't keep receiving direct POSTs to this endpoint.
  if (!engineEnabled(tenant.id)) return res.status(503).json({ error: 'Online booking is currently closed for this hotel' });

  try {
    const result = engine.submitBooking(tenant.id, { guestName, guestPhone, guestEmail, checkIn, checkOut, roomIds, adults, children });
    // Tell the front desk (fire-and-forget — must never delay the guest's reply).
    notifyStaffOfSubmission(tenant.id, {
      code: result.code,
      reference: result.reference,
      guestName: result.guestName,
      guestPhone: guestPhone,
      checkIn: result.checkIn,
      checkOut: result.checkOut,
      total: result.total,
    });
    // Guest confirmation email when they left one — same fire-and-forget rule.
    if (guestEmail) {
      emailSvc.sendEmail({ to: guestEmail, ...emailSvc.bookingSubmittedEmail({
        hotel: { name: tenant.name, phone: tenant.phone, email: tenant.email,
                 checkInTime: tenant.check_in_time, checkOutTime: tenant.check_out_time },
        guestName: result.guestName,
        reference: result.reference,
        code: result.code,
        checkIn: result.checkIn,
        checkOut: result.checkOut,
        rooms: result.rooms.map(r => r.number).join(', '),
        total: result.total,
        currency: tenant.currency || '$',
        confirmationUrl: billing.resolvePlatformBaseUrl(req) + '/confirmation.html?hotel=' + encodeURIComponent(tenant.subdomain) + '&code=' + encodeURIComponent(result.code),
      }) }).catch(() => {});
    }
    res.status(201).json({
      ...result,
      message: 'Reservation received. Present code ' + result.code + ' at the front desk to confirm your booking.',
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/booking-engine/confirmation?subdomain=&code=BE-XXX
// Printable confirmation: the tender code (or reference+phone pair) is the
// proof-of-booking secret, exactly like an airline PNR. Returns only what a
// confirmation slip needs — no internal ids, no tenant columns.
router.get('/confirmation', (req, res) => {
  const subdomain = resolveSubdomain(req);
  const { code, reference, phone } = req.query;
  if (!subdomain) return res.status(400).json({ error: 'subdomain is required' });
  if (!code && !(reference && phone)) {
    return res.status(400).json({ error: 'Provide the booking code, or reference together with the phone number used to book' });
  }
  const tenant = db.prepare('SELECT * FROM tenants WHERE subdomain = ?').get(subdomain);
  if (!tenant) return res.status(404).json({ error: 'Hotel not found' });

  let booking;
  if (code) {
    booking = db.prepare('SELECT * FROM bookings WHERE tenant_id = ? AND engine_code = ?')
      .get(tenant.id, String(code).trim().toUpperCase());
  } else {
    booking = db.prepare('SELECT * FROM bookings WHERE tenant_id = ? AND reference = ? AND guest_phone = ? AND engine_code IS NOT NULL')
      .get(tenant.id, String(reference).trim().toUpperCase(), String(phone).trim());
  }
  if (!booking) return res.status(404).json({ error: 'Booking not found — check the code (or reference and phone) and try again' });

  const rooms = db.prepare('SELECT room_number, rate FROM booking_rooms WHERE booking_id = ?').all(booking.id);
  res.json({
    hotel: {
      name: tenant.name,
      address: tenant.country || '',
      phone: tenant.phone || '',
      email: tenant.email || '',
      checkInTime: tenant.check_in_time || '14:00',
      checkOutTime: tenant.check_out_time || '11:00',
      currency: tenant.currency || '$',
    },
    reference: booking.reference,
    code: booking.engine_code,
    status: booking.status,
    engineSyncStatus: booking.engine_sync_status,
    guestName: booking.guest_name,
    checkIn: booking.check_in,
    checkOut: booking.check_out,
    adults: booking.adults,
    children: booking.children,
    total: booking.total_amount,
    paid: booking.paid_amount,
    rooms: rooms.map(r => ({ number: r.room_number, rate: r.rate })),
  });
});

// GET /api/booking-engine/qr?hotel=&code= — SVG QR code pointing at the
// confirmation lookup for that hotel (and booking, when a code is given).
// Generated locally — the booking URL is never sent to a third-party QR image
// service. The absolute URL is built from the request host (trust proxy is
// configured in index.js), so it works behind Nginx/Render.
router.get('/qr', (req, res) => {
  const sub = String(req.query.hotel || '').trim().toLowerCase();
  const code = String(req.query.code || '').trim().toUpperCase();
  if (!sub) return res.status(400).json({ error: 'hotel is required' });
  const tenant = db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(sub);
  if (!tenant) return res.status(404).json({ error: 'Hotel not found' });

  const host = req.get('host') || 'localhost';
  const proto = req.protocol || 'http';
  let target = `${proto}://${host}/confirmation.html?hotel=${encodeURIComponent(sub)}`;
  if (code) target += '&code=' + encodeURIComponent(code);

  try {
    const qr = qrcode(0, 'M');
    qr.addData(target);
    qr.make();
    res.type('image/svg+xml').send(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
  } catch (e) {
    res.status(500).json({ error: 'Could not generate QR code' });
  }
});

// ── Admin endpoints ─────────────────────────────────────────────────────────

// GET /api/booking-engine/admin/config
router.get('/admin/config', requireAuth, resolveTenant, requireTenant, requirePermission('settings.manage'), (req, res) => {
  const cfg = db.prepare('SELECT * FROM booking_engine_config WHERE tenant_id = ?').get(req.tenantId);
  res.json({
    enabled: !!(cfg && cfg.enabled),
    notice: cfg ? cfg.notice : null,
    maxDaily: cfg ? cfg.max_daily : 50,
  });
});

// PUT /api/booking-engine/admin/config
router.put('/admin/config', requireAuth, resolveTenant, requireTenant, requirePermission('settings.manage'), (req, res) => {
  const { enabled, notice, maxDaily } = req.body || {};
  if (enabled !== undefined && typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
  if (maxDaily !== undefined && (!Number.isInteger(Number(maxDaily)) || Number(maxDaily) < 1 || Number(maxDaily) > 10000)) {
    return res.status(400).json({ error: 'maxDaily must be an integer between 1 and 10000' });
  }

  db.prepare(`
    INSERT INTO booking_engine_config (tenant_id, enabled, notice, max_daily, updated_at)
    VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(tenant_id) DO UPDATE SET
      enabled = COALESCE(?, enabled),
      notice = COALESCE(?, notice),
      max_daily = COALESCE(?, max_daily),
      updated_at = datetime('now')
  `).run(
    req.tenantId,
    enabled === undefined ? 0 : (enabled ? 1 : 0),
    notice !== undefined ? String(notice).slice(0, 500) : null,
    // SQLite DEFAULTs only apply when a column is OMITTED — never when NULL is
    // passed explicitly — so first-time inserts must supply real values.
    maxDaily !== undefined ? Number(maxDaily) : 50,
    // ON CONFLICT UPDATE params (NULL = keep existing value)
    enabled === undefined ? null : (enabled ? 1 : 0),
    notice !== undefined ? String(notice).slice(0, 500) : null,
    maxDaily !== undefined ? Number(maxDaily) : null,
  );

  const cfg = db.prepare('SELECT * FROM booking_engine_config WHERE tenant_id = ?').get(req.tenantId);
  res.json({ enabled: !!cfg.enabled, notice: cfg.notice, maxDaily: cfg.max_daily });
});

module.exports = router;
