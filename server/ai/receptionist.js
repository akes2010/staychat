// server/ai/receptionist.js
// Lightweight keyword-based AI receptionist. This is a deterministic stand-in
// for a real LLM call (Claude API) so the app works fully offline/standalone.
//
// To upgrade to a real model: keep this file's shape — the tender-code lookup
// (getEngineBookingReply) and these RULES become tools/context you pass to the
// LLM instead of keyword branches. Keep the same function signature so nothing
// else needs to change.

const db = require('../db/connection');

// Tender codes look like BE-7K2M9QX4 (see services/booking-engine.js).
const CODE_RE = /\bBE-?[2-9A-Z]{6}\b/i;

// Booking-engine status → guest-facing answer. Tenant-scoped by construction:
// the caller passes the tenant the message arrived for, and the lookup filters
// on it — one hotel's guests can never read another hotel's bookings.
function getEngineBookingReply(tenantId, codeRaw) {
  const code = String(codeRaw).trim().toUpperCase().replace(/^BE-?/, 'BE-');
  const b = db.prepare('SELECT * FROM bookings WHERE tenant_id = ? AND engine_code = ?').get(tenantId, code);
  if (!b) {
    return `I couldn't find a booking with code ${code}. Please double-check it — or send your booking reference (BK-…) together with the phone number you used to book, and I'll look it up.`;
  }
  const rooms = db.prepare('SELECT room_number FROM booking_rooms WHERE booking_id = ?').all(b.id).map(r => r.room_number).join(', ');
  const stay = `Room${rooms.includes(',') ? 's' : ''} ${rooms} · ${b.check_in} → ${b.check_out}`;

  switch (b.status) {
    case 'pending_payment':
      return `I found your booking ${b.reference} (code ${b.engine_code}) — ${stay}, total ${b.total_amount.toFixed(2)}.\n\nIt's awaiting confirmation at our front desk. Present your code at the desk (or call us) and we'll confirm your room right away.`;
    case 'confirmed':
      return `✅ Your booking ${b.reference} is CONFIRMED — ${stay}. We look forward to welcoming you! Present your code at the front desk on arrival for a smooth check-in.`;
    case 'checked_in':
      return `You're checked in — enjoy your stay! ${stay}. Your guest Wi-Fi credentials are available at the front desk or on your key sleeve.`;
    case 'checked_out':
      return `Booking ${b.reference} is completed — thank you for staying with us! We'd love to welcome you back anytime.`;
    case 'cancelled':
      return `Booking ${b.reference} was cancelled${b.engine_sync_status === 'rejected' ? ' (we could not hold the room for those dates)' : ''}. If that's unexpected, please contact the front desk and we'll gladly help you rebook.`;
    default:
      return `Booking ${b.reference} is currently: ${b.status.replace('_', ' ')}. Contact the front desk for details.`;
  }
}

const RULES = [
  { keys: ['book', 'room', 'reserve', 'availability'],
    reply: () => `Great! I'd love to help you book a room. We have several room types available — could you tell me your preferred dates and number of guests? I'll check availability right away.` },
  { keys: ['checkout', 'check out', 'check-out', 'leaving', 'bill'],
    reply: () => `Sure! I can prepare your checkout summary now. One moment while I pull up your folio — I'll send the total and a secure payment link shortly.` },
  { keys: ['wifi', 'internet', 'password'],
    reply: () => `Here are your WiFi details:\n\nNetwork: HotelGuest_5G\nPassword: Welcome2024\n\nLet me know if you need anything else!` },
  { keys: ['food', 'menu', 'eat', 'hungry', 'order', 'room service'],
    reply: () => `Happy to help with room service! Could you tell me what you'd like to order and your room number? I'll get it sent to the kitchen right away.` },
  { keys: ['pool', 'spa', 'gym', 'facilities'],
    reply: () => `Our facilities:\nPool: 7AM–10PM (Rooftop)\nSpa: 9AM–8PM (Level 3)\nGym: 24/7 (Level 2)\nBar: 11AM–1AM (Lobby)\n\nAll complimentary for guests. Enjoy!` },
  { keys: ['complaint', 'problem', 'issue', 'broken', 'not working'],
    reply: () => `I'm really sorry to hear that. I've logged this and notified our team immediately — someone will follow up with you shortly. Thank you for your patience.` },
  { keys: ['late checkout', 'extend', 'extra night'],
    reply: () => `Of course! Late checkout options:\nUntil 1PM — Free (subject to availability)\nUntil 2PM — $25\nUntil 4PM — $50\n\nWhich would you like? I'll update your reservation right away.` },
  { keys: ['hello', 'hi', 'hey', 'good morning', 'good evening'],
    reply: () => `Hello! Welcome — I'm your AI Receptionist, here 24/7 to help with bookings, room service, housekeeping, and anything else you need during your stay. How can I help?` },
  { keys: ['thank', 'thanks'],
    reply: () => `You're very welcome! Is there anything else I can help you with?` },
];

/**
 * Build the AI reply for an incoming guest message.
 * @param {string} messageText  the guest's message
 * @param {string} [tenantId]   tenant the message arrived for — enables the
 *                              tender-code booking lookup (WhatsApp webhooks
 *                              always pass it; other callers may omit it)
 */
function getAIReply(messageText, tenantId) {
  const text = String(messageText || '');

  // Highest priority: a tender code in the message is an explicit booking
  // status query ("BE-7K2M9QX4", "my code is be 7k2m9q", "what's BE7K2M9QX4?").
  // A missing tenantId means the caller can't scope the lookup — fall through
  // to the keyword rules rather than ever answering across tenants.
  const codeMatch = tenantId ? text.toUpperCase().match(CODE_RE) : null;
  if (codeMatch) {
    try {
      return getEngineBookingReply(tenantId, codeMatch[0]);
    } catch (e) {
      console.warn('[ai] engine booking lookup failed:', e.message);
      // fall through to keyword rules
    }
  }

  const lower = text.toLowerCase();
  for (const rule of RULES) {
    if (rule.keys.some(k => lower.includes(k))) return rule.reply();
  }
  return `Thanks for your message! I've noted your request and a member of our team will follow up shortly. Is there anything else I can help with in the meantime?`;
}

module.exports = { getAIReply };
