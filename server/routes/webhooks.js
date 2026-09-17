// server/routes/webhooks.js
// Real WhatsApp Business Cloud API webhook integration point.
// Meta sends verification (GET) and message events (POST) to this endpoint.
// Configure in Meta Developer Console: https://yourdomain.com/api/webhooks/whatsapp/:tenantSubdomain

const express = require('express');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { getAIReply } = require('../ai/receptionist');
const { broadcast } = require('../ws');
const { sendWhatsAppMessage } = require('../utils/whatsapp');

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
  const tenant = db.prepare('SELECT * FROM tenants WHERE subdomain = ?').get(req.params.subdomain);
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
}), (req, res) => {
  const tenant = db.prepare('SELECT * FROM tenants WHERE subdomain = ?').get(req.params.subdomain);
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
      const replyText = getAIReply(text, tenant.id); // tenantId enables tender-code booking lookup
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
  const tenant = db.prepare('SELECT * FROM tenants WHERE subdomain = ?').get(req.params.subdomain);
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

module.exports = router;
