// server/utils/balance.js
//
// Single source of truth for "what does this room/guest/booking still owe".
//
// Root cause of the "paid but won't check out" bug: checkout-check computed
// pending charges with (room_number OR guest_id OR booking_id) — an OR across
// every possible link — while /payments/settle and /payments/balance each
// picked only ONE of those fields to filter by (bookingId if resolvable,
// else guestId, else roomNumber). A POS/misc-service charge created with
// room_number set but no booking_id (the normal case — see misc-services.js,
// pos.js) would be counted as "due" by checkout-check but silently skipped
// by /settle whenever an active booking existed for the room, because /settle
// switched to filtering by booking_id alone. The guest would pay, the system
// would say "settled", but the charge stayed 'pending' in the database —
// so checkout-check still blocked checkout, while a follow-up /balance call
// filtered by a different single field could still miss it and wrongly
// report "no outstanding balance". All three endpoints now go through this
// one function so the amount shown, the amount settled, and the amount
// re-checked afterward can never disagree.
const db = require('../db/connection');

function findActiveBookingForRoom(tenantId, roomId) {
  return db.prepare(`
    SELECT b.* FROM booking_rooms br JOIN bookings b ON b.id = br.booking_id
    WHERE br.room_id = ? AND b.tenant_id = ? AND b.status = 'checked_in'
  `).get(roomId, tenantId);
}

// Resolves room/booking/guest context from whichever identifiers are given,
// then finds every pending transaction linked to ANY of them (room_number OR
// guest_id OR booking_id — union, not a single priority filter).
// `roomNumbers` is for group bookings spanning multiple rooms — pass every
// room number on the booking so a charge posted against any one of them
// still counts toward the group's outstanding balance.
function resolveOutstanding(tenantId, { roomId, roomNumber, roomNumbers, guestId, bookingId } = {}) {
  let room = null;
  if (roomId) room = db.prepare('SELECT * FROM rooms WHERE id = ? AND tenant_id = ?').get(roomId, tenantId);
  else if (roomNumber) room = db.prepare('SELECT * FROM rooms WHERE tenant_id = ? AND number = ?').get(tenantId, roomNumber);

  let booking = null;
  if (bookingId) booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND tenant_id = ?').get(bookingId, tenantId);
  else if (room) booking = findActiveBookingForRoom(tenantId, room.id);

  const resolvedGuestId = guestId || (room && room.guest_id) || (booking && booking.guest_id) || null;
  const resolvedRoomNumber = (room && room.number) || roomNumber || null;
  const resolvedBookingId = (booking && booking.id) || bookingId || null;
  const allRoomNumbers = Array.from(new Set([
    ...(resolvedRoomNumber ? [resolvedRoomNumber] : []),
    ...(Array.isArray(roomNumbers) ? roomNumbers.filter(Boolean) : []),
  ]));

  // What the room still owes = total minus money actually received.
  //
  // `deposit_amount` used to be subtracted here as well. It is a free-text number on
  // the reservation with no transaction behind it, so subtracting it meant anyone who
  // could create a booking could set depositAmount = totalAmount and the guest would
  // check out owing nothing, having paid nothing — invisible to the ledger, the
  // transaction list and the EOD close. Deposits are now collected through the normal
  // payment path (see routes/bookings.js), which writes a real transaction and
  // increments paid_amount, so they are already counted here.
  const roomBalance = booking ? Math.max(0, booking.total_amount - booking.paid_amount) : 0;

  const clauses = [];
  const params = [tenantId];
  allRoomNumbers.forEach(rn => { clauses.push('room_number = ?'); params.push(rn); });
  if (resolvedGuestId) { clauses.push('guest_id = ?'); params.push(resolvedGuestId); }
  if (resolvedBookingId) { clauses.push('booking_id = ?'); params.push(resolvedBookingId); }

  let pending = [];
  if (clauses.length) {
    pending = db.prepare(`SELECT * FROM transactions WHERE tenant_id = ? AND status = 'pending' AND (${clauses.join(' OR ')})`).all(...params);
  }
  const pendingTotal = pending.reduce((s, t) => s + t.amount, 0);

  return {
    room, booking,
    guestId: resolvedGuestId, roomNumber: resolvedRoomNumber, bookingId: resolvedBookingId,
    roomBalance, pendingTotal, pendingCount: pending.length, transactions: pending,
    grandTotal: roomBalance + pendingTotal,
  };
}

module.exports = { resolveOutstanding, findActiveBookingForRoom };
