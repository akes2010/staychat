// server/services/engine-notifications.js
// Staff-side WhatsApp notifications for the booking engine.
//
// Split from the guest-facing messages in booking-engine.js: this service is
// about telling THE HOTEL, not the guest. Recipients are every ACTIVE user of
// the tenant whose effective capabilities include bookings.manage (admins and
// front-desk by default; custom-permission users included when granted).
//
// Delivery rules:
// - Fire-and-forget: never awaited by the request path.
// - Missing WhatsApp credentials or no reachable staff → skip silently.
// - One failing recipient never blocks the others.
'use strict';

const db = require('../db/connection');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { effectivePermissions } = require('../utils/permissions');

/**
 * Active staff of the tenant who should know about desk-relevant events.
 * Uses effectivePermissions so per-user customization is honored; a phone
 * number is required (someone without one can't be messaged anyway).
 */
function staffForNotifications(tenantId) {
  return db.prepare(`
    SELECT id, name, phone, role, permissions, permissions_customized
    FROM users
    WHERE tenant_id = ? AND active = 1 AND phone IS NOT NULL AND phone != ''
  `).all(tenantId).filter(u => effectivePermissions(u).includes('bookings.manage'));
}

function hotel(tenantId) {
  return db.prepare('SELECT name, phone, email FROM tenants WHERE id = ?').get(tenantId) || {};
}

function submissionStaffText(tenantId, b) {
  const h = hotel(tenantId);
  return `🔔 ${h.name || 'Hotel'} — new online booking\n\n` +
    `Code: ${b.code}\n` +
    `Guest: ${b.guestName}\n` +
    `Phone: ${b.guestPhone}\n` +
    `Dates: ${b.checkIn} → ${b.checkOut}\n` +
    `Total: ${b.total} (pay at hotel)\n\n` +
    `Open StayChat → Bookings → Pending to confirm.`;
}

function decisionStaffText(tenantId, b, verb) {
  const h = hotel(tenantId);
  return `${h.name || 'Hotel'}: online booking ${b.reference} (${b.code}) was ${verb} by ${b.actor}.`;
}

/**
 * Notify all desk staff of a new engine submission.
 * Safe to call without await; never throws.
 */
function notifyStaffOfSubmission(tenantId, payload) {
  try {
    const staff = staffForNotifications(tenantId);
    if (!staff.length) return;
    const text = submissionStaffText(tenantId, payload);
    Promise.all(staff.map(u =>
      sendWhatsAppMessage(tenantId, u.phone, text).catch(() => { /* one recipient failing is fine */ })
    )).catch(() => { });
  } catch (e) {
    console.warn('[engine-staff-notify] failed:', e.message);
  }
}

/**
 * Notify staff that a submission was confirmed/rejected (by code, so the
 * message ties the decision to the code the guest presented).
 */
function notifyStaffOfDecision(tenantId, booking, verb, actorName) {
  try {
    const staff = staffForNotifications(tenantId);
    if (!staff.length) return;
    const text = decisionStaffText(tenantId, {
      reference: booking.reference,
      code: booking.engine_code,
      actor: actorName || 'a colleague',
    }, verb);
    Promise.all(staff.map(u =>
      sendWhatsAppMessage(tenantId, u.phone, text).catch(() => { })
    )).catch(() => { });
  } catch (e) {
    console.warn('[engine-staff-notify] failed:', e.message);
  }
}

module.exports = {
  staffForNotifications,
  notifyStaffOfSubmission,
  notifyStaffOfDecision,
};
