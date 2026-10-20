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
const { fetchLiveRates, symbolToCode, detectGuestCurrencyByCountry, symbolFor } = require('../utils/exchange-rates');
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
  // 'trial' hotels are on a full-feature 30-day trial: their public booking
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

// ── Guest currency detection + conversion (PUBLIC, no auth) ────────────────
// Guests see the hotel's real charge currency, plus an auto-detected home-
// currency view so they can pay confidently in what they know.
//
// Detection priority (strongest first):
//   1. CF-IPCountry / X-Country-Code — set by Cloudflare & most edge/CDN
//      hosts (Truehost, Vercel, Netlify). Correct per-visitor, zero cost.
//   2. Explicit ?country= — the currency selector on the booking page.
//   3. Accept-Language region ("en-NG" → NG) — best-effort fallback.
// The booking flow itself is ALWAYS charged in the hotel's currency; the
// converted figure is a display aid priced from live daily rates.
router.get('/guest-currency', async (req, res) => {
  const subdomain = resolveSubdomain(req);
  if (!subdomain) return res.status(400).json({ error: 'subdomain is required' });
  const tenant = db.prepare(`SELECT * FROM tenants WHERE subdomain = ? AND status IN ('active','trial')`).get(String(subdomain).toLowerCase());
  if (!tenant) return res.status(404).json({ error: 'Hotel not found' });

  const hotelCode = symbolToCode(tenant.currency || '$');
  const edgeCountry = req.headers['cf-ipcountry'] || req.headers['x-country-code'] || null;
  const lang = String(req.headers['accept-language'] || '');
  const langRegion = (lang.match(/-([A-Z]{2})(?=,|;|$)/i) || [])[1] || null;
  const detected = detectGuestCurrencyByCountry(edgeCountry || req.query.country || langRegion);

  // Rates: use the tenant's stored live rates (fetched by Settings → refresh
  // or the boot scheduler); if missing/stale (>24h) try a live refresh.
  let rates = tenant.exchange_rates ? JSON.parse(tenant.exchange_rates) : {};
  let updatedAt = tenant.exchange_rates_updated_at || null;
  const stale = !updatedAt || (Date.now() - new Date(updatedAt + 'Z').getTime() > 864e5);
  if (stale) {
    try {
      rates = await fetchLiveRates();
      db.prepare(`UPDATE tenants SET exchange_rates = ?, exchange_rates_updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(rates), tenant.id);
      updatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
    } catch (e) { /* keep last-known rates; they're still far better than 1:1 */ }
  }

  const requested = req.query.currency ? String(req.query.currency).toUpperCase() : null;
  const valid = requested && (rates[requested] || requested === hotelCode || requested === 'USD') ? requested : null;
  const displayCode = valid || detected || hotelCode;

  // Cross rate: stored rates are USD-based (1 USD = X). To show ANY currency
  // pair correctly, divide out the hotel's USD rate:
  //   rate = USD→display ÷ USD→hotel   (e.g. NGN hotel, USD guest:
  //   1 ÷ 1580 ≈ 0.00063 — a ₦65,000 room shows ≈ $41, not "$65,000").
  // 1 = same currency; null = no rate known (guest sees the hotel amount).
  let rate = 1;
  if (displayCode !== hotelCode) {
    const hotelPerUsd = hotelCode === 'USD' ? (rates.USD || 1) : rates[hotelCode];
    const displayPerUsd = displayCode === 'USD' ? (rates.USD || 1) : rates[displayCode];
    rate = (hotelPerUsd && displayPerUsd) ? displayPerUsd / hotelPerUsd : null;
  }

  res.json({
    hotelCurrency: hotelCode,           // what the folio is charged in
    hotelSymbol: tenant.currency || '$',
    detectedCountry: edgeCountry || null,
    detectedCurrency: detected,
    displayCurrency: displayCode,       // what prices are SHOWN in
    displaySymbol: symbolFor(displayCode),
    rate: rate,                          // 1 USD = rate display
    ratesUpdatedAt: updatedAt,
    converted: rate != null,             // false = show hotel currency as-is
  });
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
        confirmationUrl: billing.resolvePlatformBaseUrl(req) + '/confirmation.html?hotel=' + encodeURIComponent(tenant.subdomain) + '&v=2&code=' + encodeURIComponent(result.code),
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

// GET /api/booking-engine/facilities?subdomain= — sellable halls + pool areas
router.get('/facilities', (req, res) => {
  const subdomain = resolveSubdomain(req);
  if (!subdomain) return res.status(400).json({ error: 'subdomain is required' });
  const tenant = publicTenant(res, subdomain);
  if (!tenant) return;
  const halls = engine.availableHalls(tenant.id).map(h => ({
    id: h.id, kind: 'hall', name: h.name, category: h.category || 'Event Space',
    capacity: h.capacity, description: h.description || null,
    dayRate: h.day_rate, hourlyRate: h.hourly_rate, currency: tenant.currency || '$',
  }));
  const pools = engine.availablePools(tenant.id).map(p => ({
    id: p.id, kind: 'pool', name: p.name, category: p.category || 'Pool',
    capacity: p.capacity, description: p.description || null,
    pricePerPersonPerHour: p.price, currency: tenant.currency || '$',
  }));
  res.json({ halls, pools });
});

// GET /api/booking-engine/facility-availability?subdomain=&kind=&facilityId=&date=&startTime=&endTime=
// Live slot check for the widget before the guest commits.
router.get('/facility-availability', (req, res) => {
  const subdomain = resolveSubdomain(req);
  const { kind, facilityId, date, startTime, endTime, partySize } = req.query;
  if (!subdomain) return res.status(400).json({ error: 'subdomain is required' });
  if (!kind || !facilityId || !date || !startTime || !endTime) {
    return res.status(400).json({ error: 'kind, facilityId, date, startTime and endTime are required' });
  }
  const tenant = publicTenant(res, subdomain);
  if (!tenant) return;
  if (String(endTime) <= String(startTime)) return res.status(400).json({ error: 'endTime must be after startTime' });
  const size = Math.max(1, parseInt(partySize, 10) || 1);

  if (kind === 'hall') {
    const hall = db.prepare('SELECT * FROM halls WHERE id = ? AND tenant_id = ? AND active = 1').get(facilityId, tenant.id);
    if (!hall) return res.status(404).json({ error: 'Facility not found' });
    if (size > hall.capacity) return res.json({ available: false, reason: hall.name + ' holds up to ' + hall.capacity + ' guests' });
    const free = engine.hallIsFree(tenant.id, hall.id, date, startTime, endTime);
    return res.json({ available: free, reason: free ? null : hall.name + ' is already reserved for that time' });
  }
  if (kind === 'pool') {
    const pool = db.prepare('SELECT * FROM pools WHERE id = ? AND tenant_id = ? AND active = 1').get(facilityId, tenant.id);
    if (!pool) return res.status(404).json({ error: 'Facility not found' });
    const capacity = pool.capacity || 20;
    const current = engine.poolHeadcount(tenant.id, pool.id, date, startTime, endTime);
    const left = Math.max(0, capacity - current);
    return res.json({ available: left >= size, reason: left >= size ? null : 'Only ' + left + ' of ' + capacity + ' slots left for that time' });
  }
  res.status(400).json({ error: 'kind must be hall or pool' });
});

// POST /api/booking-engine/facility-book — submit a hall or pool reservation
router.post('/facility-book', (req, res) => {
  const { subdomain, kind, facilityId, guestName, guestPhone, guestEmail, date, startTime, endTime, partySize, eventName, notes } = req.body || {};
  if (!subdomain) return res.status(400).json({ error: 'subdomain is required' });
  const tenant = db.prepare(`SELECT * FROM tenants WHERE subdomain = ? AND status IN ('active','trial')`).get(String(subdomain).toLowerCase());
  if (!tenant) return res.status(404).json({ error: 'Hotel not found' });
  if (!engineEnabled(tenant.id)) return res.status(503).json({ error: 'Online booking is currently closed for this hotel' });

  try {
    const result = engine.submitFacilityBooking(tenant.id, { kind, facilityId, guestName, guestPhone, guestEmail, date, startTime, endTime, partySize, eventName, notes });
    // Staff heads-up (fire-and-forget) — reuse the room submission broadcast so
    // the desk sees one consistent "new online booking" notification stream.
    notifyStaffOfSubmission(tenant.id, {
      code: result.code,
      reference: result.reference || (result.kind === 'hall' ? 'Hall · ' + result.facility : 'Pool · ' + result.facility),
      guestName: guestName,
      guestPhone: guestPhone,
      checkIn: result.date + ' ' + result.startTime,
      checkOut: result.endTime,
      total: result.total,
    });
    if (guestEmail) {
      emailSvc.sendEmail({ to: guestEmail, ...emailSvc.bookingSubmittedEmail({
        hotel: { name: tenant.name, phone: tenant.phone, email: tenant.email,
                 checkInTime: tenant.check_in_time, checkOutTime: tenant.check_out_time },
        guestName: String(guestName).trim(),
        reference: result.reference || result.code,
        code: result.code,
        checkIn: result.date + ' ' + result.startTime,
        checkOut: result.endTime,
        rooms: result.facility,
        total: result.total,
        currency: tenant.currency || '$',
        confirmationUrl: billing.resolvePlatformBaseUrl(req) + '/confirmation.html?hotel=' + encodeURIComponent(tenant.subdomain) + '&v=2&code=' + encodeURIComponent(result.code),
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

  // Facility (hall/pool) tender codes resolve first — their code spaces share
  // the BE- format with room bookings but live in their own tables.
  if (code) {
    const hallBk = db.prepare(`
      SELECT hb.*, h.name AS facility_name, h.category AS facility_category FROM hall_bookings hb
      JOIN halls h ON h.id = hb.hall_id
      WHERE hb.tenant_id = ? AND hb.engine_code = ?
    `).get(tenant.id, String(code).trim().toUpperCase());
    if (hallBk) {
      return res.json({
        facility: {
          kind: 'hall', name: hallBk.facility_name, category: hallBk.facility_category || 'Event Space',
          eventName: hallBk.event_name, date: hallBk.event_date,
          startTime: hallBk.start_time, endTime: hallBk.end_time,
          guestCount: hallBk.guest_count, total: hallBk.total_amount,
        },
        code: hallBk.engine_code,
        // 'tentative' is internal hall vocabulary; guests see the same
        // AWAITING DESK CONFIRMATION state as room submissions.
        status: hallBk.engine_sync_status === 'pending' ? 'pending_payment' : hallBk.status,
        engineSyncStatus: hallBk.engine_sync_status,
        guestName: hallBk.organizer_name,
        hotel: {
          name: tenant.name, address: tenant.country || '', phone: tenant.phone || '', email: tenant.email || '',
          checkInTime: hallBk.start_time, checkOutTime: hallBk.end_time, currency: tenant.currency || '$',
        },
        rooms: [],
      });
    }
    const poolBk = db.prepare(`
      SELECT pb.*, p.name AS facility_name, p.category AS facility_category FROM pool_bookings pb
      JOIN pools p ON p.id = pb.pool_id
      WHERE pb.tenant_id = ? AND pb.engine_code = ?
    `).get(tenant.id, String(code).trim().toUpperCase());
    if (poolBk) {
      return res.json({
        facility: {
          kind: 'pool', name: poolBk.facility_name, category: poolBk.facility_category || 'Pool',
          eventName: null, date: poolBk.date,
          startTime: poolBk.start_time, endTime: poolBk.end_time,
          guestCount: poolBk.party_size, total: poolBk.price * poolBk.party_size,
        },
        code: poolBk.engine_code,
        status: poolBk.engine_sync_status === 'pending' ? 'pending_payment' : poolBk.status,
        engineSyncStatus: poolBk.engine_sync_status,
        guestName: poolBk.guest_name,
        hotel: {
          name: tenant.name, address: tenant.country || '', phone: tenant.phone || '', email: tenant.email || '',
          checkInTime: poolBk.start_time, checkOutTime: poolBk.end_time, currency: tenant.currency || '$',
        },
        rooms: [],
      });
    }
  }

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
  let target = `${proto}://${host}/confirmation.html?hotel=${encodeURIComponent(sub)}&v=2`;
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
// READ is for the whole front desk (bookings.manage): the page shows the
// LIVE/OFF badge and guest notice alongside the submission queue. Only the
// WRITE below stays settings.manage — enable/disable, notice and caps are
// owner/admin decisions.
router.get('/admin/config', requireAuth, resolveTenant, requireTenant, requirePermission('bookings.manage'), (req, res) => {
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
