// server/routes/settings.js
const express = require('express');
const crypto = require('crypto');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, requireRole, audit } = require('../middleware/auth');
const { fetchLiveRates, symbolToCode } = require('../utils/exchange-rates');
const { encryptTenantSecrets, decryptTenantSecrets } = require('../utils/tenant-secrets');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

function publicTenant(t) {
  const engineCfg = db.prepare('SELECT * FROM booking_engine_config WHERE tenant_id = ?').get(t.id);
  // Credentials are encrypted at rest — decrypt so the presence flags
  // (waSetup / paystackSecretSet / stripeSecretSet) reflect the REAL state.
  const d = decryptTenantSecrets(t);
  return {
    id: d.id, name: d.name, subdomain: d.subdomain, plan: d.plan, status: d.status,
    country: d.country, email: d.email, phone: d.phone, address: d.address || null, logo: d.logo || null,
    currency: d.currency, timezone: d.timezone,
    checkInTime: d.check_in_time, checkOutTime: d.check_out_time,
    aiEnabled: !!d.ai_enabled, aiTone: d.ai_tone, autoBooking: !!d.auto_booking,
    autoAssignHk: !!d.auto_assign_hk, autoAssignMaint: !!d.auto_assign_maint,
    housekeepingSla: d.housekeeping_sla, maintenanceSla: d.maintenance_sla,
    posTaxPct: d.pos_tax_pct, posServicePct: d.pos_service_pct, poolCapacity: d.pool_capacity,
    paymentMethods: JSON.parse(d.payment_methods || '["cash","card"]'),
    paymentMethodConfigs: JSON.parse(d.payment_method_configs || '{}'),
    subscription: { planId: d.plan_id, billingCycle: d.billing_cycle, status: d.subscription_status, nextBillingDate: d.next_billing_date },
    waPhone: d.wa_phone, waConnected: !!d.wa_connected,
    // Presence flags only — never the secret values. Lets the UI show which
    // WhatsApp credentials are already saved and drive the setup tracker.
    waSetup: {
      phoneNumberId: !!d.wa_phone_id,
      accessToken: !!d.wa_token,
      verifyToken: !!d.wa_verify_token,
      appSecret: !!d.wa_app_secret,
      phone: !!d.wa_phone,
    },
    // Secrets are masked — never sent in full to the client.
    paystackPublicKey: d.paystack_public_key,
    paystackSecretSet: !!d.paystack_secret_key,
    stripePublicKey: d.stripe_public_key,
    stripeSecretSet: !!d.stripe_secret_key,
    // Booking engine (public widget) state for the settings card.
    engineEnabled: !!(engineCfg && engineCfg.enabled),
    engineNotice: engineCfg ? engineCfg.notice : null,
    engineMaxDaily: engineCfg ? engineCfg.max_daily : 50,
  };
}
router.get('/', (req, res) => {
  res.json(publicTenant(req.tenant));
});

router.patch('/', requireRole('hotel_admin', 'superadmin'), (req, res) => {
  const b = req.body;
  const colMap = {
    hotelName: 'name', currency: 'currency', timezone: 'timezone',
    phone: 'phone', address: 'address', logo: 'logo',
    checkInTime: 'check_in_time', checkOutTime: 'check_out_time',
    waPhone: 'wa_phone', waPhoneId: 'wa_phone_id', waToken: 'wa_token', waVerifyToken: 'wa_verify_token', waAppSecret: 'wa_app_secret',
    aiEnabled: 'ai_enabled', aiTone: 'ai_tone', autoBooking: 'auto_booking',
    autoAssignHk: 'auto_assign_hk', autoAssignMaint: 'auto_assign_maint',
    housekeepingSla: 'housekeeping_sla', maintenanceSla: 'maintenance_sla',
    posTaxPct: 'pos_tax_pct', posServicePct: 'pos_service_pct', poolCapacity: 'pool_capacity',
    paystackPublicKey: 'paystack_public_key', paystackSecretKey: 'paystack_secret_key',
    stripePublicKey: 'stripe_public_key', stripeSecretKey: 'stripe_secret_key',
  };
  const boolFields = new Set(['aiEnabled','autoBooking','autoAssignHk','autoAssignMaint']);
  // Numeric settings feed straight into money maths (POS tax/service are applied to
  // every bill) and into capacity checks. SQLite is dynamically typed and will
  // happily store the string "not-a-number" in a REAL column, after which every
  // POS total silently became NaN. Validate ranges here.
  const numericFields = {
    posTaxPct: [0, 100], posServicePct: [0, 100],
    poolCapacity: [0, 100000], housekeepingSla: [0, 10080], maintenanceSla: [0, 10080],
  };

  const updates = {};
  for (const [bodyKey, col] of Object.entries(colMap)) {
    if (b[bodyKey] === undefined) continue;
    if (boolFields.has(bodyKey)) { updates[col] = b[bodyKey] ? 1 : 0; continue; }
    if (numericFields[bodyKey]) {
      const [min, max] = numericFields[bodyKey];
      const n = Number(b[bodyKey]);
      if (!Number.isFinite(n) || n < min || n > max) {
        return res.status(400).json({ error: `${bodyKey} must be a number between ${min} and ${max}` });
      }
      updates[col] = n;
      continue;
    }
    updates[col] = b[bodyKey];
  }
  if (b.checkInTime !== undefined && !/^\d{2}:\d{2}$/.test(String(b.checkInTime))) {
    return res.status(400).json({ error: 'checkInTime must be in HH:MM format' });
  }
  if (b.checkOutTime !== undefined && !/^\d{2}:\d{2}$/.test(String(b.checkOutTime))) {
    return res.status(400).json({ error: 'checkOutTime must be in HH:MM format' });
  }
  // Tenant branding: the logo is a base64 image data URL chosen by the admin's
  // own file picker (client caps the file at 512KB) — accept only real image
  // data URLs of a sane size so the column can never hold arbitrary blobs.
  if (b.logo !== undefined) {
    const logo = String(b.logo);
    if (logo && !/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/.test(logo)) {
      return res.status(400).json({ error: 'logo must be a base64 image data URL' });
    }
    if (logo.length > 1500000) {
      return res.status(400).json({ error: 'logo image is too large — keep it under 1MB' });
    }
  }
  if (b.paymentMethods !== undefined) updates.payment_methods = JSON.stringify(b.paymentMethods);
  if (b.paymentMethodConfigs !== undefined) updates.payment_method_configs = JSON.stringify(b.paymentMethodConfigs);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  // If WhatsApp credentials are being set (phone ID + token present, either now or already saved),
  // mark the integration as connected so the UI badge reflects reality.
  // (decryptTenantSecrets: req.tenant's stored secret may be ENCRYPTED at rest —
  // an already-saved legacy-encrypted token must still count as "present".)
  const willHavePhoneId = updates.wa_phone_id || req.tenant.wa_phone_id;
  const willHaveToken = updates.wa_token || decryptTenantSecrets(req.tenant).wa_token;
  if (willHavePhoneId && willHaveToken) updates.wa_connected = 1;

  // Secrets are ENCRYPTED at rest (AES-256-GCM) before they ever touch the DB.
  Object.assign(updates, encryptTenantSecrets(updates));

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE tenants SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: req.tenantId });

  const updated = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.tenantId);
  audit(req, 'settings.update', 'tenant', req.tenantId, Object.keys(updates));
  res.json(publicTenant(updated));
});

// ── Exchange rates ──────────────────────────────────────────────────────────
// The tenants table already carried `exchange_rates` / `exchange_rates_updated_at`
// and utils/exchange-rates.js already knew how to fetch them, but nothing ever
// called it — the columns stayed empty forever and getRateForTenant() silently
// fell back to 1:1, quoting NGN prices at USD values. This is the missing endpoint.
router.get('/exchange-rates', (req, res) => {
  const t = req.tenant;
  res.json({
    base: 'USD',
    displayCurrency: symbolToCode(t.currency),
    rates: JSON.parse(t.exchange_rates || '{}'),
    updatedAt: t.exchange_rates_updated_at || null,
  });
});

router.post('/exchange-rates/refresh', requireRole('hotel_admin', 'superadmin'), async (req, res) => {
  try {
    const rates = await fetchLiveRates();
    db.prepare(`UPDATE tenants SET exchange_rates = ?, exchange_rates_updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(rates), req.tenantId);
    audit(req, 'settings.exchange_rates_refresh', 'tenant', req.tenantId, { currencies: Object.keys(rates).length });
    const t = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.tenantId);
    res.json({ base: 'USD', displayCurrency: symbolToCode(t.currency), rates, updatedAt: t.exchange_rates_updated_at });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── WhatsApp connection test ────────────────────────────────────────────────
// POST /api/settings/whatsapp/test — verifies BOTH halves of the integration:
//
// INBOUND (webhook): self-checks THIS server's webhook endpoint — the GET
// handshake with the saved verify token (what Meta's "Verify and save" will
// hit) and a signed empty delivery through the real signature gate (the
// payload carries no messages[], so the webhook acks and ignores it — no fake
// message is injected). Deterministic, no external network.
//
// OUTBOUND: live probe of the Meta Graph API with the saved token, confirming
// it actually owns the configured Phone Number ID (a real token for a
// different WhatsApp app would still 401 here). Safe to re-run any time;
// never stores anything. Webhook results are included even when the Graph
// probe fails, so an expired token doesn't hide inbound readiness.
router.post('/whatsapp/test', requireRole('hotel_admin', 'superadmin'), async (req, res) => {
  // Stored credentials are encrypted at rest — decrypt for the live probe.
  const t = decryptTenantSecrets(db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.tenantId));
  if (!t.wa_phone_id || !t.wa_token) {
    return res.status(400).json({ error: 'Save your Phone Number ID and Access Token first (Settings → WhatsApp)' });
  }

  // ── Inbound webhook self-check (local, always runs) ──
  const port = Number(process.env.PORT) || 3000;
  const selfBase = 'http://127.0.0.1:' + port;
  const webhookPath = '/api/webhooks/whatsapp/' + t.subdomain;
  const webhook = { handshakeOk: false, signatureOk: false };
  try {
    const challenge = 'staychat-selftest-' + Date.now();
    const echoed = await fetch(selfBase + webhookPath + '?hub.mode=subscribe&hub.verify_token=' + encodeURIComponent(t.wa_verify_token || '') + '&hub.challenge=' + challenge).then(r => r.text());
    webhook.handshakeOk = echoed === challenge;
    if (!webhook.handshakeOk) webhook.handshakeError = 'Meta\'s "Verify and save" would fail — check the Webhook Verify Token';
  } catch (e) { webhook.handshakeError = e.message; }
  try {
    if (!t.wa_app_secret) {
      webhook.signatureError = 'App Secret not saved — every inbound delivery is rejected until it is';
    } else {
      const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'SELFTEST', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp' } }] }] });
      const sig = 'sha256=' + crypto.createHmac('sha256', t.wa_app_secret).update(body).digest('hex');
      const pr = await fetch(selfBase + webhookPath, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body });
      webhook.signatureOk = pr.status === 200;
      if (!webhook.signatureOk) webhook.signatureError = 'Signed self-delivery returned ' + pr.status;
    }
  } catch (e) { webhook.signatureError = e.message; }

  // ── Outbound Graph probe (needs network + valid token) ──
  try {
    const resp = await fetch('https://graph.facebook.com/v19.0/' + t.wa_phone_id + '?fields=id,display_phone_number,verified_name,quality_rating', {
      headers: { Authorization: 'Bearer ' + t.wa_token },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const code = data && data.error && data.error.code;
      const hint = code === 190
        ? 'Token rejected (code 190) — API Setup tokens expire in 24 hours; create a permanent System User token'
        : ((data && data.error && data.error.message) || ('Meta API returned ' + resp.status));
      return res.status(400).json({ ok: false, error: hint, webhook });
    }
    audit(req, 'settings.whatsapp_test', 'tenant', req.tenantId, { phoneNumberId: t.wa_phone_id, webhookOk: webhook.handshakeOk && webhook.signatureOk });
    res.json({ ok: true, displayPhoneNumber: data.display_phone_number, verifiedName: data.verified_name, qualityRating: data.quality_rating, webhook });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'Could not reach Meta: ' + err.message, webhook });
  }
});

// ── Partial reset: erase the hotel's OPERATIONAL data, keep its SETTINGS ──
// Admin account only (hotel_admin / superadmin), armed by typing the hotel
// name — the client must round-trip /api/settings to pass. What is ERASED:
// transactions, every user except the acting admin, products & prices,
// room inventory, guests, bookings, till tickets, the ledger, closings,
// messages and the rest of the recorded business. What is KEPT: the tenants
// row (profile, currency, payment keys, branding), booking-engine config,
// printers, AI config, and every module DEFINITION — floors, room categories,
// holidays, shift rotation, halls, pools, gyms & membership plans, services,
// menu categories, POS tables, chart of accounts — plus the acting admin's
// own login (this very session must survive the reset).
router.post('/factory-reset', requireRole('hotel_admin', 'superadmin'), (req, res) => {
  const tid = req.tenantId;
  // Require the hotel's CURRENT NAME as a typed confirmation — the client must
  // echo exactly what is stored. This componentizes the human-in-the-loop so
  // an autopilot confirm-click (or a mistyped intent) can never wipe a hotel
  // on its own: a caller who hasn't round-tripped /api/settings can't pass.
  const typed = String((req.body || {}).confirmHotelName || '').trim().toLowerCase();
  const expected = String(req.tenant.name || '').trim().toLowerCase();
  if (!expected || typed !== expected) {
    return res.status(400).json({ error: 'Confirmation mismatch — type the hotel name exactly to reset' });
  }
  // Children before parents (safe whether or not the FK pragma is on).
  const DATA_TABLES = [
    'messages', 'conversations', 'idempotency_keys',
    'booking_rooms', 'bookings', 'pos_tickets', 'transactions',
    'journal_lines', 'journal_entries', 'vouchers', 'analytics_daily',
    'rooms', 'guests', 'menu_items', 'orders', 'misc_service_orders',
    'hall_bookings', 'pool_bookings', 'gym_bookings', 'memberships',
    'eod_closings', 'attendance', 'maintenance_requests', 'wifi_provisions',
  ];
  const counts = {};
  const txn = db.transaction(() => {
    DATA_TABLES.forEach(t => {
      counts[t] = db.prepare(`DELETE FROM ${t} WHERE tenant_id = ?`).run(tid).changes;
    });
    // Users: everybody but the acting admin. Their sessions and pending
    // password resets go with them (explicit, so it holds even if the FK
    // pragma is off — a deleted user must never be able to refresh back in).
    counts.refresh_tokens = db.prepare('DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ? AND id != ?)')
      .run(tid, req.user.id).changes;
    counts.password_resets = db.prepare('DELETE FROM password_resets WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ? AND id != ?)')
      .run(tid, req.user.id).changes;
    counts.users = db.prepare('DELETE FROM users WHERE tenant_id = ? AND id != ?').run(tid, req.user.id).changes;
    // Fresh audit trail: the reset itself is the first new entry.
    counts.audit_log = db.prepare('DELETE FROM audit_log WHERE tenant_id = ?').run(tid).changes;
  });
  txn();
  audit(req, 'settings.factory_reset', 'tenant', tid, { erased: counts });
  res.json({
    ok: true,
    erased: counts,
    message: 'Operational data cleared. Settings, module configuration and your admin login are intact.',
  });
});

// ── Partial database export (admin account) ──────────────────────────────
// Everything a hotel would need OUT of the system: users, transactions,
// bookings (dates), rooms, halls, pool, gym, the POS (bar & restaurant),
// services, operations and the ledger — as a JSON attachment. Settings and
// tenant configuration are NOT included (that side is the reset's keep-set),
// and credential material is stripped: password hashes and tokens never leave.
router.get('/data-export', requireRole('hotel_admin', 'superadmin'), (req, res) => {
  const tid = req.tenantId;
  const all = (sql) => db.prepare(sql).all(tid);
  const users = db.prepare('SELECT * FROM users WHERE tenant_id = ?').all(tid).map(u => {
    const safe = { ...u };
    delete safe.password_hash;
    return safe;
  });
  const payload = {
    meta: {
      kind: 'staychat-partial-export',
      exportedAt: new Date().toISOString(),
      tenantId: tid,
      hotel: req.tenant.name,
      subdomain: req.tenant.subdomain,
      note: 'Operational data only — settings and tenant configuration are intentionally excluded.',
    },
    users,
    transactions: all('SELECT * FROM transactions WHERE tenant_id = ?'),
    bookings: all('SELECT * FROM bookings WHERE tenant_id = ?'),
    booking_rooms: all('SELECT * FROM booking_rooms WHERE tenant_id = ?'),
    guests: all('SELECT * FROM guests WHERE tenant_id = ?'),
    rooms: all('SELECT * FROM rooms WHERE tenant_id = ?'),
    halls: all('SELECT * FROM halls WHERE tenant_id = ?'),
    hall_bookings: all('SELECT * FROM hall_bookings WHERE tenant_id = ?'),
    pools: all('SELECT * FROM pools WHERE tenant_id = ?'),
    pool_bookings: all('SELECT * FROM pool_bookings WHERE tenant_id = ?'),
    gyms: all('SELECT * FROM gyms WHERE tenant_id = ?'),
    gym_bookings: all('SELECT * FROM gym_bookings WHERE tenant_id = ?'),
    membership_plans: all('SELECT * FROM membership_plans WHERE tenant_id = ?'),
    memberships: all('SELECT * FROM memberships WHERE tenant_id = ?'),
    pos: {
      tickets: all('SELECT * FROM pos_tickets WHERE tenant_id = ?'),
      menuItems: all('SELECT * FROM menu_items WHERE tenant_id = ?'),
      menuCategories: all('SELECT * FROM menu_categories WHERE tenant_id = ?'),
      tables: all('SELECT * FROM pos_tables WHERE tenant_id = ?'),
    },
    services: {
      roomServiceOrders: all('SELECT * FROM orders WHERE tenant_id = ?'),
      miscServices: all('SELECT * FROM misc_services WHERE tenant_id = ?'),
      miscOrders: all('SELECT * FROM misc_service_orders WHERE tenant_id = ?'),
    },
    operations: {
      eodClosings: all('SELECT * FROM eod_closings WHERE tenant_id = ?'),
      attendance: all('SELECT * FROM attendance WHERE tenant_id = ?'),
      maintenance: all('SELECT * FROM maintenance_requests WHERE tenant_id = ?'),
      wifiProvisions: all('SELECT * FROM wifi_provisions WHERE tenant_id = ?'),
      staff: all('SELECT * FROM staff WHERE tenant_id = ?'),
    },
    accounting: {
      accounts: all('SELECT * FROM accounts WHERE tenant_id = ?'),
      journalEntries: all('SELECT * FROM journal_entries WHERE tenant_id = ?'),
      journalLines: all('SELECT * FROM journal_lines WHERE tenant_id = ?'),
      vouchers: all('SELECT * FROM vouchers WHERE tenant_id = ?'),
    },
  };
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="staychat-${req.tenant.subdomain || 'hotel'}-export-${stamp}.json"`);
  audit(req, 'settings.data_export', 'tenant', tid, { datasets: Object.keys(payload).length });
  res.json(payload);
});

module.exports = router;
