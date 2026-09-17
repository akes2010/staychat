// server/ai/receptionist.js
// Lightweight keyword-based AI receptionist. This is a deterministic stand-in
// for a real LLM call (Claude API) so the app works fully offline/standalone.
//
// To upgrade to a real model: replace getAIReply() body with a call to
// POST https://api.anthropic.com/v1/messages using ANTHROPIC_API_KEY from env,
// passing the tenant's system prompt (built from `tenant` row) + conversation
// history. Keep the same function signature so nothing else needs to change.

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

function getAIReply(messageText) {
  const lower = (messageText || '').toLowerCase();
  for (const rule of RULES) {
    if (rule.keys.some(k => lower.includes(k))) return rule.reply();
  }
  return `Thanks for your message! I've noted your request and a member of our team will follow up shortly. Is there anything else I can help with in the meantime?`;
}

module.exports = { getAIReply };
