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
const { requireAuth, resolveTenant, requireTenant, audit } = require('../middleware/auth');
const { PLAN_CATALOG, FEATURE_LABELS, resolveState, ensurePlansSeeded } = require('../services/entitlements');
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
    trialDays: 14,
    currency: 'USD',
  });
});

// Signed-in users (including trialing hotels) can read their entitlements.
router.get('/state', requireAuth, resolveTenant, requireTenant, (req, res) => {
  res.json(resolveState(req.tenant));
});

// ── Authenticated endpoints (suspension escape hatch) ────────────────────────
function loadTenant(req) {
  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(req.tenantId);
  if (!tenant) throw Object.assign(new Error('Tenant not found'), { status: 404 });
  return tenant;
}

router.get('/summary', requireAuth, resolveTenant, (req, res) => {
  try {
    res.json(billing.tenantBillingSnapshot(loadTenant(req)));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Pick a plan and receive a payment reference (SC-XXXXXXXX) for the platform
// operator to reconcile. During an active trial the requested tier's features
// are unlocked immediately; activation after payment is the operator's approval.
// Works while suspended — that's the self-service reactivation path.
router.post('/request-plan', requireAuth, resolveTenant, (req, res) => {
  const { planId, billingCycle, paymentMethod } = req.body || {};
  if (!PLAN_CATALOG[planId]) return res.status(400).json({ error: 'Unknown plan' });
  try {
    const result = billing.requestPlan(loadTenant(req), planId, billingCycle, paymentMethod);
    audit(req, 'billing.plan_requested', 'platform_subscription', result.subscription.id, { planId, billingCycle, paymentMethod });
    res.status(201).json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Withdraw a pending activation request.
router.post('/cancel-request', requireAuth, resolveTenant, (req, res) => {
  const sub = db.prepare(`SELECT * FROM platform_subscriptions WHERE tenant_id = ? AND status = 'pending_approval' ORDER BY requested_at DESC`)
    .get(req.tenantId);
  if (!sub) return res.status(404).json({ error: 'No pending plan request to cancel' });
  db.prepare(`UPDATE platform_subscriptions SET status = 'cancelled', approved_at = datetime('now') WHERE id = ?`).run(sub.id);
  billing.logEvent(req.tenantId, 'plan.request_cancelled', 'Hotel withdrew the activation request for ' + sub.plan_id);
  audit(req, 'billing.request_cancelled', 'platform_subscription', sub.id);
  res.json({ ok: true });
});

module.exports = router;
