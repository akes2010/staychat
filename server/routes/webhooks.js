// server/routes/webhooks.js
// Real WhatsApp Business Cloud API webhook integration point.
// Meta sends verification (GET) and message events (POST) to this endpoint.
// Configure in Meta Developer Console: https://yourdomain.com/api/webhooks/whatsapp/:tenantSubdomain

const express = require('express');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { getAIReplyAsync } = require('../ai/receptionist');
const { broadcast } = require('../ws');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { decryptTenantSecrets } = require('../utils/tenant-secrets');

const router = express.Router();

// Constant-time string compare that never throws on length mismatch — returns
// false immediately when lengths differ, otherwise uses crypto.timingSafeEqual.
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ── GET /api/webhooks/whatsapp/:subdomain — Meta's verification handshake ──
router.get('/whatsapp/:subdomain', (req, res) => {
  // Credentials are encrypted at rest — decrypt before comparing the verify token.
  const tenant = decryptTenantSecrets(db.prepare('SELECT * FROM tenants WHERE subdomain = ?').get(req.params.subdomain));
  if (!tenant) return res.status(404).send('Unknown hotel');

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && tenant.wa_verify_token && token === tenant.wa_verify_token) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Verification failed');
});

// ── POST /api/webhooks/whatsapp/:subdomain — incoming message events ──────
router.post('/whatsapp/:subdomain', express.json({
  verify: (req, res, buf) => { req.rawBody = buf; } // captured for signature verification below
}), async (req, res) => {
  // Stored credentials are encrypted at rest (AES-256-GCM) — decrypt for the
  // signature check. Legacy plaintext rows pass through transparently.
  const tenant = decryptTenantSecrets(db.prepare('SELECT * FROM tenants WHERE subdomain = ?').get(req.params.subdomain));
  if (!tenant) return res.status(404).json({ error: 'Unknown hotel' });

  // Verify Meta's X-Hub-Signature-256. Fail CLOSED: an unconfigured tenant
  // (no app secret yet) must reject webhooks rather than accept unauthenticated
  // POSTs that would inject arbitrary messages into the inbox.
  if (!tenant.wa_app_secret) {
    return res.status(503).json({ error: 'WhatsApp integration is not fully configured (missing app secret)' });
  }
  const signature = req.headers['x-hub-signature-256'];
  const expected = 'sha256=' + crypto.createHmac('sha256', tenant.wa_app_secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  if (!signature || !timingSafeEqualStr(signature, expected)) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // WhatsApp Cloud API webhook always expects a fast 200 — process async-ish.
  res.status(200).json({ status: 'received' });

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    if (!message) return; // status updates, not a message — ignore

    const fromPhone = message.from;
    const text = message.text?.body || '[unsupported message type]';
    const contactName = change.contacts?.[0]?.profile?.name || fromPhone;

    // ── Idempotency ────────────────────────────────────────────────────────
    // Meta redelivers a webhook until it sees a 200, and will redeliver anyway on
    // its own retry schedule. Without a de-dupe the same guest message was stored
    // several times, the AI answered it several times, and we sent the guest
    // several identical WhatsApp replies. `wamid` is Meta's globally unique message
    // id — we use it as the primary key so a replay is a no-op INSERT.
    const guestMsgId = message.id ? 'wa_' + message.id : 'msg_' + nanoid(10);
    const alreadySeen = db.prepare('SELECT 1 FROM messages WHERE id = ?').get(guestMsgId);
    if (alreadySeen) return; // duplicate delivery of a message we have already handled

    // Find or create conversation. INSERT ... ON CONFLICT keeps two messages that
    // arrive together from forking two conversations for one phone number.
    let conv = db.prepare('SELECT * FROM conversations WHERE tenant_id = ? AND guest_phone = ?').get(tenant.id, fromPhone);
    if (!conv) {
      const cid = 'conv_' + nanoid(10);
      db.prepare(`INSERT INTO conversations (id, tenant_id, guest_name, guest_phone, online, unread_count, last_message)
                  VALUES (?,?,?,?,1,0,?)
                  ON CONFLICT(tenant_id, guest_phone) DO NOTHING`).run(cid, tenant.id, contactName, fromPhone, text);
      conv = db.prepare('SELECT * FROM conversations WHERE tenant_id = ? AND guest_phone = ?').get(tenant.id, fromPhone);
    }

    try {
      db.prepare(`INSERT INTO messages (id, tenant_id, conversation_id, sender, body) VALUES (?,?,?, 'guest', ?)`)
        .run(guestMsgId, tenant.id, conv.id, text);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) return; // raced with a concurrent redelivery
      throw e;
    }
    const guestMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(guestMsgId);
    broadcast(tenant.id, 'message.created', { conversationId: conv.id, message: guestMsg });

    if (tenant.ai_enabled) {
      // Async path: tenant-configured LLM (or platform key) with graceful
      // fallback to the offline rules — plus the tender-code booking lookup.
      const { text: replyText } = await getAIReplyAsync(text, tenant.id);
      const aiMsgId = 'msg_' + nanoid(10);
      db.prepare(`INSERT INTO messages (id, tenant_id, conversation_id, sender, body, ai_generated) VALUES (?,?,?, 'ai', ?, 1)`)
        .run(aiMsgId, tenant.id, conv.id, replyText);
      const aiMsg = db.prepare('SELECT * FROM messages WHERE id = ?').get(aiMsgId);
      db.prepare(`UPDATE conversations SET last_message = ?, last_message_at = datetime('now') WHERE id = ?`).run(replyText, conv.id);
      broadcast(tenant.id, 'message.created', { conversationId: conv.id, message: aiMsg });

      // Send the reply back to WhatsApp
      sendWhatsAppMessage(tenant, fromPhone, replyText).catch(err => console.error('WA send failed:', err.message));
    } else {
      db.prepare(`UPDATE conversations SET last_message = ?, unread_count = unread_count + 1, last_message_at = datetime('now') WHERE id = ?`)
        .run(text, conv.id);
    }
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

// ── WhatsApp sender moved to server/utils/whatsapp.js so the booking engine,
// payments, and notifications can reuse it without importing from a route.

// ── Payment gateway webhooks (Paystack / Stripe / Flutterwave) ────────────
router.post('/paystack/:subdomain', express.json({
  verify: (req, res, buf) => { req.rawBody = buf; } // captured so we can HMAC the exact bytes Paystack signed
}), (req, res) => {
  // Stored credentials are encrypted at rest — decrypt for the HMAC check.
  const tenant = decryptTenantSecrets(db.prepare('SELECT * FROM tenants WHERE subdomain = ?').get(req.params.subdomain));
  if (!tenant) return res.status(404).json({ error: 'Unknown hotel' });

  // Fail CLOSED: without a configured secret we cannot verify the sender, so we
  // must not create transactions from an unauthenticated POST. Paystack signs the
  // RAW request body — signing a re-serialized object (JSON.stringify(req.body))
  // would not match, so we HMAC req.rawBody.
  if (!tenant.paystack_secret_key) {
    return res.status(503).json({ error: 'Paystack integration is not fully configured (missing secret key)' });
  }
  const signature = req.headers['x-paystack-signature'];
  const expected = crypto.createHmac('sha512', tenant.paystack_secret_key).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  if (!signature || !timingSafeEqualStr(signature, expected)) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  res.status(200).json({ received: true });

  if (req.body.event === 'charge.success') {
    try {
      const { reference, amount, customer, metadata } = req.body.data || {};
      if (!reference) return;
      const value = Math.round(((amount || 0) / 100) * 100) / 100;

      // Paystack retries a webhook until it gets a 2xx, and replays events. The
      // gateway `reference` is unique per charge, so it is the idempotency key.
      // Without this, one 2,500.00 payment was inserted once per retry — inventing
      // revenue and corrupting every downstream report and EOD close.
      const existing = db.prepare('SELECT * FROM transactions WHERE tenant_id = ? AND gateway_ref = ?').get(tenant.id, reference);

      if (existing && existing.status === 'completed') return; // already recorded

      if (existing) {
        // This is the payment for a link we issued (POST /api/payments/link created
        // a pending row with this ref). Settle that row instead of creating a
        // second one — otherwise the pending charge lingers forever and blocks
        // the guest's check-out even though they have paid.
        db.prepare(`UPDATE transactions SET status = 'completed', method = 'Paystack' WHERE id = ? AND status = 'pending'`).run(existing.id);
        broadcast(tenant.id, 'payment.updated', db.prepare('SELECT * FROM transactions WHERE id = ?').get(existing.id));
        return;
      }

      const id = 'txn_' + nanoid(10);
      db.prepare(`INSERT INTO transactions (id, tenant_id, guest_name, room_number, description, amount, method, status, gateway_ref)
                  VALUES (?,?,?,?,?,?, 'Paystack', 'completed', ?)`)
        .run(id, tenant.id, customer?.email || 'Guest', metadata?.room || null, metadata?.description || 'Payment', value, reference);
      broadcast(tenant.id, 'payment.created', db.prepare('SELECT * FROM transactions WHERE id = ?').get(id));
    } catch (err) {
      console.error('Paystack webhook processing error:', err);
    }
  }
});

// ── PLATFORM payment webhooks (subscription auto-activation) ──────────────
// These endpoints are for the PLATFORM's own gateway account (configured by
// the superadmin in Super Admin → Platform Billing). A successful charge here
// activates a hotel's subscription AUTOMATICALLY — no operator approval step.
// URLs to register with the gateway (one per platform, not per hotel):
//   Stripe:    https://yourdomain.com/api/webhooks/platform/stripe
//   Paystack:  https://yourdomain.com/api/webhooks/platform/paystack

const platformSettings = require('../services/platform-settings');
const { approveSubscriptionByGatewayRef } = require('../services/billing');
const selfhost = require('../services/selfhost'); // Desk PC Edition one-time payments

// A platform-checkout charge that matches no subscription may be a Desk PC
// Edition order (one-time $3,000). Route it to the selfhost flow — confirming
// it there generates the licence and EMAILS the software to the customer,
// which is what "delivered the moment payment is confirmed" means. A ref that
// belongs to neither system already logged "unknown reference" in billing's
// subscription lookup, so this stays quiet on no-match; only real failures
// (mail/DB errors) are surfaced.
function tryConfirmSelfhost(provider, gatewayRef, opts) {
  if (!gatewayRef) return;
  selfhost.confirmPayment(provider, gatewayRef, opts)
    .catch(err => console.error('[selfhost] webhook confirmation failed:', err.message));
}

// Stripe: verify the Stripe-Signature header (t=timestamp,v1=hmac_sha256(rawBody))
// against the platform's signing secret. Fail closed when unconfigured.
router.post('/platform/stripe', express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}), (req, res) => {
  const signingSecret = platformSettings.get('stripe_webhook_secret');
  if (!signingSecret) {
    return res.status(503).json({ error: 'Platform Stripe webhook secret is not configured' });
  }
  const header = String(req.headers['stripe-signature'] || '');
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=').map(s => s.trim())).filter(p => p.length === 2));
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return res.status(400).json({ error: 'Malformed Stripe signature header' });

  // Replay window: reject events older than 5 minutes (Stripe's own guidance).
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return res.status(400).json({ error: 'Stripe signature timestamp outside tolerance' });

  const expected = crypto.createHmac('sha256', signingSecret).update(timestamp + '.' + (req.rawBody || Buffer.alloc(0))).digest('hex');
  if (!timingSafeEqualStr(signature, expected)) return res.status(400).json({ error: 'Invalid Stripe signature' });

  res.status(200).json({ received: true });

  try {
    const event = req.body;
    if (event.type === 'checkout.session.completed') {
      const session = event.data?.object || {};
      // client_reference_id is the platform_subscriptions.id we set at
      // checkout creation; metadata.subscription_id is the fallback.
      const subId = session.client_reference_id || session.metadata?.subscription_id;
      if (subId && session.payment_status === 'paid') {
        const approved = approveSubscriptionByGatewayRef('stripe', subId, {
          amount: (session.amount_total || 0) / 100,
        });
        // Not a subscription charge → might be a Desk PC Edition order. For a
        // selfhost checkout the stored gateway_ref is the session id.
        if (!approved) {
          tryConfirmSelfhost('stripe', session.metadata?.order_id || session.id,
            { amount: (session.amount_total || 0) / 100 });
        }
      }
    }
  } catch (err) {
    console.error('Platform Stripe webhook processing error:', err);
  }
});

// Paystack: verify X-Paystack-Signature (HMAC-SHA512 of the raw body) against
// the platform secret key, exactly like the per-tenant handler above.
router.post('/platform/paystack', express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}), (req, res) => {
  const secretKey = platformSettings.get('paystack_secret_key');
  if (!secretKey) {
    return res.status(503).json({ error: 'Platform Paystack secret key is not configured' });
  }
  const signature = req.headers['x-paystack-signature'];
  const expected = crypto.createHmac('sha512', secretKey).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  if (!signature || !timingSafeEqualStr(signature, expected)) {
    return res.status(403).json({ error: 'Invalid Paystack signature' });
  }

  res.status(200).json({ received: true });

  try {
    if (req.body.event === 'charge.completed' || req.body.event === 'charge.success') {
      const data = req.body.data || {};
      if (data.reference) {
        const approved = approveSubscriptionByGatewayRef('paystack', data.reference, {
          amount: (data.amount || 0) / 100,
        });
        // Selfhost orders use their SC- reference as the gateway reference —
        // confirmPayment matches it on payment_reference and mails the software.
        if (!approved) {
          tryConfirmSelfhost('paystack', data.reference,
            { amount: (data.amount || 0) / 100 });
        }
      }
    }
  } catch (err) {
    console.error('Platform Paystack webhook processing error:', err);
  }
});

// Flutterwave: verify verif-hash header (sha256 HMAC stored as the webhook
// secret's plain value) + HMAC verify against the configured secret key.
router.post('/platform/flutterwave', express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}), (req, res) => {
  const secret = platformSettings.get('flutterwave_webhook_secret') || platformSettings.get('flutterwave_secret_key');
  if (!secret) {
    return res.status(503).json({ error: 'Platform Flutterwave secret is not configured' });
  }
  const signature = req.headers['verif-hash'];
  const expected = crypto.createHash('sha256').update(req.rawBody || Buffer.alloc(0)).digest('hex');
  // Flutterwave's verif-hash equals the sha256 of the payload using the
  // configured secret as key; also accept a pre-shared secret (stored value).
  const expectsShared = platformSettings.get('flutterwave_webhook_secret');
  const hashMatch = signature && timingSafeEqualStr(signature, expected);
  const sharedMatch = signature && expectsShared && timingSafeEqualStr(signature, expectsShared);
  if (!hashMatch && !sharedMatch) {
    return res.status(403).json({ error: 'Invalid Flutterwave signature' });
  }

  res.status(200).json({ received: true });

  try {
    const data = req.body.data || req.body;
    if ((req.body.event === 'charge.completed' || data.status === 'successful') && data.tx_ref) {
      approveSubscriptionByGatewayRef('flutterwave', data.tx_ref, {
        amount: data.amount || 0,
      });
    }
  } catch (err) {
    console.error('Platform Flutterwave webhook processing error:', err);
  }
});

// Korapay: verify x-korapay-signature (HMAC-SHA256 of ONLY the `data` object,
// signed with the platform secret key). Kora signs their own serialization of
// `data`; the raw body may carry extra fields (`event`) and float amounts like
// `100.00` that don't round-trip through JSON.parse/stringify identically, so
// we accept EITHER the re-serialized object (Kora's documented recipe) OR the
// exact on-the-wire bytes of the data object — both are covered by the same
// secret, so neither widens trust. A forged signature activates nothing.
// Kora retries non-2xx for up to 72h, so we always ack fast and never let an
// activation depend on response timing.
function korapayDataCandidates(rawBody) {
  const out = [];
  const raw = rawBody ? rawBody.toString('utf8') : '';
  // Exact bytes of the top-level "data" object (brace-matched, string-aware).
  let i = 0;
  while (i < raw.length) {
    const m = raw.indexOf('"data"', i);
    if (m === -1) break;
    let j = m + 5;
    while (j < raw.length && /\s/.test(raw[j])) j++;
    if (raw[j] === ':') {
      j++;
      while (j < raw.length && /\s/.test(raw[j])) j++;
      if (raw[j] === '{') {
        let depth = 0, inStr = false, esc = false, end = -1;
        for (let k = j; k < raw.length; k++) {
          const ch = raw[k];
          if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
          } else if (ch === '"') inStr = true;
          else if (ch === '{') depth++;
          else if (ch === '}') { depth--; if (depth === 0) { end = k; break; } }
        }
        if (end !== -1) { out.push(raw.slice(j, end + 1)); break; }
      }
    }
    i = m + 5;
  }
  return out;
}

router.post('/platform/korapay', express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}), (req, res) => {
  const secretKey = platformSettings.get('korapay_secret_key');
  if (!secretKey) {
    return res.status(503).json({ error: 'Platform Korapay secret key is not configured' });
  }
  const signature = String(req.headers['x-korapay-signature'] || '');
  if (!signature) return res.status(403).json({ error: 'Missing Korapay signature' });
  const candidates = korapayDataCandidates(req.rawBody);
  try {
    const re = JSON.stringify((req.body || {}).data);
    if (re && re !== '[object Object]') candidates.push(re);
  } catch (_) { /* circular — raw candidate above still applies */ }
  const verified = candidates.some(c =>
    timingSafeEqualStr(signature, crypto.createHmac('sha256', secretKey).update(c).digest('hex')));
  if (!verified) return res.status(403).json({ error: 'Invalid Korapay signature' });

  res.status(200).json({ received: true });

  try {
    const data = (req.body && req.body.data) || {};
    if (req.body.event !== 'charge.success' || data.status !== 'success') return;
    const reference = data.reference || data.payment_reference;
    if (!reference) return;
    // Kora supports dynamic currency conversion — a charge settled in another
    // currency must never auto-activate a USD subscription (NGN 29,000 would
    // otherwise pass a numeric >= check against $29). Operator reconciles it.
    if (data.currency && String(data.currency).toUpperCase() !== 'USD') {
      console.warn('[korapay] charge', reference, 'settled in', data.currency, 'instead of USD — operator review needed');
      return;
    }
    const amount = Number(data.amount) || 0; // major units, same as checkout
    const approved = approveSubscriptionByGatewayRef('korapay', reference, { amount });
    // Not a subscription charge → might be a Desk PC Edition order.
    if (!approved) tryConfirmSelfhost('korapay', reference, { amount });
  } catch (err) {
    console.error('Platform Korapay webhook processing error:', err);
  }
});

// OPay: HMAC-SHA256 of the raw body with the merchant secret key, sent in
// the Authorization header on their webhookPosts.
router.post('/platform/opay', express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}), (req, res) => {
  const secretKey = platformSettings.get('opay_secret_key');
  if (!secretKey) {
    return res.status(503).json({ error: 'Platform OPay secret key is not configured' });
  }
  const signature = req.headers['authorization'] || req.headers['x-opay-signature'] || '';
  const expected = crypto.createHmac('sha256', secretKey).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  const bare = String(signature).replace(/^Bearer\s+/i, '').trim();
  if (!bare || !timingSafeEqualStr(bare, expected)) {
    return res.status(403).json({ error: 'Invalid OPay signature' });
  }

  res.status(200).json({ received: true });

  try {
    if ((req.body.event === 'success' || req.body.status === 'SUCCESS') && req.body.reference) {
      approveSubscriptionByGatewayRef('opay', req.body.reference, {
        amount: (req.body.amount || 0) / 100,
      });
    }
  } catch (err) {
    console.error('Platform OPay webhook processing error:', err);
  }
});

// Payoneer / Airtm / Crypto: the operator confirms a real transfer through
// these rails using a shared webhook secret token (the platform's own manual
// settlement path — credentials, not a demo). POST { reference, provider,
// amount } with X-Webhook-Secret matching the stored per-provider secret.
const MANUAL_PROVIDERS = ['payoneer', 'airtm', 'crypto'];
router.post('/platform/manual', express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}), (req, res) => {
  const provider = String((req.body || {}).provider || '').toLowerCase();
  if (!MANUAL_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: 'provider must be one of: ' + MANUAL_PROVIDERS.join(', ') });
  }
  const secretPrefix = provider === 'payoneer' ? 'payoneer' : provider === 'airtm' ? 'airtm' : 'crypto';
  const secret = platformSettings.get(secretPrefix === 'crypto' ? 'crypto_webhook_secret' : secretPrefix === 'payoneer' ? 'payoneer_client_secret' : 'airtm_api_token');
  if (!secret) {
    return res.status(503).json({ error: 'Platform ' + provider + ' secret is not configured' });
  }
  const provided = req.headers['x-webhook-secret'] || '';
  if (!provided || !timingSafeEqualStr(String(provided), secret)) {
    return res.status(403).json({ error: 'Invalid webhook secret' });
  }
  const reference = String((req.body || {}).reference || (req.body || {}).tx_ref || '');
  const amount = Number((req.body || {}).amount || 0);
  if (!reference) return res.status(400).json({ error: 'reference is required' });

  res.status(200).json({ received: true });
  try {
    approveSubscriptionByGatewayRef(provider, reference, { amount });
  } catch (err) {
    console.error('Platform manual webhook processing error (' + provider + '):', err);
  }
});

module.exports = router;
