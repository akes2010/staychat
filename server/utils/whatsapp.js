// server/utils/whatsapp.js
// Shared WhatsApp Business Cloud API sender. Extracted from webhooks.js so any
// feature (booking engine, payments, notifications) can send a message without
// importing from a route file — the project convention is that routes consume
// services/utils, not other routes.
//
// No caching of tenant credentials on purpose: sends are rare (one per booking
// lifecycle event) and a cached row would keep sending with a revoked token
// after an admin rotates credentials.
'use strict';

const db = require('../db/connection');

/**
 * Send a WhatsApp text message.
 * @param {object|string} tenantOrId  tenant row, or a tenantId (looked up fresh)
 * @param {string} toPhone            E.164 phone number
 * @param {string} text               message body
 * @returns {Promise<object|undefined>} Meta API response, or {skipped:true} if
 *   the hotel has no WhatsApp credentials configured (callers decide if that
 *   matters — notification paths treat it as normal).
 */
async function sendWhatsAppMessage(tenantOrId, toPhone, text) {
  const tenant = typeof tenantOrId === 'string'
    ? db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantOrId)
    : tenantOrId;
  if (!tenant) throw new Error('Tenant not found for WhatsApp send');
  if (!tenant.wa_phone_id || !tenant.wa_token) {
    console.warn(`[WA] Tenant ${tenant.id} has no WhatsApp credentials configured — skipping send.`);
    return { skipped: true };
  }

  const resp = await fetch(`https://graph.facebook.com/v19.0/${tenant.wa_phone_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.wa_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: toPhone, type: 'text', text: { body: text } }),
  });
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`WhatsApp API error ${resp.status}: ${errBody}`);
  }
  return resp.json();
}

module.exports = { sendWhatsAppMessage };
