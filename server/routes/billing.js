// server/routes/billing.js
// Tenant-facing billing API.
//
// Public (no auth):
//   GET /api/billing/pricing          — plan catalog for landing/checkout
// Authenticated:
//   GET  /api/billing/state           — hotel's plan, limits, trial, pending request
//   GET  /api/billing/summary         — snapshot + history for the Billing page
//   POST /api/billing/request-plan    — pick a plan, get a payment reference
//   POST /api/billing/cancel-request  — withdraw a pending activation request
//
// NOTE: /summary, /request-plan and /cancel-request deliberately do NOT pass
// through requireTenant's suspension block — a suspended hotel must still be
// able to see its state and request a plan, or it could never self-serve its
// way back to active. Those handlers re-resolve the tenant directly.
'use strict';

const express = require('express');
const db = require('../db/connection');
const { requireAuth, resolveTenant, requireTenant, requireRole, audit } = require('../middleware/auth');
const { requirePermission } = require('../utils/permissions');
const { PLAN_CATALOG, FEATURE_LABELS, TRIAL_DAYS, resolveState, ensurePlansSeeded } = require('../services/entitlements');
const billing = require('../services/billing');

const router = express.Router();

// ── Public endpoints ─────────────────────────────────────────────────────────
// Served from the in-code catalog (kept in sync with platform_plans by
// ensurePlansSeeded) so the marketing page can never show a price the system
// won't honor.
router.get('/pricing', (req, res) => {
  ensurePlansSeeded();
  res.json({
    plans: Object.values(PLAN_CATALOG).sort((a, b) => a.sort - b.sort).map(p => ({
      id: p.id, name: p.name, tagline: p.tagline,
      priceMonthly: p.priceMonthly, priceYearly: p.priceYearly,
      maxRooms: p.maxRooms, maxUsers: p.maxUsers, maxProperties: p.maxProperties,
      dailyBookingCap: p.dailyBookingCap, features: p.features,
      featureLabels: p.features.map(f => FEATURE_LABELS[f] || f),
    })),
    trialDays: TRIAL_DAYS,
    currency: 'USD',
  });
});

// Plan state / billing snapshot are owner/admin surfaces. Non-admin staff get
// their limits enforced through entitlements on every request; they don't need
// (and shouldn't see) plan, price, and payment history. Requires the
// 'billing.manage' capability (owner/admin by default, customizable per user).
// NOTE: suspended hotels keep their self-service reactivation path — the
// request-plan/cancel-request handlers below re-resolve the tenant directly.
router.get('/state', requireAuth, resolveTenant, requireTenant, requirePermission('billing.manage'), (req, res) => {
  res.json(resolveState(req.tenant));
});

// ── Authenticated endpoints (suspension escape hatch) ────────────────────────
function loadTenant(req) {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  return tenant;
}

// Owner/admin only (billing.manage) — plan + payment history.
router.get('/summary', requireAuth, resolveTenant, requirePermission('billing.manage'), (req, res) => {
  try {
    res.json(billing.tenantBillingSnapshot(loadTenant(req)));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /api/billing/usage — rooms/staff usage for the plan meters. Deliberately
// light and open to EVERY signed-in hotel user: the whole team sees which plan
// the hotel is on and how full it is (transparency), while plan REQUESTS stay
// an owner/admin action enforced at request time.
router.get('/usage', requireAuth, resolveTenant, requireTenant, (req, res) => {
  const rooms = db.prepare('SELECT COUNT(*) c FROM rooms WHERE tenant_id = ?').get(req.tenantId).c;
  const users = db.prepare('SELECT COUNT(*) c FROM users WHERE tenant_id = ? AND active = 1').get(req.tenantId).c;
  res.json({ rooms, users });
});

// Pick a plan and receive a payment reference (SC-XXXXXXXX) for the platform
// operator to reconcile. During an active trial the requested tier's features
// are unlocked immediately; activation after payment is the operator's approval.
// Works while suspended — that's the self-service reactivation path.
//
// If the PLATFORM operator has configured a card gateway (Super Admin →
// Platform Billing), the response also carries a hosted `checkoutUrl` and
// `autoApprove: true` — the gateway webhook then activates the subscription
// with no manual step. Either way the SC- reference is issued, so the manual
// flow keeps working when no gateway is configured (or the gateway is down).
// Plan requests change the hotel's commercial commitments — owner/admin only.
// Staff can VIEW the plans (Billing page) but a request from anyone else 403s.
router.post('/request-plan', requireAuth, resolveTenant, requireRole('hotel_admin', 'superadmin'), async (req, res) => {
  const { planId, billingCycle, paymentMethod } = req.body || {};
  if (!PLAN_CATALOG[planId]) return res.status(400).json({ error: 'Unknown plan' });
  try {
    const result = await billing.createCheckoutSession(loadTenant(req), planId, billingCycle, req);
    audit(req, 'billing.plan_requested', 'platform_subscription', result.subscription.id,
      { planId, billingCycle, paymentMethod, provider: result.provider, autoApprove: result.autoApprove });
    res.status(201).json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Withdraw a pending activation request (owner/admin, like the request itself).
router.post('/cancel-request', requireAuth, resolveTenant, requireRole('hotel_admin', 'superadmin'), (req, res) => {
  const sub = db.prepare(`SELECT * FROM platform_subscriptions WHERE tenant_id = ? AND status = 'pending_approval' ORDER BY requested_at DESC`)
    .get(req.tenantId);
  if (!sub) return res.status(404).json({ error: 'No pending plan request to cancel' });
  db.prepare(`UPDATE platform_subscriptions SET status = 'cancelled', approved_at = datetime('now') WHERE id = ?`).run(sub.id);
  billing.logEvent(req.tenantId, 'plan.request_cancelled', 'Hotel withdrew the activation request for ' + sub.plan_id);
  audit(req, 'billing.request_cancelled', 'platform_subscription', sub.id);
  res.json({ ok: true });
});

module.exports = router;
