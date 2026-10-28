// server/ai/receptionist.js
// AI Receptionist — real LLM calls with a deterministic offline fallback.
//
// Priority order per reply:
//   1. Tender-code lookup (deterministic, always on — it reads the DB, not a model)
//   2. Tenant-configured LLM (Settings → AI: provider + model + API key), if active
//   3. Platform-wide key from env (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY)
//   4. Keyword rules (offline fallback) — so the product never breaks without keys
//
// Callers: webhooks.js and inbox.js use the ASYNC getAIReplyAsync when they can
// await; the sync getAIReply stays for compatibility and runs LLM-safe only when
// a cached reply already exists (it never blocks on HTTP).
'use strict';

const db = require('../db/connection');
const { decrypt } = require('../utils/crypto-store');

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

// ── Offline fallback rules (always available, zero cost) ────────────────────
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

function fallbackReply(messageText) {
  const lower = String(messageText || '').toLowerCase();
  for (const rule of RULES) {
    if (rule.keys.some(k => lower.includes(k))) return rule.reply();
  }
  return `Thanks for your message! I've noted your request and a member of our team will follow up shortly. Is there anything else I can help with in the meantime?`;
}

// ── Provider resolution ─────────────────────────────────────────────────────
// ai_configs.api_key is encrypted at rest (crypto-store v1: blob, see
// routes/ai-config.js); legacy plaintext rows are still accepted here — both
// decode.
function configApiKey(config) {
  if (!config || !config.api_key) return null;
  if (typeof config.api_key === 'string' && config.api_key.startsWith('v1:')) {
    try { return decrypt(config.api_key); } catch (e) { return null; }
  }
  return config.api_key;
}

// Tenant's own active config for a role (default: receptionist), else platform env keys.
function resolveProvider(tenantId, agentRole) {
  if (tenantId) {
    const cfg = db.prepare(
      `SELECT * FROM ai_configs WHERE tenant_id = ? AND agent_role = ? AND active = 1 AND api_key IS NOT NULL AND api_key != ''
       ORDER BY created_at DESC LIMIT 1`
    ).get(tenantId, agentRole || 'receptionist');
    if (cfg) {
      const key = configApiKey(cfg);
      if (key) return { provider: cfg.provider, model: cfg.model || defaultModel(cfg.provider), apiKey: key, label: cfg.label, source: 'tenant' };
    }
  }
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', model: 'claude-3-5-haiku-latest', apiKey: process.env.ANTHROPIC_API_KEY, source: 'platform' };
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY, source: 'platform' };
  if (process.env.OPENROUTER_API_KEY) return { provider: 'openrouter', model: 'openai/gpt-4o-mini', apiKey: process.env.OPENROUTER_API_KEY, source: 'platform' };
  return null;
}

function defaultModel(provider) {
  switch (provider) {
    case 'anthropic': return 'claude-3-5-haiku-latest';
    case 'openai': return 'gpt-4o-mini';
    case 'qwen': return 'qwen-plus';
    case 'deepseek': return 'deepseek-chat';
    case 'openrouter': return 'openai/gpt-4o-mini';
    case 'kimi': return 'moonshot-v1-8k';
    case 'zai': return 'glm-4-flash';
    default: return null;
  }
}

const ENDPOINTS = {
  anthropic: { url: 'https://api.anthropic.com/v1/messages', style: 'anthropic' },
  openai: { url: 'https://api.openai.com/v1/chat/completions', style: 'openai' },
  qwen: { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', style: 'openai' },
  deepseek: { url: 'https://api.deepseek.com/chat/completions', style: 'openai' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', style: 'openai' },
  kimi: { url: 'https://api.moonshot.cn/v1/chat/completions', style: 'openai' },
  zai: { url: 'https://api.z.ai/api/paas/v4/chat/completions', style: 'openai' },
};

// ── LLM call (hardened) ─────────────────────────────────────────────────────
// node:https request with `family: 4` keeps every LLM call on IPv4. (Node ≥20
// defaults to Happy Eyeballs, which on some hardened hosts resolves the api
// hosts to unroutable IPv6 and every call fails with ETIMEDOUT — the reported
// serverless/on-prem failure mode. Node's global fetch/undici ignores the
// `agent` option, so we drive https.request directly.) 10s connect / 30s total
// timeouts bound worst-case latency; webhooks get a fast answer either way.
const https = require('https');

function llmFetch(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const req = https.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      family: 4,
      timeout: 10000, // connect/idle timeout → 'timeout' event / ECONNRESET
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = body ? JSON.parse(body) : {}; } catch (e) { /* non-JSON error body */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('LLM request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    const overall = setTimeout(() => req.destroy(Object.assign(new Error('LLM request exceeded 30s'), { code: 'ETIMEDOUT' })), 30000);
    req.on('close', () => clearTimeout(overall));
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function callLLM(provider, model, apiKey, systemPrompt, userText) {
  const ep = ENDPOINTS[provider];
  if (!ep) throw new Error('Unknown provider: ' + provider);

  let res;
  if (ep.style === 'anthropic') {
    res = await llmFetch(ep.url, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 300, system: systemPrompt, messages: [{ role: 'user', content: userText }] }),
    });
    const data = res.json;
    if (!res.ok) throw new Error('Anthropic API ' + res.status + (data.error?.message ? ': ' + data.error.message : ''));
    const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    if (!text) throw new Error('Anthropic returned an empty reply');
    return text;
  }

  // OpenAI-compatible (openai, qwen, deepseek, openrouter, kimi, zai)
  res = await llmFetch(ep.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 300, temperature: 0.4, messages: [
      { role: 'system', content: systemPrompt }, { role: 'user', content: userText }] }),
  });
  const data = res.json;
  if (!res.ok) throw new Error(provider + ' API ' + res.status + (data.error?.message ? ': ' + data.error.message : ''));
  const text = (data.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error(provider + ' returned an empty reply');
  return text;
}

function buildSystemPrompt(tenant, tone) {
  const name = tenant?.name || 'the hotel';
  return [
    `You are the AI Receptionist of "${name}", reachable by guests over WhatsApp and web chat. You are ${tone === 'Friendly' ? 'warm and informal' : tone === 'Concise' ? 'terse and efficient' : 'professional and courteous'}.`,
    `Rules:`,
    `- Answer ONLY as this hotel's receptionist. Stay on hospitality topics (bookings, rooms, amenities, room service, Wi-Fi, checkout, directions, facilities).`,
    `- You cannot see live reservations or bills unless the guest provides a booking code — if asked about a specific booking without a code, invite them to send it (codes look like BE-7K2M9QX4) or to contact the front desk.`,
    `- Never invent prices, availability, or policies. Offer to have staff confirm specifics.`,
    `- For complaints or emergencies, apologize briefly, say the team has been notified, and that staff will follow up shortly.`,
    `- Keep replies under 120 words, plain text, no markdown headings. Match the guest's language.`,
  ].join('\n');
}

function tenantById(tenantId) {
  if (!tenantId) return null;
  try { return db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) || null; } catch (e) { return null; }
}

/**
 * Async AI reply: tender-code lookup → tenant/platform LLM → keyword fallback.
 * Same semantics as getAIReply, but can await the model and report the source.
 * @returns {Promise<{text: string, source: 'booking'|'llm'|'rules'}>}
 */
async function getAIReplyAsync(messageText, tenantId, opts = {}) {
  const text = String(messageText || '');

  // Highest priority: a tender code in the message is an explicit booking
  // status query. A missing tenantId means the caller can't scope the lookup —
  // fall through rather than ever answering across tenants.
  const codeMatch = tenantId ? text.toUpperCase().match(CODE_RE) : null;
  if (codeMatch) {
    try {
      return { text: getEngineBookingReply(tenantId, codeMatch[0]), source: 'booking' };
    } catch (e) {
      console.warn('[ai] engine booking lookup failed:', e.message);
    }
  }

  const provider = resolveProvider(tenantId, opts.agentRole);
  if (provider) {
    try {
      const tenant = tenantById(tenantId);
      const tone = opts.tone || tenant?.ai_tone || 'Professional';
      const reply = await callLLM(provider.provider, provider.model, provider.apiKey, buildSystemPrompt(tenant, tone), text.slice(0, 2000));
      return { text: reply, source: 'llm' };
    } catch (e) {
      console.error('[ai] LLM call failed (' + (provider.label || provider.provider) + '):', e.message, '— falling back to rules');
    }
  }

  return { text: fallbackReply(text), source: 'rules' };
}

/**
 * Build the AI reply for an incoming guest message (sync compatibility API).
 * The sync path cannot await HTTP: it serves tender-code lookups and the
 * offline rules. Callers that CAN await should use getAIReplyAsync — the
 * webhook and inbox routes do.
 * @param {string} messageText  the guest's message
 * @param {string} [tenantId]   tenant the message arrived for — enables the
 *                              tender-code booking lookup
 */
function getAIReply(messageText, tenantId) {
  const text = String(messageText || '');

  const codeMatch = tenantId ? text.toUpperCase().match(CODE_RE) : null;
  if (codeMatch) {
    try {
      return getEngineBookingReply(tenantId, codeMatch[0]);
    } catch (e) {
      console.warn('[ai] engine booking lookup failed:', e.message);
    }
  }

  return fallbackReply(text);
}

module.exports = { getAIReply, getAIReplyAsync };
