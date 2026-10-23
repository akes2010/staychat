// server/routes/bookings.js
// Bookings & Reservations — supports both single-room and group bookings.
// A group booking attaches multiple rooms (booking_rooms) to one reservation
// record so a whole party can be checked in/out together under one reference.
const express = require('express');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { hasPermission, requirePermission } = require('../utils/permissions');
const { broadcast } = require('../ws');
const { effectiveRate } = require('./room-setup');
const { postCharge, recordPayment } = require('../services/charges');
const { resolveOutstanding } = require('../utils/balance');
const { postEntry, getAccountByKey, ensureDefaultAccounts } = require('./accounting');
const wifi = require('../services/wifi');
const engine = require('../services/booking-engine');
const { notifyStaffOfDecision } = require('../services/engine-notifications');
const { idempotency } = require('../middleware/idempotency');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

function serialize(b) {
  const rooms = db.prepare('SELECT * FROM booking_rooms WHERE booking_id = ?').all(b.id);
  return { ...b, isGroup: !!b.is_group, rooms, engineCode: b.engine_code || undefined, engineSyncStatus: b.engine_sync_status || undefined };
}

// List-variant of `serialize`: ONE query for all rooms instead of the N+1
// (one query per booking). The bookings screen is fetched on every dashboard
// load and, with 100+ reservations, the old pattern spent ~100 prepares +
// roundtrips per request — the single biggest CPU item in the load profile
// (≈17% of total). Response shape is byte-identical to serialize().
function serializeList(bookings) {
  const roomsByBooking = new Map();
  // Chunked IN-lists: stay well under SQLite's bound-parameter limit even for
  // tenants with thousands of reservations.
  for (let i = 0; i < bookings.length; i += 500) {
    const chunk = bookings.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = db.prepare(`SELECT * FROM booking_rooms WHERE booking_id IN (${placeholders})`).all(...chunk.map(b => b.id));
    for (const r of rows) {
      let arr = roomsByBooking.get(r.booking_id);
      if (!arr) { arr = []; roomsByBooking.set(r.booking_id, arr); }
      arr.push(r);
    }
  }
  return bookings.map(b => ({
    ...b,
    isGroup: !!b.is_group,
    rooms: roomsByBooking.get(b.id) || [],
    engineCode: b.engine_code || undefined,
    engineSyncStatus: b.engine_sync_status || undefined,
  }));
}

function makeReference() {
  // nanoid (64-char alphabet, 8 chars ≈ 48 bits) instead of timestamp+Math.random:
  // the old format collided whenever two bookings were created in the same
  // millisecond with the same 1-in-900 suffix, and the UNIQUE constraint on
  // bookings.reference then turned the collision into an unhandled 500.
  return 'BK-' + nanoid(8).toUpperCase();
}

// Money coming off the wire must be a finite, non-negative number. Without this
// a client could POST totalAmount: -500 (creating a negative-revenue booking) or
// a NaN that silently poisons every downstream balance calculation.
function money(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw Object.assign(new Error(label + ' must be a number'), { status: 400 });
  if (n < 0) throw Object.assign(new Error(label + ' cannot be negative'), { status: 400 });
  return Math.round(n * 100) / 100;
}

// GET /api/bookings?status=&from=&to=&isGroup=
router.get('/', (req, res) => {
  const { status, from, to, isGroup } = req.query;
  let sql = 'SELECT * FROM bookings WHERE tenant_id = ?';
  const params = [req.tenantId];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (from) { sql += ' AND check_out >= ?'; params.push(from); }
  if (to) { sql += ' AND check_in <= ?'; params.push(to); }
  if (isGroup !== undefined) { sql += ' AND is_group = ?'; params.push(isGroup === 'true' ? 1 : 0); }
  sql += ' ORDER BY check_in DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(serializeList(rows));
});

// GET /api/bookings/returning-guest?phone= — PEMBROKE-STYLE RETURNING-GUEST
// LOOKUP for the reservation form's autofill. Given a phone number typed by
// the desk, returns the most recent profile (from bookings, since that is the
// bio-data the desk actually collected — guests table only mirrors a subset)
// plus a tiny stay history, so one field-fill brings the whole known guest
// back. Match is tolerant of format: E.164, local 080… and spaced digits all
// resolve to the same guest because we compare on their LAST 10 digits.
// READ deliberately open to bookings.manage (the desk owns this form).
router.get('/returning-guest', (req, res) => {
  const raw = String(req.query.phone || '');
  const digits = raw.replace(/[^\d]/g, '');
  const key = digits.length > 10 ? digits.slice(-10) : digits;
  if (!key) return res.status(400).json({ error: 'phone is required' });

  // All bookings for numbers whose last-10 digits match the typed key.
  const rows = db.prepare('SELECT * FROM bookings WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 400').all(req.tenantId)
    .filter(b => {
      const bd = String(b.guest_phone || '').replace(/[^\d]/g, '');
      const bk = bd.length > 10 ? bd.slice(-10) : bd;
      return bk === key;
    });
  if (rows.length === 0) return res.json({ matched: false });

  // Seeded/legacy bookings may only carry the composite guest_name ("Grace
  // Okafor"), not the split surname/first_name columns. Split on the FIRST
  // word so the form gets both parts regardless of which era wrote the row.
  const withBio = rows.find(b => b.surname || b.first_name || b.address);
  const latest = withBio ? withBio : rows.find(b => b.guest_name) || rows[0];
  if (!latest.surname && !latest.first_name && latest.guest_name) {
    const parts = String(latest.guest_name).trim().split(/\s+/);
    if (parts.length > 1) { latest.first_name = parts.slice(0, -1).join(' '); latest.surname = parts[parts.length - 1]; }
    else latest.surname = parts[0];
  }
  const roomsOf = (id) => db.prepare('SELECT room_number FROM booking_rooms WHERE booking_id = ?').all(id).map(r => r.room_number);
  res.json({
    matched: true,
    guest: {
      surname: latest.surname || null,
      firstName: latest.first_name || null,
      fullName: latest.guest_name || null,
      phone: latest.guest_phone || raw || null,
      email: latest.guest_email || null,
      address: latest.address || null,
      idType: latest.id_type || null,
      idNumber: latest.id_number || null,
      country: latest.country || null,
      state: latest.state || null,
      nextOfKinName: latest.next_of_kin_name || null,
      nextOfKinPhone: latest.next_of_kin_phone || null,
      guestId: latest.guest_id || null,
    },
    history: rows.slice(0, 5).map(b => ({
      reference: b.reference,
      checkIn: b.check_in, checkOut: b.check_out,
      status: b.status,
      rooms: roomsOf(b.id),
      total: b.total_amount,
    })),
    stayCount: rows.length,
  });
});

router.get('/:id', (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  res.json(serialize(b));
});

// POST /api/bookings — create a reservation. roomIds: string[] (1 = normal booking, 2+ = group).
//
// DOUBLE-REGISTRATION PROOF: the payload is fingerprinted (guest + dates +
// rooms + reference override) and, if the DESK (not the engine) created the
// identical registration moments before, the original booking is returned
// with 200 instead of minting a second one. A guest arriving twice on the
// desk's books is a real complaint-class failure this kills at the source.
// A client can also pass `idempotencyKey` (e.g. the browser tab's submit
// token) for explicit intent-level dedupe.
function registrationFingerprint(body, resolvedRooms) {
  const crypto = require('crypto');
  const norm = {
    name: String(body.guestName || [body.firstName, body.surname].filter(Boolean).join(' ')).trim().toLowerCase(),
    phone: String(body.guestPhone || '').replace(/[^\d]/g, '').slice(-10),
    in: body.checkIn, out: body.checkOut,
    rooms: resolvedRooms.map(r => r.id).sort(),
    group: !!body.isGroup,
    externalRef: body.externalRef || null,
    clientKey: body.idempotencyKey || null,
  };
  return 'reg-' + crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex').slice(0, 32);
}

// idempotency: offline-first clients replay this request after reconnect —
// the header key makes the replay return the ORIGINAL booking, never a dup.
router.post('/', requirePermission('bookings.manage'), idempotency, (req, res) => {
  const {
    guestName, surname, firstName, guestPhone, guestEmail, guestId, address, idType, idNumber, country, state,
    nextOfKinName, nextOfKinPhone, checkIn, checkOut, roomIds,
    isGroup, groupName, adults, children, source, totalAmount, depositAmount, notes,
    payment, externalRef, prepaid,
  } = req.body;

  const resolvedGuestName = guestName || [firstName, surname].filter(Boolean).join(' ');
  if (!resolvedGuestName) return res.status(400).json({ error: 'Guest name (or surname/firstName) is required' });
  if (!checkIn || !checkOut) return res.status(400).json({ error: 'checkIn and checkOut dates are required' });
  if (new Date(checkOut) <= new Date(checkIn)) return res.status(400).json({ error: 'checkOut must be after checkIn' });
  if (!Array.isArray(roomIds) || roomIds.length === 0) return res.status(400).json({ error: 'At least one room must be selected' });
  if (roomIds.length > 1 && !isGroup) return res.status(400).json({ error: 'Multiple rooms require isGroup to be true' });

  const rooms = roomIds.map(rid => db.prepare('SELECT * FROM rooms WHERE id = ? AND tenant_id = ?').get(rid, req.tenantId));
  if (rooms.some(r => !r)) return res.status(404).json({ error: 'One or more selected rooms were not found' });

  // Overlap check: reject if any selected room already has a confirmed/checked_in
  // booking overlapping these dates. This runs again INSIDE the write transaction
  // below (findConflict) — checking here only gives a fast, cheap rejection before
  // the pricing work. The in-transaction re-check is the one that actually prevents
  // two concurrent requests from both booking the same room.
  //
  // Same-registration dedupe runs FIRST: an identical desk registration
  // (same guest ± case, dates and room set) created moments before returns
  // the original booking instead of failing on the overlap check it now
  // conflicts with. 'engine' source is excluded — a guest re-submitting on
  // the public page is a NEW intent and must create a new tender-code request.
  if ((source || 'direct') !== 'engine') {
    const dup = db.prepare(`
      SELECT b.* FROM bookings b
      JOIN booking_rooms br ON br.booking_id = b.id
      WHERE b.tenant_id = ? AND b.source != 'engine'
        AND b.status IN ('confirmed','checked_in')
        AND b.check_in = ? AND b.check_out = ? AND b.guest_name = ? COLLATE NOCASE
        AND br.room_id IN (${rooms.map(() => '?').join(',')})
      ORDER BY b.created_at DESC LIMIT 1
    `).get(req.tenantId, checkIn, checkOut, resolvedGuestName, ...rooms.map(r => r.id));
    if (dup) {
      audit(req, 'booking.dedupe', 'booking', dup.id);
      return res.status(200).json({ ...serialize(dup), duplicate: true });
    }
  }
  const findConflict = () => db.prepare(`
    SELECT br.room_number FROM booking_rooms br
    JOIN bookings b ON b.id = br.booking_id
    WHERE b.tenant_id = ? AND b.status IN ('confirmed','checked_in') AND br.room_id IN (${rooms.map(() => '?').join(',')})
      AND NOT (b.check_out <= ? OR b.check_in >= ?)
  `).get(req.tenantId, ...rooms.map(r => r.id), checkIn, checkOut);
  const conflict = findConflict();
  if (conflict) return res.status(409).json({ error: 'Room ' + conflict.room_number + ' is already booked for those dates' });

  // ── OTA HOLD ────────────────────────────────────────────────────────────
  // A room the guest reserved on the hotel's public booking channel sits
  // 'pending_payment' until THIS desk approves or denies it. The overlap
  // machinery above deliberately ignores pending submissions (spam must not
  // squat inventory), so without this guard the desk could register the very
  // room an online guest is holding — and the later approval would then fail.
  // While the submission is pending, registering that room here is refused:
  // approve or reject the online booking first (Bookings → Pending).
  const findEngineHold = () => db.prepare(`
    SELECT b.engine_code, br.room_number FROM bookings b
    JOIN booking_rooms br ON br.booking_id = b.id
    WHERE b.tenant_id = ? AND b.source = 'engine' AND b.engine_sync_status = 'pending'
      AND br.room_id IN (${rooms.map(() => '?').join(',')})
      AND NOT (b.check_out <= ? OR b.check_in >= ?)
    LIMIT 1
  `).get(req.tenantId, ...rooms.map(r => r.id), checkIn, checkOut);
  const held = findEngineHold();
  if (held) {
    return res.status(409).json({
      error: 'Room ' + held.room_number + ' is reserved by online booking ' + held.engine_code + ' awaiting approval — confirm or reject that online booking first (Bookings → Pending)',
      engineHold: held.engine_code,
    });
  }

  // Per-night, per-room pricing: uses the room's category tiered rates (weekday/weekend/holiday/discount)
  // when available, otherwise falls back to the room's flat nightly rate.
  const nightDates = [];
  for (let d = new Date(checkIn); d < new Date(checkOut); d.setDate(d.getDate() + 1)) nightDates.push(new Date(d).toISOString().slice(0, 10));
  const roomTotals = rooms.map(r => {
    if (!r.category_id) return { room: r, total: r.rate * nightDates.length, rate: r.rate };
    const category = db.prepare('SELECT * FROM room_categories WHERE id = ?').get(r.category_id);
    if (!category) return { room: r, total: r.rate * nightDates.length, rate: r.rate };
    const nightly = nightDates.map(d => effectiveRate(category, d).rate);
    return { room: r, total: nightly.reduce((s, n) => s + n, 0), rate: nightly[0] };
  });
  // A client-supplied totalAmount overrides the rate card, so it is a pricing
  // decision — gate it behind pricing.manage and validate it as money.
  let computedTotal;
  try {
    if (totalAmount !== undefined) {
      if (!hasPermission(req.user, 'pricing.manage')) {
        return res.status(403).json({ error: 'Only a manager or owner can override the calculated room total (pricing.manage)' });
      }
      computedTotal = money(totalAmount, 'totalAmount');
    } else {
      computedTotal = roomTotals.reduce((s, rt) => s + rt.total, 0);
    }
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  // Every booking must be tied to a real Guest record — never just free-text bio-data.
  // Reuse an existing guest if given/matched by phone, otherwise create one now from
  // the details already collected on this booking form.
  let resolvedGuestId = guestId || null;
  if (!resolvedGuestId) {
    const existingGuest = guestPhone ? db.prepare('SELECT * FROM guests WHERE tenant_id = ? AND phone = ?').get(req.tenantId, guestPhone) : null;
    if (existingGuest) {
      resolvedGuestId = existingGuest.id;
    } else {
      resolvedGuestId = 'guest_' + nanoid(10);
      db.prepare(`INSERT INTO guests (id, tenant_id, name, phone, email, loyalty_tier, loyalty_points, stays, total_spent, preferences)
                  VALUES (?,?,?,?,?, 'Bronze', 0, 0, 0, '[]')`)
        .run(resolvedGuestId, req.tenantId, resolvedGuestName, guestPhone || null, guestEmail || null);
    }
  }

  // Validate and prepare payment if provided.
  //
  // A deposit is MONEY, not a discount. It used to be stored as a bare number that
  // server/utils/balance.js subtracted from the amount owed, so anyone who could
  // create a booking could set depositAmount = totalAmount and the guest would walk
  // out with a zero balance having paid nothing — no transaction, no ledger entry,
  // nothing to reconcile. A deposit is now collected through the same path as any
  // other payment: it must name a payment method, it produces a real transaction,
  // and it increases paid_amount. `deposit_amount` is retained purely as a label on
  // the reservation for reporting; it no longer reduces what is owed.
  let paymentAmount = 0;
  let paymentMethod = null;
  let paymentTxn = null;
  let depositRequested = 0;
  try { depositRequested = depositAmount !== undefined ? money(depositAmount, 'depositAmount') : 0; }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

  const payMethod = payment && payment.method ? payment.method : null;
  let payAmount = 0;
  if (payment && payment.amount !== undefined) {
    try { payAmount = money(payment.amount, 'payment.amount'); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  }

  // The deposit is collected as part of this booking's payment. If the caller sent
  // a deposit but no explicit payment, the deposit IS the payment.
  paymentAmount = payAmount > 0 ? payAmount : depositRequested;
  paymentMethod = payMethod;

  if (depositRequested > 0 && !paymentMethod) {
    return res.status(400).json({ error: 'A deposit is money received — specify the payment method it was collected with (payment.method)' });
  }
  if (paymentAmount > 0) {
    if (!paymentMethod) return res.status(400).json({ error: 'payment.method is required to record a payment' });
    if (paymentAmount > computedTotal) {
      return res.status(400).json({ error: 'Payment cannot exceed the room total of ' + computedTotal.toFixed(2) });
    }
    if (!hasPermission(req.user, 'payments.use')) {
      return res.status(403).json({ error: 'You do not have permission to record payments (payments.use)' });
    }
  }

  const id = 'bk_' + nanoid(10);
  const reference = makeReference();

  // Wrap booking + rooms + payment in one atomic transaction. IMMEDIATE takes the
  // write lock up front so the overlap re-check below and the INSERT that depends
  // on it cannot be interleaved with another writer.
  const doCreate = db.transaction(() => {
    // Re-check inside the transaction: between the cheap pre-check above and here,
    // another request could have booked one of these rooms.
    const raced = findConflict();
    if (raced) throw Object.assign(new Error('Room ' + raced.room_number + ' is already booked for those dates'), { status: 409 });
    // Same in-transaction re-check for OTA holds — a submission landing while
    // this registration was being priced must still win the room.
    const racedHold = findEngineHold();
    if (racedHold) {
      throw Object.assign(new Error('Room ' + racedHold.room_number + ' is reserved by online booking ' + racedHold.engine_code + ' awaiting approval — confirm or reject that online booking first (Bookings → Pending)'), { status: 409 });
    }

    db.prepare(`INSERT INTO bookings (id, tenant_id, guest_id, reference, check_in, check_out, status, total_amount, paid_amount,
                notes, guest_name, guest_phone, guest_email, is_group, group_name, adults, children, source, deposit_amount, created_by,
                surname, first_name, address, id_type, id_number, country, state, next_of_kin_name, next_of_kin_phone, billed_to,
                external_ref, prepaid)
                VALUES (?,?,?,?,?,?, 'confirmed', ?, 0, ?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?,?, ?,?)`)
      .run(id, req.tenantId, resolvedGuestId, reference, checkIn, checkOut, computedTotal, notes || null,
           resolvedGuestName, guestPhone || null, guestEmail || null, isGroup ? 1 : 0, groupName || null,
           Number(adults) || 1, Number(children) || 0, source || 'direct', depositRequested, req.user.name,
           surname || null, firstName || null, address || null, idType || null, idNumber || null, country || null, state || null,
           nextOfKinName || null, nextOfKinPhone || null, isGroup ? 'group' : 'individual',
           externalRef || null, prepaid ? 1 : 0);

    const insertRoom = db.prepare('INSERT INTO booking_rooms (id, tenant_id, booking_id, room_id, room_number, rate, occupant_name) VALUES (?,?,?,?,?,?,?)');
    roomTotals.forEach(rt => insertRoom.run('bkr_' + nanoid(10), req.tenantId, id, rt.room.id, rt.room.number, rt.rate, null));

    // Record payment if collected — through the ONE money pipeline
    // (services/charges.js): idempotent, ledger-real, room_revenue attributed.
    // The idempotency key is the booking's own reference, so a retried
    // "create booking with payment" request can never double-charge the guest.
    if (paymentAmount > 0 && paymentMethod) {
      const methodLabel = paymentMethod.charAt(0).toUpperCase() + paymentMethod.slice(1);
      const firstRoomNumber = isGroup ? null : roomTotals[0].room.number;
      const label = depositRequested > 0 && payAmount <= 0 ? 'Booking deposit — ' : 'Booking payment — ';
      const posted = recordPayment(req.tenantId, {
        source: 'booking', sourceId: id, idempotencyKey: 'booking-payment:' + id,
        amount: paymentAmount, method: methodLabel,
        description: label + reference,
        bookingId: id, guestId: resolvedGuestId, roomNumber: firstRoomNumber,
        guestName: resolvedGuestName, createdBy: req.user.name,
      });
      paymentTxn = posted.transaction;
    }
  });
  try { doCreate(); }
  catch (e) {
    if (e.status === 409) return res.status(409).json({ error: e.message });
    // Reference collisions are now ~impossible (high-entropy nanoid) but must
    // still surface as a retryable 409, never a 500.
    if (String(e.message).includes('UNIQUE') && String(e.message).includes('reference')) {
      return res.status(409).json({ error: 'Booking reference collision — please retry' });
    }
    throw e;
  }

  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  audit(req, 'booking.create', 'booking', id, { reference, rooms: rooms.map(r => r.number), isGroup: !!isGroup, payment: paymentAmount > 0 ? paymentAmount : undefined });
  broadcast(req.tenantId, 'booking.created', serialize(booking));
  if (paymentTxn) broadcast(req.tenantId, 'payment.created', paymentTxn);
  res.status(201).json({ ...serialize(booking), payment: paymentTxn });
});

// PATCH /api/bookings/:id — edit dates/guest/notes/amounts while not checked out/cancelled
router.patch('/:id', requirePermission('bookings.manage'), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (['checked_out', 'cancelled'].includes(b.status)) return res.status(409).json({ error: 'This booking is ' + b.status + ' and can no longer be edited' });

  const fields = {
    guestName: 'guest_name', guestPhone: 'guest_phone', guestEmail: 'guest_email', checkIn: 'check_in', checkOut: 'check_out',
    groupName: 'group_name', adults: 'adults', children: 'children', notes: 'notes', totalAmount: 'total_amount',
    depositAmount: 'deposit_amount', source: 'source',
    surname: 'surname', firstName: 'first_name', address: 'address', idType: 'id_type', idNumber: 'id_number',
    country: 'country', state: 'state', nextOfKinName: 'next_of_kin_name', nextOfKinPhone: 'next_of_kin_phone',
  };
  // `paid_amount` is deliberately NOT editable here. It is a ledger figure derived
  // from actual transactions; letting it be PATCHed let anyone who could edit a
  // booking declare it paid in full without a payment ever being recorded.
  // Money moves through POST /api/payments/settle, which writes a transaction.
  if (req.body.paidAmount !== undefined) {
    return res.status(400).json({ error: 'paid_amount cannot be edited directly — record a payment via /api/payments/settle so the money is auditable' });
  }

  const updates = {};
  Object.entries(fields).forEach(([bodyKey, col]) => { if (req.body[bodyKey] !== undefined) updates[col] = req.body[bodyKey]; });
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  // Re-pricing a reservation is a pricing decision, and money fields must stay numeric.
  if (updates.total_amount !== undefined || updates.deposit_amount !== undefined) {
    if (!hasPermission(req.user, 'pricing.manage')) {
      return res.status(403).json({ error: 'Only a manager or owner can change a booking\'s amounts (pricing.manage)' });
    }
    try {
      if (updates.total_amount !== undefined) updates.total_amount = money(updates.total_amount, 'totalAmount');
      if (updates.deposit_amount !== undefined) updates.deposit_amount = money(updates.deposit_amount, 'depositAmount');
    } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  }
  // Availability re-check: POST /bookings rejects overlapping reservations, but
  // PATCH used to skip it entirely — editing checkIn/checkOut after creation let
  // two confirmed bookings overlap on the same room. Runs inside the same
  // transaction as the UPDATE so a concurrent booking cannot slip between the
  // check and the write.
  let conflict = null;
  if (updates.check_in !== undefined || updates.check_out !== undefined) {
    const newIn = updates.check_in !== undefined ? updates.check_in : b.check_in;
    const newOut = updates.check_out !== undefined ? updates.check_out : b.check_out;
    if (new Date(newOut) <= new Date(newIn)) {
      return res.status(400).json({ error: 'checkOut must be after checkIn' });
    }
    const roomIds = db.prepare('SELECT room_id FROM booking_rooms WHERE booking_id = ?').all(b.id).map(r => r.room_id);
    if (roomIds.length > 0) {
      conflict = db.prepare(`
        SELECT br.room_number FROM booking_rooms br
        JOIN bookings b2 ON b2.id = br.booking_id
        WHERE b2.tenant_id = ? AND b2.id != ? AND b2.status IN ('confirmed','checked_in')
          AND br.room_id IN (${roomIds.map(() => '?').join(',')})
          AND NOT (b2.check_out <= ? OR b2.check_in >= ?)
      `).get(req.tenantId, b.id, ...roomIds, newIn, newOut) || null;
      if (conflict) {
        return res.status(409).json({ error: 'Room ' + conflict.room_number + ' is already booked for those dates' });
      }
    }
  }

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.transaction(() => {
    // Re-check inside the write lock (mirrors POST /bookings): the pre-check above
    // is only a cheap fast-fail; this one prevents concurrent-update overlaps.
    if (updates.check_in !== undefined || updates.check_out !== undefined) {
      const newIn = updates.check_in !== undefined ? updates.check_in : b.check_in;
      const newOut = updates.check_out !== undefined ? updates.check_out : b.check_out;
      const roomIds = db.prepare('SELECT room_id FROM booking_rooms WHERE booking_id = ?').all(b.id).map(r => r.room_id);
      if (roomIds.length > 0) {
        const raced = db.prepare(`
          SELECT br.room_number FROM booking_rooms br
          JOIN bookings b2 ON b2.id = br.booking_id
          WHERE b2.tenant_id = ? AND b2.id != ? AND b2.status IN ('confirmed','checked_in')
            AND br.room_id IN (${roomIds.map(() => '?').join(',')})
            AND NOT (b2.check_out <= ? OR b2.check_in >= ?)
        `).get(req.tenantId, b.id, ...roomIds, newIn, newOut);
        if (raced) throw Object.assign(new Error('Room ' + raced.room_number + ' is already booked for those dates'), { status: 409 });
      }
    }
    db.prepare(`UPDATE bookings SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: b.id });
  })();

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  audit(req, 'booking.update', 'booking', b.id, updates);
  broadcast(req.tenantId, 'booking.updated', serialize(updated));
  res.json(serialize(updated));
});

// POST /api/bookings/:id/transfer — perform a ROOM TRANSFER (room swap) for a
// booking. Body: { roomId } — move the booking onto a different room.
//
// Transfer semantics:
// - The booking keeps its dates, identity, rate and folio; only the room changes.
// - Availability is checked against OTHER active bookings inside the write
//   transaction (same overlap rule as POST /bookings and PATCH), so two desks
//   transferring onto the same room at the same time cannot both succeed.
// - Room status: a merely *confirmed* booking does not flip room status —
//   availability lives in booking_rooms + date overlap (same as POST /bookings).
//   When the guest is already IN-HOUSE the physical move happens: the old room
//   goes 'dirty' (housekeeping queue) and the new room becomes 'occupied'.
router.post('/:id/transfer', requirePermission('bookings.manage'), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (['checked_out', 'cancelled'].includes(b.status)) return res.status(409).json({ error: 'This booking is ' + b.status + ' and cannot be transferred' });

  const { roomId, newRoomId } = req.body || {};
  const targetRoomId = roomId || newRoomId;
  if (!targetRoomId) return res.status(400).json({ error: 'A target room (roomId) is required' });

  const target = db.prepare('SELECT * FROM rooms WHERE id = ? AND tenant_id = ?').get(targetRoomId, req.tenantId);
  if (!target) return res.status(404).json({ error: 'Target room not found' });

  const existing = db.prepare('SELECT * FROM booking_rooms WHERE booking_id = ?').all(b.id);
  if (existing.length === 0) return res.status(409).json({ error: 'This booking has no rooms attached to transfer' });
  if (existing.some(br => br.room_id === target.id)) {
    return res.status(400).json({ error: 'Room ' + target.number + ' is already on this booking' });
  }

  // Transfers in this UI are one-for-one swaps: the first attached room moves
  // onto the target room. (Full multi-room re-mapping is a separate workflow.)
  const leaving = existing[0];
  db.transaction(() => {
    const conflict = db.prepare(`
      SELECT br.room_number FROM booking_rooms br
      JOIN bookings b2 ON b2.id = br.booking_id
      WHERE b2.tenant_id = ? AND b2.id != ? AND b2.status IN ('confirmed','checked_in')
        AND br.room_id = ?
        AND NOT (b2.check_out <= ? OR b2.check_in >= ?)
    `).get(req.tenantId, b.id, target.id, b.check_in, b.check_out);
    if (conflict) throw Object.assign(new Error('Room ' + conflict.room_number + ' is already booked for those dates'), { status: 409 });

    db.prepare('UPDATE booking_rooms SET room_id = ?, room_number = ?, rate = ? WHERE booking_id = ? AND room_id = ?')
      .run(target.id, target.number, leaving.rate, b.id, leaving.room_id);
    db.prepare("UPDATE bookings SET updated_at = datetime('now') WHERE id = ?").run(b.id);

    if (b.status === 'checked_in') {
      const displayName = b.is_group ? (b.group_name || b.guest_name) + ' (' + b.guest_name + ')' : b.guest_name;
      db.prepare(`UPDATE rooms SET status='dirty', guest_id=NULL, guest_name=NULL, checkout_label=NULL, updated_at=datetime('now') WHERE id=?`).run(leaving.room_id);
      db.prepare(`UPDATE rooms SET status='occupied', guest_id=?, guest_name=?, updated_at=datetime('now') WHERE id=?`).run(b.guest_id, displayName, target.id);
    }
    broadcast(req.tenantId, 'room.updated', db.prepare('SELECT * FROM rooms WHERE id = ?').get(leaving.room_id));
    broadcast(req.tenantId, 'room.updated', db.prepare('SELECT * FROM rooms WHERE id = ?').get(target.id));
  })();

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  audit(req, 'booking.transfer', 'booking', b.id, {
    fromRoom: leaving.room_number, toRoom: target.number,
    guestName: b.guest_name, reference: b.reference,
  });
  broadcast(req.tenantId, 'booking.updated', serialize(updated));
  res.json(serialize(updated));
});

// POST /api/bookings/:id/delete-room — remove one room from a group booking
// (desk correction when a group shrinks). The room is freed and the booking's
// stored total is NOT auto-reduced — pricing changes go through PATCH with
// pricing.manage, keeping money decisions explicit and audited.
router.post('/:id/delete-room', requirePermission('bookings.manage'), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (!b.is_group) return res.status(400).json({ error: 'Only group bookings can have a room removed individually' });
  if (['checked_out', 'cancelled'].includes(b.status)) return res.status(409).json({ error: 'This booking is ' + b.status + ' and cannot be modified' });

  const roomId = req.body && req.body.roomId;
  if (!roomId) return res.status(400).json({ error: 'A roomId is required' });
  const attached = db.prepare('SELECT * FROM booking_rooms WHERE booking_id = ?').all(b.id);
  if (attached.length <= 1) return res.status(400).json({ error: 'A group booking must keep at least one room — cancel the booking instead' });
  const leaving = attached.find(br => br.room_id === roomId);
  if (!leaving) return res.status(404).json({ error: 'That room is not part of this booking' });

  db.transaction(() => {
    db.prepare('DELETE FROM booking_rooms WHERE booking_id = ? AND room_id = ?').run(b.id, roomId);
    db.prepare(`UPDATE rooms SET status='available', guest_id=NULL, guest_name=NULL, updated_at=datetime('now') WHERE id=?`).run(roomId);
  })();
  broadcast(req.tenantId, 'room.updated', db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId));

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  audit(req, 'booking.remove_room', 'booking', b.id, { roomId, roomNumber: leaving.room_number, guestName: b.guest_name });
  broadcast(req.tenantId, 'booking.updated', serialize(updated));
  res.json(serialize(updated));
});

// ── Facility (hall/pool) engine submissions — desk workflow ─────────────────
// NOTE: these MUST be registered before the /:id/confirm, /:id/reject, …
// parameterized routes below — otherwise POST /facilities/confirm is captured
// by /:id/confirm (with id='facilities') and 404s with "Booking not found".
// GET /api/bookings/facilities/pending — every unprocessed facility submission,
// for the desk's Pending view (same page as room submissions).
router.get('/facilities/pending', requirePermission('bookings.manage'), (req, res) => {
  const halls = db.prepare(`
    SELECT hb.id, hb.engine_code AS engineCode, hb.engine_sync_status AS engineSyncStatus,
           hb.event_name AS title, hb.organizer_name AS guestName, hb.organizer_phone AS guestPhone,
           hb.event_date AS date, hb.start_time AS startTime, hb.end_time AS endTime,
           hb.guest_count AS partySize, hb.total_amount AS totalAmount, hb.status,
           'hall' AS kind, h.name AS facilityName
    FROM hall_bookings hb JOIN halls h ON h.id = hb.hall_id
    WHERE hb.tenant_id = ? AND hb.engine_sync_status = 'pending'
    ORDER BY hb.event_date ASC, hb.start_time ASC
  `).all(req.tenantId);
  const pools = db.prepare(`
    SELECT pb.id, pb.engine_code AS engineCode, pb.engine_sync_status AS engineSyncStatus,
           NULL AS title, pb.guest_name AS guestName, pb.guest_phone AS guestPhone,
           pb.date AS date, pb.start_time AS startTime, pb.end_time AS endTime,
           pb.party_size AS partySize, pb.price * pb.party_size AS totalAmount, pb.status,
           'pool' AS kind, p.name AS facilityName
    FROM pool_bookings pb JOIN pools p ON p.id = pb.pool_id
    WHERE pb.tenant_id = ? AND pb.engine_sync_status = 'pending'
    ORDER BY pb.date ASC, pb.start_time ASC
  `).all(req.tenantId);
  res.json([...halls, ...pools]);
});

// POST /api/bookings/facilities/confirm — body { code } — confirm a facility
// submission by the tender code the guest presented. Availability is
// re-validated inside the service's write transaction.
router.post('/facilities/confirm', requirePermission('bookings.manage'), (req, res) => {
  const code = req.body && req.body.code;
  if (!code) return res.status(400).json({ error: 'A tender code is required' });
  try {
    const { kind, booking } = engine.confirmFacilityByCode(req.tenantId, code, req.user.id);
    audit(req, 'facility.confirm', kind === 'hall' ? 'hall_booking' : 'pool_booking', booking.id, { code, kind, guestName: kind === 'hall' ? booking.organizer_name : booking.guest_name });
    broadcast(req.tenantId, kind === 'hall' ? 'hallbooking.updated' : 'pool.updated', booking);
    res.json({ kind, booking });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/bookings/facilities/reject — body { code, reason? }
router.post('/facilities/reject', requirePermission('bookings.manage'), (req, res) => {
  const code = req.body && req.body.code;
  if (!code) return res.status(400).json({ error: 'A tender code is required' });
  const reason = (req.body && req.body.reason) || null;
  try {
    const { kind, booking } = engine.rejectFacilityByCode(req.tenantId, code, reason, req.user.id);
    audit(req, 'facility.reject', kind === 'hall' ? 'hall_booking' : 'pool_booking', booking.id, { code, kind, reason });
    broadcast(req.tenantId, kind === 'hall' ? 'hallbooking.updated' : 'pool.updated', booking);
    res.json({ kind, booking });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Room submissions (route order: the /facilities/* routes above must stay
// ahead of these /:id/* ones, or Express captures /facilities/confirm as
// /:id/confirm with id='facilities').

// POST /api/bookings/:id/confirm — front desk tenders the guest's online
// booking code, re-validating availability inside the write transaction and
// flipping the submission to 'confirmed' (desk does NOT need pricing.manage:
// the guest's code is their offer, this is the acceptance).
router.post('/:id/confirm', requirePermission('bookings.manage'), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (!b.engine_code) return res.status(400).json({ error: 'Only online (booking-engine) submissions use code confirmation' });
  if (b.engine_sync_status !== 'pending') return res.status(409).json({ error: 'This booking was already ' + (b.engine_sync_status || 'processed') });

  try {
    const confirmed = engine.confirmByCode(req.tenantId, b.engine_code, req.user.id);
    audit(req, 'booking.confirm', 'booking', b.id, { code: b.engine_code, source: 'engine', guestName: b.guest_name, reference: b.reference });
    broadcast(req.tenantId, 'booking.updated', serialize(confirmed));
    notifyStaffOfDecision(req.tenantId, confirmed, 'CONFIRMED', req.user.name);
    res.json(serialize(confirmed));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/bookings/:id/reject — decline an online submission (room sold,
// guest unreachable, spam). Booking becomes 'cancelled' with sync status
// 'rejected'; the reason is recorded in the audit log.
router.post('/:id/reject', requirePermission('bookings.manage'), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (!b.engine_code) return res.status(400).json({ error: 'Only online (booking-engine) submissions can be rejected' });
  if (b.engine_sync_status !== 'pending') return res.status(409).json({ error: 'This booking was already ' + (b.engine_sync_status || 'processed') });

  try {
    const rejected = engine.rejectByCode(req.tenantId, b.engine_code, (req.body && req.body.reason) || null, req.user.id);
    audit(req, 'booking.reject', 'booking', b.id, { code: b.engine_code, reason: (req.body && req.body.reason) || null, guestName: b.guest_name, reference: b.reference });
    broadcast(req.tenantId, 'booking.updated', serialize(rejected));
    notifyStaffOfDecision(req.tenantId, rejected, 'REJECTED', req.user.name);
    res.json(serialize(rejected));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/bookings/:id/checkin — flips every attached room to occupied
router.post('/:id/checkin', requirePermission('bookings.manage'), idempotency, async (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (b.status !== 'confirmed') return res.status(409).json({ error: 'Only confirmed bookings can be checked in' });
  // The status guard and the write happen in one transaction, and the UPDATE
  // itself re-asserts status='confirmed'. If a concurrent request already checked
  // this booking in, `changes` is 0 and we reject rather than double-checking-in.
  let claimed = true;
  const rooms = db.prepare('SELECT * FROM booking_rooms WHERE booking_id = ?').all(b.id);
  db.transaction(() => {
    const r = db.prepare(`UPDATE bookings SET status='checked_in', updated_at=datetime('now') WHERE id=? AND status='confirmed'`).run(b.id);
    if (r.changes === 0) { claimed = false; return; }
    rooms.forEach(br => {
      db.prepare(`UPDATE rooms SET status='occupied', guest_id=?, guest_name=?, updated_at=datetime('now') WHERE id=?`)
        .run(b.guest_id, b.is_group ? (b.group_name || b.guest_name) + ' (' + b.guest_name + ')' : b.guest_name, br.room_id);
    });
  })();
  if (!claimed) return res.status(409).json({ error: 'This booking has already been checked in' });

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  audit(req, 'booking.checkin', 'booking', b.id);
  broadcast(req.tenantId, 'booking.updated', serialize(updated));
  rooms.forEach(r => broadcast(req.tenantId, 'room.updated', db.prepare('SELECT * FROM rooms WHERE id = ?').get(r.room_id)));

  // Auto-provision guest Wi-Fi for the stay (best-effort — never blocks or
  // fails the check-in). GROUP bookings get one session PER ROOM, each
  // identity named after its own room number; single bookings keep the
  // previous single-session shape. Re-running check-in reuses existing
  // credentials instead of forking them.
  let wifiResult = null;
  try {
    const provision = await wifi.provisionForBooking(req.tenantId, b, { grantedBy: req.user.id, auto: true });
    const toUi = (p) => ({
      room: p.room_number,
      identity: p.identity,
      password: p.password || undefined,
      reused: !!p.reused,
      pushedToController: !!(p.push && p.push.pushed),
      controllerNote: p.push ? p.push.detail : undefined,
    });
    wifiResult = toUi(provision);
    wifiResult.sessions = (provision.sessions || []).map(toUi);
    // Broadcast every room's provision so dashboard tiles light up per room.
    for (const s of (provision.sessions || [])) {
      if (!s.reused) broadcast(req.tenantId, 'wifi.updated', s);
    }
  } catch (e) {
    console.warn('Wi-Fi auto-provision failed for booking', b.id, ':', e.message);
  }

  res.json({ ...serialize(updated), wifi: wifiResult });
});

// POST /api/bookings/:id/checkout — flips every attached room to dirty (ready for housekeeping)
router.post('/:id/checkout', requirePermission('bookings.manage'), idempotency, async (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (b.status !== 'checked_in') return res.status(409).json({ error: 'Only checked-in bookings can be checked out' });

  // Verify there is no outstanding balance — room total unpaid, deposit shortfall,
  // or unpaid incidental charges (POS, pool, other services) posted against
  // the booking, the guest, OR any room on the booking — before check-out is
  // permitted. Uses the same resolver as the Rooms and Payments checkout
  // flows so a charge posted only against a room_number (the normal case for
  // POS/misc-service orders) can never be missed here.
  const roomNumbers = db.prepare('SELECT room_number FROM booking_rooms WHERE booking_id = ?').all(b.id).map(r => r.room_number);
  const outstanding = resolveOutstanding(req.tenantId, { bookingId: b.id, roomNumbers });
  const { roomBalance, pendingTotal, grandTotal: grandBalance } = outstanding;

  if (grandBalance > 0.005 && !req.body.forceOverride) {
    return res.status(409).json({
      error: 'Outstanding balance of ' + grandBalance.toFixed(2) + ' (' + roomBalance.toFixed(2) + ' room + ' + pendingTotal.toFixed(2) + ' other charges) must be settled before check-out',
      roomBalance, pendingTotal, grandBalance,
    });
  }
  if (req.body.forceOverride) {
    if (!hasPermission(req.user, 'payments.manage')) return res.status(403).json({ error: 'Only a manager or owner can check out a guest with an outstanding balance' });
    if (!req.body.overrideReason || !req.body.overrideReason.trim()) return res.status(400).json({ error: 'A written reason is required to override checkout with an outstanding balance' });
  }

  const rooms = db.prepare('SELECT * FROM booking_rooms WHERE booking_id = ?').all(b.id);
  let claimed = true;
  db.transaction(() => {
    const r = db.prepare(`UPDATE bookings SET status='checked_out', updated_at=datetime('now') WHERE id=? AND status='checked_in'`).run(b.id);
    if (r.changes === 0) { claimed = false; return; }
    rooms.forEach(br => {
      db.prepare(`UPDATE rooms SET status='dirty', guest_id=NULL, guest_name=NULL, checkout_label=NULL, updated_at=datetime('now') WHERE id=?`).run(br.room_id);
    });
  })();
  if (!claimed) return res.status(409).json({ error: 'This booking has already been checked out' });

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  audit(req, 'booking.checkout', 'booking', b.id, {
    forced: !!req.body.forceOverride, grandBalance,
    overrideReason: req.body.forceOverride ? req.body.overrideReason.trim() : undefined,
    guestName: b.guest_name, reference: b.reference,
  });
  broadcast(req.tenantId, 'booking.updated', serialize(updated));
  rooms.forEach(r => broadcast(req.tenantId, 'room.updated', db.prepare('SELECT * FROM rooms WHERE id = ?').get(r.room_id)));

  // Kill the guest's internet as part of departure (best-effort, after the
  // booking state is committed — a dead controller must not block checkout).
  try {
    const revoked = await wifi.revokeForBooking(req.tenantId, b.id, 'booking.checkout');
    if (revoked.length) audit(req, 'wifi.auto_revoke', 'wifi', b.id, { count: revoked.length });
  } catch (e) {
    console.warn('Wi-Fi auto-revoke failed for booking', b.id, ':', e.message);
  }

  res.json(serialize(updated));
});

// POST /api/bookings/:id/cancel — cancelling a paid reservation is a refund decision,
// so it needs the same authority as managing payments, not just desk access.
router.post('/:id/cancel', requirePermission('bookings.manage'), (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (['checked_out', 'cancelled'].includes(b.status)) return res.status(409).json({ error: 'This booking is already ' + b.status });
  if (b.status === 'checked_in') return res.status(409).json({ error: 'Check out the booking before cancelling it' });
  if (b.paid_amount > 0.005 && !hasPermission(req.user, 'payments.manage')) {
    return res.status(403).json({ error: 'This booking has ' + b.paid_amount.toFixed(2) + ' already paid — only a manager or owner can cancel it (payments.manage)' });
  }

  const r = db.prepare(`UPDATE bookings SET status='cancelled', updated_at=datetime('now') WHERE id=? AND status NOT IN ('checked_out','cancelled')`).run(b.id);
  if (r.changes === 0) return res.status(409).json({ error: 'This booking can no longer be cancelled' });
  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(b.id);
  audit(req, 'booking.cancel', 'booking', b.id);
  broadcast(req.tenantId, 'booking.updated', serialize(updated));
  res.json(serialize(updated));
});

// GET /api/bookings/:id/folio — the guest's bill.
//
// A folio has two sides and they must not be mixed: CHARGES (what the guest owes —
// the room, plus incidentals posted to the folio) and PAYMENTS (what they have
// handed over). Both live in the same `transactions` table, distinguished by
// method: a settlement/booking payment is money IN, a 'Room Charge' /
// 'Customer Bill' / 'Group Account' posting is money OWED. Summing the whole table
// as "incidentals" counted every payment as a further charge, so paying a 200 bill
// made the folio read 400 and the guest could never reach zero.
const PAYMENT_METHODS = new Set(['Cash', 'Card', 'Bank', 'Transfer', 'Paystack', 'Stripe', 'Flutterwave']);
function isChargePosting(t) {
  return ['Room Charge', 'Customer Bill', 'Group Account'].includes(t.method);
}

router.get('/:id/folio', (req, res) => {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(req.params.id, req.tenantId);
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  const rows = db.prepare('SELECT * FROM transactions WHERE booking_id = ? ORDER BY created_at DESC').all(b.id);
  const live = rows.filter(t => t.status !== 'failed' && t.status !== 'refunded');

  const charges = live.filter(isChargePosting);
  const payments = live.filter(t => !isChargePosting(t) && t.status === 'completed');

  const roomTotal = b.total_amount;
  const incidentalsTotal = charges.reduce((s, c) => s + c.amount, 0);
  const paidTotal = payments.reduce((s, p) => s + p.amount, 0);
  const grandTotal = roomTotal + incidentalsTotal;

  res.json({
    booking: serialize(b),
    charges, payments,
    roomTotal, incidentalsTotal, paidTotal,
    grandTotal,
    balanceDue: Math.max(0, Math.round((grandTotal - paidTotal) * 100) / 100),
  });
});

module.exports = router;
