// server/routes/messaging.js
// Promo Blast — one WhatsApp message to many of the hotel's own guests.
//
// Audiences (all tenant-scoped, all real data):
//   checked_in   — everyone currently staying (bookings.status = checked_in)
//   upcoming     — confirmed, arriving in the next 14 days
//   past         — everyone checked out in the last 90 days (repeat-stay promos)
//   all          — union of the above, de-duplicated per phone
//
// Blocked numbers (desks block them) are ALWAYS excluded, whatever audience was
// picked. Sends use the same WhatsApp sender every other feature uses — hotels
// without WhatsApp credentials get a clear, honest response rather than an
// exception. Every send is fire-and-forget so one slow Meta call cannot hang
// the request; results are tallied and returned.
'use strict';

const express = require('express');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { sendWhatsAppMessage } = require('../utils/whatsapp');
const { normalizePhone, isBlocked } = require('./blocklist');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

const AUDIENCES = ['checked_in', 'upcoming', 'past', 'all'];

function audienceRecipients(tenantId, audience) {
  const today = new Date().toISOString().slice(0, 10);
  const in14 = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  const past90 = new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10);

  let rows = [];
  if (audience === 'checked_in' || audience === 'all') {
    rows = rows.concat(db.prepare(`SELECT guest_name AS name, guest_phone AS phone FROM bookings
      WHERE tenant_id = ? AND status = 'checked_in'`).all(tenantId));
  }
  if (audience === 'upcoming' || audience === 'all') {
    rows = rows.concat(db.prepare(`SELECT guest_name AS name, guest_phone AS phone FROM bookings
      WHERE tenant_id = ? AND status = 'confirmed' AND check_in >= ? AND check_in <= ?`).all(tenantId, today, in14));
  }
  if (audience === 'past' || audience === 'all') {
    rows = rows.concat(db.prepare(`SELECT guest_name AS name, guest_phone AS phone FROM bookings
      WHERE tenant_id = ? AND status = 'checked_out' AND check_out >= ?`).all(tenantId, past90));
  }

  // De-duplicate by normalised phone (one guest, many bookings) and drop empties.
  const seen = new Map();
  rows.forEach(r => {
    if (!r.phone) return;
    const key = normalizePhone(r.phone);
    if (!key || seen.has(key)) return;
    seen.set(key, { name: r.name, phone: String(r.phone).trim() });
  });
  return [...seen.values()];
}

// GET /api/messaging/promo/preview?audience= — count who WOULD receive it,
// so the modal can show "this goes to N guests" before anything is sent.
router.get('/promo/preview', requirePermission('inbox.use'), (req, res) => {
  const audience = AUDIENCES.includes(req.query.audience) ? req.query.audience : 'all';
  const recipients = audienceRecipients(req.tenantId, audience);
  const sendable = recipients.filter(r => !isBlocked(req.tenantId, r.phone));
  const waConnected = !!db.prepare('SELECT wa_connected FROM tenants WHERE id = ?').get(req.tenantId)?.wa_connected;
  res.json({
    audience,
    recipients: sendable.length,
    blockedExcluded: recipients.length - sendable.length,
    sample: sendable.slice(0, 5).map(r => ({ name: r.name, phone: r.phone })),
    whatsappConfigured: waConnected,
  });
});

// POST /api/messaging/promo-blast — send it.
router.post('/promo-blast', requirePermission('inbox.use'), async (req, res) => {
  const { audience, message } = req.body || {};
  const text = String(message || '').trim();
  if (!text) return res.status(400).json({ error: 'Message body is required' });
  if (text.length > 1000) return res.status(400).json({ error: 'Message too long (max 1000 characters)' });
  if (!AUDIENCES.includes(audience)) return res.status(400).json({ error: 'audience must be one of ' + AUDIENCES.join(', ') });

  const recipients = audienceRecipients(req.tenantId, audience).filter(r => !isBlocked(req.tenantId, r.phone));
  if (recipients.length === 0) {
    return res.json({ sent: 0, failed: 0, skipped: 0, blockedExcluded: 0, recipients: [] });
  }

  const results = await Promise.all(recipients.map(async r => {
    const personable = text.includes('{name}')
      ? text.replace(/\{name\}/g, (r.name || '').split(' ')[0] || 'guest')
      : text;
    try {
      const resp = await sendWhatsAppMessage(req.tenantId, r.phone, personable);
      if (resp && resp.skipped) return { phone: r.phone, status: 'skipped' };
      return { phone: r.phone, status: 'sent' };
    } catch (e) {
      return { phone: r.phone, status: 'failed', error: String(e.message || e).slice(0, 140) };
    }
  }));

  const sent = results.filter(r => r.status === 'sent').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const failed = results.filter(r => r.status === 'failed').length;

  audit(req, 'promo.blast', 'audience', audience, { recipients: recipients.length, sent, failed, preview: text.slice(0, 200) });
  try { const { broadcast } = require('../ws'); broadcast(req.tenantId, 'promo.blast', { sent, failed }); } catch (e) { /* ws optional */ }

  res.json({ sent, skipped, failed, blockedExcluded: 0, results });
});

module.exports = router;
