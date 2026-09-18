// server/services/booking-engine.js
// Self-contained public booking channel ("booking engine") — the hotel's own
// OTA. Guests browse availability and submit a reservation from a standalone
// page; the submission lands in the SAME bookings table the front desk uses,
// as status 'pending_payment' with engine_sync_status 'pending' and a short
// tender code. The desk confirms by tendering that code, which flips the
// booking to 'confirmed' (reusing the existing check-in/checkout lifecycle).
//
// Design notes:
// - Pending engine bookings deliberately do NOT block room inventory. The
//   overlap machinery only considers 'confirmed'/'checked_in' bookings, so a
//   wave of spam submissions cannot squat on inventory; the overlap is
//   re-validated at confirm time, inside the write transaction.
// - Pricing mirrors POST /api/bookings exactly (effectiveRate per night, per
//   room category) so the guest quote equals what the desk collects.
// - Codes are short, uppercase, and unambiguous for reading over a phone call.
'use strict';

const db = require('../db/connection');
const { effectiveRate } = require('../routes/room-setup');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const emailSvc = require('./email');

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O/1/I/L

function makeEngineCode() {
  const bytes = require('crypto').randomBytes(6);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return 'BE-' + out; // e.g. BE-7K2M9QX4 — 8 chars of entropy, phone-readable
}

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

// ── Guest notifications (WhatsApp, fire-and-forget) ─────────────────────────
// Every lifecycle event messages the guest. Sends are deliberately not awaited
// by the request path: a slow Meta API must never delay or fail a booking.
// Hotels without WhatsApp credentials get a skip (see utils/whatsapp.js).
function notify(tenantId, phone, text) {
  if (!phone) return;
  sendWhatsAppMessage(tenantId, phone, text).catch(e =>
    console.warn('[engine] WhatsApp notify failed:', e.message));
}

function hotelHeader(tenantId) {
  const t = db.prepare('SELECT name, currency, phone, email, check_in_time, check_out_time, subdomain FROM tenants WHERE id = ?').get(tenantId) || {};
  return t;
}

// Guest lifecycle emails (fire-and-forget, like WhatsApp). No-ops when the
// guest didn't leave an email — submission is the only step that collects it.
function guestHotel(hotel) {
  return { name: hotel.name, phone: hotel.phone, email: hotel.email,
           checkInTime: hotel.check_in_time, checkOutTime: hotel.check_out_time };
}

function emailGuestOnConfirm(hotel, booking) {
  if (!booking.guest_email) return;
  const rooms = db.prepare('SELECT room_number FROM booking_rooms WHERE booking_id = ?').all(booking.id).map(r => r.room_number).join(', ');
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  const url = base ? base + '/confirmation.html?hotel=' + encodeURIComponent(hotel.subdomain) + '&code=' + encodeURIComponent(booking.engine_code) : null;
  emailSvc.sendEmail({ to: booking.guest_email, ...emailSvc.bookingConfirmedEmail({
    hotel: guestHotel(hotel), guestName: booking.guest_name, reference: booking.reference,
    code: booking.engine_code, checkIn: booking.check_in, checkOut: booking.check_out,
    rooms, confirmationUrl: url,
  }) }).catch(() => {});
}

function emailGuestOnReject(hotel, booking, reason) {
  if (!booking.guest_email) return;
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  const url = base ? base + '/book.html?hotel=' + encodeURIComponent(hotel.subdomain) : null;
  emailSvc.sendEmail({ to: booking.guest_email, ...emailSvc.bookingRejectedEmail({
    hotel: guestHotel(hotel), guestName: booking.guest_name, reference: booking.reference,
    reason: reason || null, rebookUrl: url,
  }) }).catch(() => {});
}

function submissionText(tenantId, b) {
  const t = hotelHeader(tenantId);
  return `🏨 ${t.name || 'Hotel'}: reservation received!\n\n` +
    `Reference: ${b.reference}\n` +
    `Code: ${b.code}\n` +
    `Room${b.rooms.length > 1 ? 's' : ''}: ${b.rooms.map(r => r.number).join(', ')}\n` +
    `${b.checkIn} → ${b.checkOut}\n` +
    `Total: ${(t.currency || '')}${b.total} (pay at the hotel)\n\n` +
    `Present this code at the front desk to confirm your booking.`;
}

function confirmedText(tenantId, b) {
  const t = hotelHeader(tenantId);
  const rooms = db.prepare('SELECT room_number FROM booking_rooms WHERE booking_id = ?').all(b.id).map(r => r.room_number).join(', ');
  return `✅ ${t.name || 'Hotel'}: your booking is confirmed!\n\n` +
    `Reference: ${b.reference}\n` +
    `Room${rooms.includes(',') ? 's' : ''}: ${rooms}\n` +
    `${b.check_in} → ${b.check_out}\n\n` +
    `We look forward to welcoming you.`;
}

function rejectedText(tenantId, b) {
  const t = hotelHeader(tenantId);
  const contact = [t.phone, t.email].filter(Boolean).join(' · ') || 'the hotel';
  return `${t.name || 'Hotel'}: we're sorry — we could not confirm booking ${b.reference} (${b.check_in} → ${b.check_out}).\n\n` +
    `Please contact us at ${contact} and we'll gladly help you rebook.`;
}

// ── Availability & quote ────────────────────────────────────────────────────

/**
 * Rooms the engine may sell: available status AND bookable for the window.
 * Engine bookings can never touch maintenance/dirty rooms even if the desk
 * later flips their status — status is re-verified at submission time.
 */
function availableRooms(tenantId, checkIn, checkOut) {
  const rooms = db.prepare(`SELECT * FROM rooms WHERE tenant_id = ? AND status = 'available' ORDER BY number`).all(tenantId);
  return rooms.filter(r => !db.prepare(`
    SELECT 1 FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id
    WHERE b.tenant_id = ? AND b.status IN ('confirmed','checked_in') AND br.room_id = ?
      AND NOT (b.check_out <= ? OR b.check_in >= ?)
  `).get(tenantId, r.id, checkIn, checkOut));
}

/** Quote the nightly rate card the same way the front desk does. */
function quoteRoom(tenantId, room, checkIn, checkOut) {
  const nights = [];
  for (let d = new Date(checkIn); d < new Date(checkOut); d.setDate(d.getDate() + 1)) {
    nights.push(new Date(d).toISOString().slice(0, 10));
  }
  if (!room.category_id) {
    return { nights: nights.length, rate: money(room.rate), total: money(room.rate * nights.length) };
  }
  const category = db.prepare('SELECT * FROM room_categories WHERE id = ?').get(room.category_id);
  if (!category) return { nights: nights.length, rate: money(room.rate), total: money(room.rate * nights.length) };
  const nightly = nights.map(d => effectiveRate(category, d).rate);
  return { nights: nights.length, rate: money(nightly[0]), total: money(nightly.reduce((s, n) => s + n, 0)) };
}

// ── Submission ──────────────────────────────────────────────────────────────

/**
 * Create an engine booking. Throws { status, message } on validation failure.
 * Returns the created booking row joined with its rooms and code.
 */
function submitBooking(tenantId, payload) {
  const { guestName, guestPhone, guestEmail, checkIn, checkOut, roomIds, adults } = payload;

  if (!guestName || !String(guestName).trim()) throw Object.assign(new Error('Guest name is required'), { status: 400 });
  if (!guestPhone || !String(guestPhone).trim()) throw Object.assign(new Error('A phone number is required so the hotel can reach you'), { status: 400 });
  if (!checkIn || !checkOut) throw Object.assign(new Error('Check-in and check-out dates are required'), { status: 400 });
  if (new Date(checkOut) <= new Date(checkIn)) throw Object.assign(new Error('Check-out must be after check-in'), { status: 400 });
  if (new Date(checkIn) < new Date(new Date().toISOString().slice(0, 10))) throw Object.assign(new Error('Check-in cannot be in the past'), { status: 400 });
  if (!Array.isArray(roomIds) || roomIds.length === 0) throw Object.assign(new Error('Select at least one room'), { status: 400 });
  if (roomIds.length > 3) throw Object.assign(new Error('For parties larger than 3 rooms, please call the hotel directly'), { status: 400 });

  const cfg = db.prepare('SELECT * FROM booking_engine_config WHERE tenant_id = ?').get(tenantId);
  if (!cfg || !cfg.enabled) throw Object.assign(new Error('Online booking is currently closed for this hotel'), { status: 503 });

  // Daily submission cap (per tenant, per calendar day) — engine abuse guard.
  const today = new Date().toISOString().slice(0, 10);
  const submittedToday = db.prepare(`SELECT COUNT(*) c FROM bookings WHERE tenant_id = ? AND source = 'engine' AND date(created_at) = ?`).get(tenantId, today).c;
  if (submittedToday >= cfg.max_daily) throw Object.assign(new Error('The hotel has reached its daily online-booking limit — please try again tomorrow or call us'), { status: 429 });

  // Validate rooms: must exist, be available status, and free for the window.
  // Bind order matters: the SQL tests id first, then tenant_id.
  const rooms = roomIds.map(rid => db.prepare('SELECT * FROM rooms WHERE id = ? AND tenant_id = ? AND status = \'available\'').get(rid, tenantId));
  if (rooms.some(r => !r)) throw Object.assign(new Error('One or more selected rooms are no longer available — please refresh'), { status: 409 });
  for (const room of rooms) {
    const clash = db.prepare(`
      SELECT 1 FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id
      WHERE b.tenant_id = ? AND b.status IN ('confirmed','checked_in') AND br.room_id = ?
        AND NOT (b.check_out <= ? OR b.check_in >= ?)
    `).get(tenantId, room.id, checkIn, checkOut);
    if (clash) throw Object.assign(new Error('Room ' + room.number + ' is already booked for those dates'), { status: 409 });
  }

  // Price from the rate card — the guest quote equals the desk quote.
  const total = rooms.reduce((s, room) => s + quoteRoom(tenantId, room, checkIn, checkOut).total, 0);

  // Guest record: reuse by phone (same convention as the desk flow).
  let guest = db.prepare('SELECT * FROM guests WHERE tenant_id = ? AND phone = ?').get(tenantId, guestPhone);
  let guestId;
  if (guest) {
    guestId = guest.id;
  } else {
    guestId = 'guest_' + require('nanoid').nanoid(10);
    db.prepare(`INSERT INTO guests (id, tenant_id, name, phone, email, loyalty_tier, loyalty_points, stays, total_spent, preferences)
                VALUES (?,?,?,?,?, 'Bronze', 0, 0, 0, '[]')`)
      .run(guestId, tenantId, String(guestName).trim(), String(guestPhone).trim(), guestEmail || null);
  }

  const { nanoid } = require('nanoid');
  const id = 'bk_' + nanoid(10);
  const reference = 'BK-' + nanoid(8).toUpperCase();
  const code = makeEngineCode();

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO bookings (id, tenant_id, guest_id, reference, check_in, check_out, status,
                  total_amount, paid_amount, guest_name, guest_phone, guest_email, adults, children,
                  source, engine_code, engine_sync_status, created_by)
                VALUES (?,?,?,?,?,?,'pending_payment',?,0,?,?,?,?,?,'engine',?,'pending','booking-engine')`)
      .run(id, tenantId, guestId, reference, checkIn, checkOut, total,
           String(guestName).trim(), String(guestPhone).trim(), guestEmail || null,
           Math.max(1, parseInt(adults, 10) || 1), parseInt(payload.children, 10) || 0, code);

    rooms.forEach(room => {
      db.prepare('INSERT INTO booking_rooms (booking_id, room_id, room_number, rate, tenant_id) VALUES (?,?,?,?,?)')
        .run(id, room.id, room.number, quoteRoom(tenantId, room, checkIn, checkOut).rate, tenantId);
    });
  });
  tx();

  // Guest confirmation-of-receipt with their tender code (fire-and-forget).
  const created = { reference, code, checkIn, checkOut, rooms: rooms.map(r => ({ number: r.number })), total: money(total) };
  notify(tenantId, String(guestPhone).trim(), submissionText(tenantId, created));

  return {
    id, reference, code,
    status: 'pending_payment',
    engineSyncStatus: 'pending',
    checkIn, checkOut,
    rooms: rooms.map(r => ({ number: r.number, type: r.type })),
    total: money(total),
    guestName: String(guestName).trim(),
  };
}

// ── Desk-side lookup & confirmation ─────────────────────────────────────────

/** Find a pending engine booking by tender code (case-insensitive, trimmed). */
function findByCode(tenantId, code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  return db.prepare(`SELECT * FROM bookings WHERE tenant_id = ? AND engine_code = ?`).get(tenantId, normalized);
}

/**
 * Confirm a pending engine booking. Re-validates availability inside the write
 * transaction (inventory may have been sold by the desk while the submission
 * sat pending), flips to 'confirmed', and clears engine_sync_status.
 */
function confirmByCode(tenantId, code, deskUserId) {
  const booking = findByCode(tenantId, code);
  if (!booking) throw Object.assign(new Error('No pending online booking with that code'), { status: 404 });
  if (booking.engine_sync_status !== 'pending') throw Object.assign(new Error('This booking was already ' + (booking.engine_sync_status || 'processed')), { status: 409 });
  if (booking.status !== 'pending_payment') throw Object.assign(new Error('Only pending bookings can be confirmed'), { status: 409 });

  const rooms = db.prepare('SELECT * FROM booking_rooms WHERE booking_id = ?').all(booking.id);
  const clash = db.prepare(`
    SELECT br.room_number FROM booking_rooms br
    JOIN bookings b2 ON b2.id = br.booking_id
    WHERE b2.tenant_id = ? AND b2.id != ? AND b2.status IN ('confirmed','checked_in') AND br.room_id IN (${rooms.map(() => '?').join(',')})
      AND NOT (b2.check_out <= ? OR b2.check_in >= ?)
  `).get(tenantId, booking.id, ...rooms.map(r => r.room_id), booking.check_in, booking.check_out);
  if (clash) throw Object.assign(new Error('Room ' + clash.room_number + ' has been sold for these dates since the guest booked — reject this request and offer an alternative'), { status: 409 });

  const tx = db.transaction(() => {
    const r = db.prepare(`UPDATE bookings SET status='confirmed', engine_sync_status='confirmed', updated_at=datetime('now') WHERE id=? AND status='pending_payment' AND engine_sync_status='pending'`)
      .run(booking.id);
    if (r.changes === 0) throw Object.assign(new Error('This booking was just processed by someone else'), { status: 409 });
  });
  tx();
  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  notify(tenantId, booking.guest_phone, confirmedText(tenantId, updated));
  emailGuestOnConfirm(hotelHeader(tenantId), updated);
  return updated;
}

/**
 * Reject a pending engine booking (room sold, guest unreachable, spam…).
 */
function rejectByCode(tenantId, code, reason, deskUserId) {
  const booking = findByCode(tenantId, code);
  if (!booking) throw Object.assign(new Error('No pending online booking with that code'), { status: 404 });
  if (booking.engine_sync_status !== 'pending') throw Object.assign(new Error('This booking was already ' + (booking.engine_sync_status || 'processed')), { status: 409 });

  const tx = db.transaction(() => {
    const r = db.prepare(`UPDATE bookings SET status='cancelled', engine_sync_status='rejected', updated_at=datetime('now') WHERE id=? AND status='pending_payment' AND engine_sync_status='pending'`)
      .run(booking.id);
    if (r.changes === 0) throw Object.assign(new Error('This booking was just processed by someone else'), { status: 409 });
  });
  tx();
  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
  notify(tenantId, booking.guest_phone, rejectedText(tenantId, updated));
  emailGuestOnReject(hotelHeader(tenantId), updated, reason);
  return updated;
}

module.exports = {
  makeEngineCode,
  availableRooms,
  quoteRoom,
  submitBooking,
  findByCode,
  confirmByCode,
  rejectByCode,
};
