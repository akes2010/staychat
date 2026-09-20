// server/routes/settings.js
const express = require('express');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, requireRole, audit } = require('../middleware/auth');
const { fetchLiveRates, symbolToCode } = require('../utils/exchange-rates');

const router = express.Router();
router.use(requireAuth, resolveTenant, requireTenant);

function publicTenant(t) {
  const engineCfg = db.prepare('SELECT * FROM booking_engine_config WHERE tenant_id = ?').get(t.id);
  return {
    id: t.id, name: t.name, subdomain: t.subdomain, plan: t.plan, status: t.status,
    country: t.country, email: t.email, phone: t.phone, currency: t.currency, timezone: t.timezone,
    checkInTime: t.check_in_time, checkOutTime: t.check_out_time,
    aiEnabled: !!t.ai_enabled, aiTone: t.ai_tone, autoBooking: !!t.auto_booking,
    autoAssignHk: !!t.auto_assign_hk, autoAssignMaint: !!t.auto_assign_maint,
    housekeepingSla: t.housekeeping_sla, maintenanceSla: t.maintenance_sla,
    posTaxPct: t.pos_tax_pct, posServicePct: t.pos_service_pct, poolCapacity: t.pool_capacity,
    paymentMethods: JSON.parse(t.payment_methods || '["cash","card"]'),
    paymentMethodConfigs: JSON.parse(t.payment_method_configs || '{}'),
    subscription: { planId: t.plan_id, billingCycle: t.billing_cycle, status: t.subscription_status, nextBillingDate: t.next_billing_date },
    waPhone: t.wa_phone, waConnected: !!t.wa_connected,
    // Presence flags only — never the secret values. Lets the UI show which
    // WhatsApp credentials are already saved and drive the setup tracker.
    waSetup: {
      phoneNumberId: !!t.wa_phone_id,
      accessToken: !!t.wa_token,
      verifyToken: !!t.wa_verify_token,
      appSecret: !!t.wa_app_secret,
      phone: !!t.wa_phone,
    },
    // Secrets are masked — never sent in full to the client.
    paystackPublicKey: t.paystack_public_key,
    paystackSecretSet: !!t.paystack_secret_key,
    stripePublicKey: t.stripe_public_key,
    stripeSecretSet: !!t.stripe_secret_key,
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
  if (b.paymentMethods !== undefined) updates.payment_methods = JSON.stringify(b.paymentMethods);
  if (b.paymentMethodConfigs !== undefined) updates.payment_method_configs = JSON.stringify(b.paymentMethodConfigs);
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  // If WhatsApp credentials are being set (phone ID + token present, either now or already saved),
  // mark the integration as connected so the UI badge reflects reality.
  const willHavePhoneId = updates.wa_phone_id || req.tenant.wa_phone_id;
  const willHaveToken = updates.wa_token || req.tenant.wa_token;
  if (willHavePhoneId && willHaveToken) updates.wa_connected = 1;

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
// POST /api/settings/whatsapp/test — live probe of the Meta Graph API using
// the SAVED credentials. Confirms the token is valid and actually owns the
// configured Phone Number ID (a real token for a different WhatsApp app would
// still 401 here). Safe to re-run any time; never stores anything.
router.post('/whatsapp/test', requireRole('hotel_admin', 'superadmin'), async (req, res) => {
  const t = req.tenant;
  if (!t.wa_phone_id || !t.wa_token) {
    return res.status(400).json({ error: 'Save your Phone Number ID and Access Token first (Settings → WhatsApp)' });
  }
  try {
    const resp = await fetch('https://graph.facebook.com/v19.0/' + t.wa_phone_id + '?fields=id,display_phone_number,verified_name,quality_rating', {
      headers: { Authorization: 'Bearer ' + t.wa_token },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      // Meta signals an expired/invalid token with code 190 in the error body.
      const code = data && data.error && data.error.code;
      const hint = code === 190
        ? 'Token rejected (code 190) — API Setup tokens expire in 24 hours; create a permanent System User token'
        : ((data && data.error && data.error.message) || ('Meta API returned ' + resp.status));
      return res.status(400).json({ ok: false, error: hint });
    }
    audit(req, 'settings.whatsapp_test', 'tenant', req.tenantId, { phoneNumberId: t.wa_phone_id });
    res.json({ ok: true, displayPhoneNumber: data.display_phone_number, verifiedName: data.verified_name, qualityRating: data.quality_rating });
  } catch (err) {
    res.status(502).json({ ok: false, error: 'Could not reach Meta: ' + err.message });
  }
});

router.post('/factory-reset', requireRole('hotel_admin', 'superadmin'), (req, res) => {
  const tid = req.tenantId;
  const tables = ['rooms','guests','bookings','orders','menu_items','staff','maintenance_requests','conversations','messages','transactions','pos_tickets','pool_bookings','hall_bookings','halls','floors','room_categories','holidays','shifts','attendance','pools','misc_services','misc_service_orders','printers','ai_configs','vouchers','journal_lines','journal_entries','accounts','eod_closings'];
  const txn = db.transaction(() => {
    tables.forEach(t => db.prepare(`DELETE FROM ${t} WHERE tenant_id = ?`).run(tid));
  });
  txn();
  audit(req, 'settings.factory_reset', 'tenant', tid);
  res.json({ ok: true, message: 'All operational data has been cleared. Hotel profile and login remain intact.' });
});

module.exports = router;
