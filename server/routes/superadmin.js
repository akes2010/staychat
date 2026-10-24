// server/routes/superadmin.js
const express = require('express');
const { hashPassword } = require('../utils/password-pool'); // bcrypt runs OFF the request thread
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { requireAuth, requirePlatformOperator, audit } = require('../middleware/auth');
const { PLAN_CATALOG, sweepExpiredTrials } = require('../services/entitlements');
const billing = require('../services/billing');
const { sanitizeTenant } = require('../utils/tenant-secrets');

const router = express.Router();
router.use(requireAuth, requirePlatformOperator);

// ── Edition scoping ────────────────────────────────────────────────────
// Hosted: every route below runs as the platform superadmin and spans all
// hotels. Desk edition: there is no superadmin — the hotel's own admin passes
// the gate above, so every query collapses to their own hotel (scope()),
// while operations that provision, suspend or delete hotels stay platform-only.
function scope(req) {
  return req.user.role === 'superadmin' ? null : req.user.tenantId;
}
function ownsTenant(req, tenantId) {
  return req.user.role === 'superadmin' || tenantId === req.user.tenantId;
}
function platformOnly(req, res) {
  if (req.user.role === 'superadmin') return true;
  res.status(403).json({ error: 'Only the platform operator can manage hotels' });
  return false;
}

// ── Platform Billing (automated subscription payments) ───────────────────
// The platform operator's own gateway credentials — NOT a hotel's. When at
// least one is configured, hotel plan requests return a hosted checkout URL
// and the gateway webhook activates subscriptions automatically.
// Secrets are stored encrypted at rest and only ever returned masked.
const platformSettings = require('../services/platform-settings');

router.get('/platform-billing', (req, res) => {
  const settings = platformSettings.visibleSettings();
  const base = billing.resolvePlatformBaseUrl(req);
  res.json({
    settings,
    autoPaymentsEnabled: billing.isAutoPaymentsEnabled(),
    webhookUrls: {
      stripe: base + '/api/webhooks/platform/stripe',
      paystack: base + '/api/webhooks/platform/paystack',
      flutterwave: base + '/api/webhooks/platform/flutterwave',
      korapay: base + '/api/webhooks/platform/korapay',
      opay: base + '/api/webhooks/platform/opay',
      payoneer: base + '/api/webhooks/platform/manual',
      airtm: base + '/api/webhooks/platform/manual',
      crypto: base + '/api/webhooks/platform/manual',
    },
  });
});

router.put('/platform-billing', (req, res) => {
  const allowed = [
    'stripe_secret_key', 'paystack_secret_key', 'flutterwave_secret_key',
    'flutterwave_public_key', 'flutterwave_webhook_secret',
    'korapay_secret_key', 'korapay_public_key',
    'opay_secret_key',
    'payoneer_client_secret', 'airtm_api_token', 'crypto_webhook_secret',
    'stripe_webhook_secret', 'platform_base_url',
  ];
  const updated = [];
  for (const [key, value] of Object.entries(req.body || {})) {
    if (!allowed.includes(key)) return res.status(400).json({ error: 'Unknown setting: ' + key });
    // Empty string = clear the stored value (explicit operator action).
    platformSettings.set(key, value === '' ? null : value);
    updated.push(key);
  }
  if (updated.length === 0) return res.status(400).json({ error: 'No settings provided' });
  audit(req, 'platform.billing_settings_updated', 'platform_settings', null, { keys: updated });
  res.json({ ok: true, updated, settings: platformSettings.visibleSettings(), autoPaymentsEnabled: billing.isAutoPaymentsEnabled() });
});

// Prices are derived from the entitlements catalog so the console can never
// disagree with what the checkout page charged.
const PLAN_MRR = Object.fromEntries(Object.entries(PLAN_CATALOG).map(([k, p]) => [k, p.priceMonthly]));

function publicTenant(t) {
  const roomCount = db.prepare('SELECT COUNT(*) as c FROM rooms WHERE tenant_id = ?').get(t.id).c;
  // SECURITY: spread the raw row ONLY after stripping credential columns —
  // `SELECT *` otherwise ships every hotel's WhatsApp tokens and payment
  // gateway secret keys to the superadmin console (and into proxied logs).
  return { ...sanitizeTenant(t), ai_enabled: !!t.ai_enabled, wa_connected: !!t.wa_connected, roomCount,
    subscriptionStatus: t.subscription_status, planId: t.plan_id, billingCycle: t.billing_cycle, nextBillingDate: t.next_billing_date };
}

router.get('/tenants', (req, res) => {
  const own = scope(req);
  const rows = own
    ? db.prepare('SELECT * FROM tenants WHERE id = ?').all(own)
    : db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
  res.json(rows.map(publicTenant));
});

router.get('/overview', (req, res) => {
  const own = scope(req);
  const tenants = own
    ? db.prepare('SELECT * FROM tenants WHERE id = ?').all(own)
    : db.prepare('SELECT * FROM tenants').all();
  const totalMrr = tenants.reduce((s, t) => s + (t.mrr || 0), 0);
  const totalRooms = own
    ? db.prepare('SELECT COUNT(*) as c FROM rooms WHERE tenant_id = ?').get(own).c
    : db.prepare('SELECT COUNT(*) as c FROM rooms').get().c;
  const activeCount = tenants.filter(t => t.status === 'active').length;
  const trialCount = tenants.filter(t => t.status === 'trial').length;
  const suspendedCount = tenants.filter(t => t.status === 'suspended').length;
  const revenueAllTime = own
    ? db.prepare("SELECT COALESCE(SUM(amount),0) s FROM platform_subscriptions WHERE status IN ('active','superseded') AND tenant_id = ?").get(own).s
    : db.prepare("SELECT COALESCE(SUM(amount),0) s FROM platform_subscriptions WHERE status IN ('active','superseded')").get().s;
  const pendingApprovals = own
    ? db.prepare("SELECT COUNT(*) c FROM platform_subscriptions WHERE status = 'pending_approval' AND tenant_id = ?").get(own).c
    : billing.countPending();
  res.json({
    totalHotels: tenants.length, activeHotels: activeCount, totalMrr, totalRooms,
    trialHotels: trialCount, suspendedHotels: suspendedCount,
    pendingApprovals, revenueAllTime,
  });
});

// ── Subscription approvals — the revenue control surface ────────────────────
// GET /api/superadmin/subscriptions?status=pending_approval
router.get('/subscriptions', (req, res) => {
  const { status } = req.query;
  const own = scope(req);
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (own) { where.push('tenant_id = ?'); params.push(own); }
  const rows = db.prepare('SELECT * FROM platform_subscriptions' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY requested_at DESC LIMIT 200').all(...params);
  const tenantName = db.prepare('SELECT id, name FROM tenants WHERE id = ?');
  res.json(rows.map(s => {
    const t = tenantName.get(s.tenant_id);
    return { ...s, hotelName: t ? t.name : s.tenant_id };
  }));
});

// POST /api/superadmin/subscriptions/:id/approve  { gatewayRef? }
// Marks payment received → tenant goes live on the requested plan immediately.
router.post('/subscriptions/:id/approve', (req, res) => {
  try {
    const pending = db.prepare('SELECT tenant_id FROM platform_subscriptions WHERE id = ?').get(req.params.id);
    if (!pending) return res.status(404).json({ error: 'Subscription not found' });
    if (!ownsTenant(req, pending.tenant_id)) return res.status(403).json({ error: 'Not your hotel' });
    const sub = billing.approveSubscription(req.params.id, {
      approvedBy: req.user.name || 'superadmin',
      gatewayRef: req.body.gatewayRef || null,
    });
    audit(req, 'billing.subscription_approved', 'platform_subscription', sub.id, { planId: sub.plan_id, tenantId: sub.tenant_id });
    res.json(sub);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/superadmin/subscriptions/:id/reject  { reason? }
router.post('/subscriptions/:id/reject', (req, res) => {
  try {
    const pending = db.prepare('SELECT tenant_id FROM platform_subscriptions WHERE id = ?').get(req.params.id);
    if (!pending) return res.status(404).json({ error: 'Subscription not found' });
    if (!ownsTenant(req, pending.tenant_id)) return res.status(403).json({ error: 'Not your hotel' });
    const sub = billing.rejectSubscription(req.params.id, req.body.reason);
    audit(req, 'billing.subscription_rejected', 'platform_subscription', sub.id, { reason: req.body.reason || null });
    res.json(sub);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/superadmin/billing-events — platform-wide billing trail
router.get('/billing-events', (req, res) => {
  const own = scope(req);
  res.json(own
    ? db.prepare('SELECT * FROM billing_events WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 300').all(own)
    : db.prepare('SELECT * FROM billing_events ORDER BY created_at DESC LIMIT 300').all());
});

// POST /api/superadmin/sweep-trials — flip expired trials to suspended
// (also runs automatically once per server boot).
router.post('/sweep-trials', (req, res) => {
  const swept = sweepExpiredTrials();
  audit(req, 'billing.trial_sweep', 'system', null, { swept });
  res.json({ swept });
});

router.post('/tenants', async (req, res) => {
  if (!platformOnly(req, res)) return;
  const { name, plan, rooms, email, country, subdomain } = req.body;
  if (!name) return res.status(400).json({ error: 'Hotel name is required' });
  if (!['starter','pro','enterprise'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });

  const sub = (subdomain || name.toLowerCase().replace(/[^a-z0-9]+/g, '-')).replace(/^-+|-+$/g, '');
  const existing = db.prepare('SELECT id FROM tenants WHERE subdomain = ?').get(sub);
  if (existing) return res.status(409).json({ error: 'Subdomain already taken' });

  const id = 'tenant_' + nanoid(10);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status, country, email, mrr, ai_enabled)
              VALUES (?,?,?,?, 'active', ?,?,?, 1)`)
    .run(id, name, sub, plan, country || null, email || null, PLAN_MRR[plan] || 29);

  // Create the hotel admin login
  let tempPassword = null;
  if (email) {
    tempPassword = nanoid(10);
    db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, avatar) VALUES (?,?,?,?,?, 'hotel_admin', 'HA')`)
      .run('user_' + nanoid(10), id, 'Hotel Admin', email.toLowerCase(), await hashPassword(tempPassword, 10));
  }

  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  audit(req, 'superadmin.tenant_create', 'tenant', id, { name, plan });
  res.status(201).json({ ...publicTenant(tenant), adminEmail: email || null, tempPassword });
});

router.patch('/tenants/:id', (req, res) => {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  if (!ownsTenant(req, tenant.id)) return res.status(403).json({ error: 'Not your hotel' });
  // Status flips are platform operations — a desk hotel admin suspending
  // their own hotel would lock the whole install out (requireTenant 403s).
  if (req.user.role !== 'superadmin' && req.body.status !== undefined) {
    return res.status(403).json({ error: 'Only the platform operator can change a hotel status' });
  }

  // Only real, writable columns. `rooms` is NOT a column — room count is derived
  // (see publicTenant), so accepting it here would throw "no such column: rooms".
  const fields = ['name', 'plan', 'status', 'email', 'country'];
  const updates = {};
  fields.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

  // Validate against the schema CHECK constraints so a bad value returns 400, not a 500.
  if (updates.plan !== undefined && !['starter', 'pro', 'enterprise'].includes(updates.plan)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }
  if (updates.status !== undefined && !['active', 'trial', 'suspended'].includes(updates.status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (updates.plan) updates.mrr = PLAN_MRR[updates.plan] || tenant.mrr;
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  const setClause = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE tenants SET ${setClause}, updated_at = datetime('now') WHERE id = @id`).run({ ...updates, id: tenant.id });

  const updated = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenant.id);
  audit(req, 'superadmin.tenant_update', 'tenant', tenant.id, updates);
  res.json(publicTenant(updated));
});

router.post('/tenants/:id/suspend', (req, res) => {
  if (!platformOnly(req, res)) return;
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  db.prepare(`UPDATE tenants SET status = 'suspended', updated_at = datetime('now') WHERE id = ?`).run(tenant.id);
  audit(req, 'superadmin.tenant_suspend', 'tenant', tenant.id);
  res.json({ ok: true });
});

router.post('/tenants/:id/reactivate', (req, res) => {
  if (!platformOnly(req, res)) return;
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  db.prepare(`UPDATE tenants SET status = 'active', updated_at = datetime('now') WHERE id = ?`).run(tenant.id);
  audit(req, 'superadmin.tenant_reactivate', 'tenant', tenant.id);
  res.json({ ok: true });
});

router.delete('/tenants/:id', (req, res) => {
  if (!platformOnly(req, res)) return;
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.params.id);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  db.prepare('DELETE FROM tenants WHERE id = ?').run(tenant.id); // cascades via FK
  audit(req, 'superadmin.tenant_delete', 'tenant', tenant.id);
  res.json({ ok: true });
});

router.get('/audit-log', (req, res) => {
  const own = scope(req);
  res.json(own
    ? db.prepare('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200').all(own)
    : db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all());
});

module.exports = router;
