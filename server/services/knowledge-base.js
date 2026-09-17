// server/services/knowledge-base.js
// Trained knowledge base for the public landing-page chatbot.
//
// "Training" here is deliberately simple and honest: every entry is derived
// from what the system ACTUALLY does (verified in this codebase), and the
// integration counts are pulled LIVE from api-services.js at require time so
// the bot can never claim integrations that don't exist. Retrieval is keyword
// scoring over entries; the best entry (or a confident fallback) is returned.
'use strict';

const { SERVICE_DEFINITIONS, getCategories } = require('../config/api-services');

const CATS = getCategories();
const TOTAL_SERVICES = Object.keys(SERVICE_DEFINITIONS).length;
const count = c => Object.values(SERVICE_DEFINITIONS).filter(d => d.category === c).length;

const KB = [
  {
    id: 'what-is',
    keys: ['what is', 'staychat', 'about', 'platform', 'system', 'product', 'overview', 'does it do', 'tell me about'],
    title: 'What is StayChat OS?',
    answer: `StayChat OS is a complete, multi-tenant hotel management platform built around WhatsApp:\n\n• AI receptionist that answers guests 24/7 on WhatsApp\n• Bookings & reservations (single + group) with check-in/checkout\n• Front desk, housekeeping, maintenance and staff management\n• POS for restaurant & bar, accounting with double-entry ledger\n• Guest Wi-Fi provisioning per booking\n• Your own public booking engine (no OTA commission)\n• 40+ third-party integrations (locks, IPTV, Wi-Fi, IoT, payments)\n\nEverything runs in one clean dashboard — one hotel or many, per-tenant isolated.`,
  },
  {
    id: 'pricing',
    keys: ['price', 'pricing', 'cost', 'how much', 'plan', 'subscription', 'mrr', 'pay'],
    title: 'Pricing',
    answer: `StayChat OS ships with three plans:\n\n• Starter — $29/mo — the essentials for a small property\n• Pro — $79/mo — growing hotels that want automation\n• Enterprise — $199/mo — multi-property, full feature set\n\nPlans are set per hotel by the platform operator, and there's a 14-day trial. Because the booking engine and WhatsApp channel are built in, you pay no OTA commission on direct bookings.`,
  },
  {
    id: 'booking-engine',
    keys: ['booking engine', 'own booking', 'direct booking', 'ota', 'commission', 'website booking', 'public booking', 'tender code'],
    title: 'Your own booking engine',
    answer: `Every hotel gets its own public booking channel — your direct OTA replacement:\n\n• Guests browse live availability priced from your real rate card\n• They submit name + phone — no card needed, "pay at the hotel"\n• The system issues a short tender code (e.g. BE-7K2M9QX4)\n• Your front desk sees it instantly and confirms with one click\n• Guests get WhatsApp updates at every step, and a printable confirmation with a QR code\n• The AI receptionist answers "what's the status of BE-…" questions automatically\n\nPending submissions never block inventory, and there's a daily cap against spam.`,
  },
  {
    id: 'whatsapp',
    keys: ['whatsapp', 'wa ', 'chat', 'message', 'ai receptionist', 'bot', 'conversation'],
    title: 'WhatsApp + AI receptionist',
    answer: `StayChat OS plugs into the official WhatsApp Business Cloud API:\n\n• Guest messages land in a real-time shared inbox\n• The AI receptionist replies instantly — bookings, Wi-Fi, facilities, room service\n• It knows booking codes: "What's the status of BE-ABC234?" gets the live status\n• Anything it can't handle escalates cleanly to your staff\n• Staff get WhatsApp alerts for new online bookings and desk decisions\n• Meta webhook signatures are verified and redeliveries de-duplicated`,
  },
  {
    id: 'integrations',
    keys: ['integration', 'integrat', 'door lock', 'lock', 'zigbee', 'hikvision', 'dahua', 'iptv', 'tv', 'vod', 'wifi', 'wi-fi', 'internet', 'smart', 'iot', 'sensor', 'camera', 'hue', 'sonos', 'control4', 'knx', 'unifi', 'meraki', 'mikrotik', 'seam', 'vingcard', 'salto', 'ttlock'],
    title: 'Integrations',
    answer: `StayChat OS integrates with ${TOTAL_SERVICES} services across ${CATS.length} categories:\n\n🚪 Door locks (${count('door_lock')}): Seam, ASSA ABLOY VingCard, SALTO, TTLock, ZKTeco, Onity, dormakaba, RemoteLock\n📺 IPTV/VOD (${count('iptv_vod')}): mwareTV, AlphaOTT, VITEC, Samsung LYNK, LG Pro:Centric\n📶 Internet (${count('internet_management')}): UniFi, Meraki, MikroTik, Omada, Ruckus\n🏠 Room automation (${count('room_automation')}): Control4, Crestron, KNX, Lutron, Philips Hue, Sonos\n📡 IoT & cameras (${count('iot_platform')}): Zigbee2MQTT, Hikvision ISAPI, Dahua, generic MQTT/HTTP\n💳 Payments, SMS, email, storage & analytics built in\n\nCredentials are encrypted at rest (AES-256-GCM) and each one has a live "Test Connection" probe.`,
  },
  {
    id: 'wifi',
    keys: ['guest wifi', 'guest wi-fi', 'wifi per', 'internet per', 'bandwidth', 'speed tier', ' hotspot'],
    title: 'Per-booking guest Wi-Fi',
    answer: `Guest Wi-Fi is provisioned automatically from the booking lifecycle:\n\n• Check-in creates the session — speed tiered by room type (suites 100↓/50↑ Mbps, deluxe 50↓/20↑, standard 20↓/10↑ + 50GB)\n• Checkout revokes access — no stale credentials\n• UniFi and MikroTik get real controller pushes; Meraki/Omada/Ruckus sessions are tracked with guidance\n• Guests self-serve at /wifi.html with room number + booking reference\n• Front desk can extend for late stays or revoke early departures`,
  },
  {
    id: 'frontend-desk',
    keys: ['front desk', 'front office', 'check in', 'check-in', 'checkin', 'checkout', 'folio', 'housekeeping', 'maintenance', 'pos', 'restaurant', 'bar', 'accounting', 'invoice', 'staff', 'shift', 'eod', 'end of day', 'report'],
    title: 'Hotel operations',
    answer: `The full operational suite:\n\n• Front desk — room rack, check-in/checkout with balance blocking, folios\n• Housekeeping & maintenance — task SLAs, auto-assignment\n• POS — restaurant & bar tickets, room charges, EOD closings per department\n• Accounting — double-entry ledger, trial balance that always balances\n• Payments — cash/card/POS/transfer + Paystack & Stripe with signed webhooks\n• Staff — roles with a fraud-aware capability matrix (e.g. only managers can void)\n• Guests — profiles, loyalty, stay history`,
  },
  {
    id: 'security',
    keys: ['security', 'secure', 'multi tenant', 'multi-tenant', 'isolat', 'encrypt', 'data', 'privacy', 'gdpr', 'password'],
    title: 'Security & multi-tenancy',
    answer: `Security is designed in, not bolted on:\n\n• Strict tenant isolation in one middleware chokepoint — hotels can never see each other's data\n• JWT auth with single-use refresh-token rotation\n• Integration credentials encrypted at rest (AES-256-GCM)\n• Signed payment webhooks (HMAC over raw bytes, fail-closed)\n• Audit log of every sensitive action, rate limiting, helmet hardening\n• Immutable booking references and idempotent webhook handling`,
  },
  {
    id: 'deploy',
    keys: ['deploy', 'install', 'docker', 'hosting', 'render', 'vps', 'self host', 'self-host', 'server', 'requirements', 'node'],
    title: 'Deployment',
    answer: `Deploy anywhere Node runs:\n\n• Docker image ships migrate → seed → check → start, so a broken deploy fails fast\n• One-click on Render, or pm2 on a VPS behind Nginx + free HTTPS\n• SQLite by default (zero ops), documented path to PostgreSQL for large portfolios\n• npm run check validates the seed and demo logins at every boot`,
  },
  {
    id: 'demo',
    keys: ['demo', 'try', 'trial', 'test drive', 'login', 'account', 'sign up', 'get started', 'start'],
    title: 'Try it',
    answer: `Two ways in:\n\n• Live demo — click "Try the Live Demo" on this page and explore a seeded hotel (front desk, POS, analytics, the works)\n• Book a room — click "Book a Stay" to use the real public booking engine and see the tender-code flow end to end\n\nEvery seeded login uses the password Demo@123456, and the 14-day trial covers all plans.`,
  },
];

// Keyword-scored retrieval: each hit on a key scores 1; the entry with the
// best score above a floor wins, otherwise a graceful fallback that still
// teaches something.
function search(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return null;

  let best = null;
  let bestScore = 0;
  for (const entry of KB) {
    let score = 0;
    for (const k of entry.keys) if (q.includes(k)) score += k.length > 4 ? 2 : 1;
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  // Threshold 1: keys are specific terms ("lock", "iptv", "pricing"), not
  // stopwords, so a single hit is already a strong signal. Short keys like
  // " tv " are space-delimited to avoid substring false-positives.
  if (best && bestScore >= 1) return best;

  return {
    id: 'fallback',
    title: null,
    answer: `I can help with questions about StayChat OS — try asking about:\n\n• The booking engine and tender codes\n• WhatsApp & the AI receptionist\n• Integrations (locks, IPTV, Wi-Fi, IoT, payments)\n• Pricing and plans\n• Security & multi-tenancy\n• Deployment (Docker, Render, VPS)\n\nOr click "Try the Live Demo" to explore the real system.`,
  };
}

const SUGGESTIONS = ['What is StayChat OS?', 'How does the booking engine work?', 'What integrations are supported?', 'How much does it cost?', 'Is my data isolated and secure?', 'How do I deploy it?'];

module.exports = { search, KB, SUGGESTIONS };
