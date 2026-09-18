// server/services/entitlements.js
// The SaaS entitlement layer: which plan a hotel is on, what features that plan
// unlocks, and what usage limits apply. This is the single source of truth —
// the landing page, the checkout funnel, the in-app Billing page and every
// route guard derive their view of the world from here.
//
// Gating model (deliberately forgiving, never punitive):
//   status 'trial'   → full requested-plan features until trial_ends_at
//   status 'active'  → features/limits of the subscribed plan
//   status 'suspended' (expired trial, past_due or cancelled subscription)
//                    → routes guarded by requireEntitlement return 402
// Guarded routes always answer 402 with { code: 'UPGRADE_REQUIRED' } so the
// frontend can show an upgrade prompt instead of a generic error.
'use strict';

const db = require('../db/connection');

const TRIAL_DAYS = 14;

// ── Plan catalog ──────────────────────────────────────────────────────────
// maxRooms/maxUsers/dailyBookingCap: null = unlimited.
const STARTER_FEATURES = [
  'booking_engine',        // public booking page + tender codes
  'whatsapp_inbox',        // shared WhatsApp inbox + cloud API
  'ai_receptionist',       // keyword AI auto-replies
  'front_desk',            // rooms, bookings, check-in/checkout
  'pos',                   // restaurant & bar point of sale
  'room_service',
  'guests_loyalty',
  'analytics_basic',
  'qr_confirmations',
];

const PLAN_CATALOG = {
  starter: {
    id: 'starter',
    name: 'Starter',
    tagline: 'Everything a small property needs to go digital',
    priceMonthly: 29,
    priceYearly: 290,
    maxRooms: 20,
    maxUsers: 5,
    maxProperties: 1,
    dailyBookingCap: 25,
    features: STARTER_FEATURES.slice(),
    sort: 1,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    tagline: 'Automation and every revenue center, unlocked',
    priceMonthly: 79,
    priceYearly: 790,
    maxRooms: 100,
    maxUsers: 25,
    maxProperties: 1,
    dailyBookingCap: 150,
    features: STARTER_FEATURES.concat([
      'guest_wifi',          // per-booking Wi-Fi provisioning
      'accounting',          // double-entry ledger + vouchers
      'eod',                 // end-of-day department closings
      'pool_bookings',
      'hall_events',
      'integrations_full',   // locks, IPTV, IoT, controllers (API Integrations page)
      'staff_shifts',        // shifts & attendance module
    ]),
    sort: 2,
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    tagline: 'Portfolios, custom integrations and priority support',
    priceMonthly: 199,
    priceYearly: 1990,
    maxRooms: null,
    maxUsers: null,
    maxProperties: null,
    dailyBookingCap: null,
    features: null, // filled below: pro + enterprise extras
    sort: 3,
  },
};
PLAN_CATALOG.enterprise.features = PLAN_CATALOG.pro.features.concat([
  'multi_property',
  'custom_integrations',
  'priority_support',
  'dedicated_onboarding',
]);

const FEATURE_LABELS = {
  booking_engine: 'Public booking engine with tender codes',
  whatsapp_inbox: 'WhatsApp shared inbox & Cloud API',
  ai_receptionist: 'AI receptionist auto-replies',
  front_desk: 'Front desk, reservations & folios',
  pos: 'Point of sale (restaurant & bar)',
  room_service: 'Room service orders',
  guests_loyalty: 'Guest profiles & loyalty',
  analytics_basic: 'Analytics & reports',
  qr_confirmations: 'QR booking confirmations',
  guest_wifi: 'Guest Wi-Fi provisioning per booking',
  accounting: 'Double-entry accounting',
  eod: 'End-of-day closings',
  pool_bookings: 'Pool bookings',
  hall_events: 'Hall & event bookings',
  integrations_full: 'Door locks, IPTV, IoT & controller integrations',
  staff_shifts: 'Shifts & attendance',
  multi_property: 'Multi-property portfolio',
  custom_integrations: 'Custom integrations',
  priority_support: 'Priority support',
  dedicated_onboarding: 'Dedicated onboarding',
};

function catalogPlan(id) {
  return PLAN_CATALOG[id] || null;
}

// Seed the catalog into platform_plans (idempotent) so the public pricing API
// and the superadmin console always have rows to work with.
function ensurePlansSeeded() {
  const insert = db.prepare(`INSERT INTO platform_plans (id, name, tagline, price_monthly, price_yearly, max_rooms, max_users, max_properties, daily_booking_cap, features, sort)
                             VALUES (?,?,?,?,?,?,?,?,?,?,?)
                             ON CONFLICT(id) DO NOTHING`);
  Object.values(PLAN_CATALOG).forEach(p => {
    insert.run(p.id, p.name, p.tagline, p.priceMonthly, p.priceYearly, p.maxRooms, p.maxUsers, p.maxProperties, p.dailyBookingCap, JSON.stringify(p.features), p.sort);
  });
}

// ── State resolution ────────────────────────────────────────────────────────
function getSubscription(tenantId) {
  return db.prepare('SELECT * FROM platform_subscriptions WHERE tenant_id = ?').get(tenantId) || null;
}

function trialDaysLeft(tenant) {
  if (!tenant.trial_ends_at) return null;
  const ms = new Date(tenant.trial_ends_at + (tenant.trial_ends_at.length === 10 ? 'T23:59:59Z' : '')).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

// The complete entitlement snapshot for a tenant — used by route guards, the
// /api/billing/entitlements endpoint and the login payload.
function resolveState(tenant) {
  const sub = getSubscription(tenant.id);
  // An approved/pending subscription decides the plan; otherwise the legacy
  // tenants.plan column (seeded demo hotels, superadmin-created tenants).
  const planId = (sub && sub.plan_id) || tenant.plan || 'starter';
  const plan = PLAN_CATALOG[planId] || PLAN_CATALOG.starter;
  const inTrial = tenant.status === 'trial' || (sub && sub.status === 'pending_approval' && tenant.status === 'trial');
  const daysLeft = trialDaysLeft(tenant);
  const trialExpired = tenant.status === 'trial' && tenant.trial_ends_at && daysLeft === 0 && !sub;
  const suspended = tenant.status === 'suspended'
    || (sub && ['past_due', 'cancelled'].includes(sub.status))
    || trialExpired;

  return {
    planId: plan.id,
    planName: plan.name,
    features: plan.features.slice(),
    limits: { maxRooms: plan.maxRooms, maxUsers: plan.maxUsers, maxProperties: plan.maxProperties, dailyBookingCap: plan.dailyBookingCap },
    status: suspended ? 'suspended' : (inTrial ? 'trial' : 'active'),
    trial: inTrial ? { daysLeft, endsAt: tenant.trial_ends_at } : null,
    pendingApproval: !!(sub && sub.status === 'pending_approval'),
    requestedPlanId: sub && sub.status === 'pending_approval' ? sub.plan_id : null,
    billingCycle: sub ? sub.billing_cycle : 'monthly',
    amount: sub ? sub.amount : null,
    subscription: sub ? {
      id: sub.id, planId: sub.plan_id, billingCycle: sub.billing_cycle, status: sub.status,
      amount: sub.amount, periodEnd: sub.period_end, paymentReference: sub.payment_reference,
    } : null,
  };
}

// ── Route guards ─────────────────────────────────────────────────────────────
// 402 body shape is contractual: the frontend api.js opens the upgrade modal
// whenever it sees code UPGRADE_REQUIRED / PLAN_LIMIT_REACHED / SUSPENDED.
function suspendedBody(state) {
  return {
    error: state.pendingApproval
      ? 'Your plan activation is awaiting approval by the platform team.'
      : 'This hotel\'s subscription is not active. Upgrade or contact the platform team to reactivate.',
    code: 'SUSPENDED',
    entitlements: { planId: state.planId, planName: state.planName, status: state.status },
  };
}

// requireEntitlement('accounting') — after requireAuth/resolveTenant/requireTenant.
// superadmin bypasses: they manage the platform itself.
function requireEntitlement(feature) {
  return (req, res, next) => {
    if (req.user && req.user.role === 'superadmin') return next();
    const tenant = req.tenant;
    if (!tenant) return res.status(400).json({ error: 'tenantId is required' });
    const state = resolveState(tenant);
    if (state.status === 'suspended') return res.status(402).json(suspendedBody(state));
    if (!state.features.includes(feature)) {
      return res.status(402).json({
        error: `"${FEATURE_LABELS[feature] || feature}" is not part of the ${state.planName} plan.`,
        code: 'UPGRADE_REQUIRED',
        feature,
        currentPlan: state.planId,
        upgradeTo: suggestedPlanFor(feature),
      });
    }
    next();
  };
}

// assertLimit(tenant, 'maxUsers', count) — throws a 402-shaped error object.
// Catch it in the route or pass through the global error handler (status 402).
function limitError(tenant, limitKey, currentCount) {
  const state = resolveState(tenant);
  const max = state.limits[limitKey];
  return Object.assign(new Error(
    `You've reached the ${state.planName} plan limit of ${max} (${limitKey === 'maxRooms' ? 'rooms' : 'staff logins'}). Upgrade to add more.`
  ), {
    status: 402,
    code: 'PLAN_LIMIT_REACHED',
    limitKey,
    limit: max,
    current: currentCount,
    currentPlan: state.planId,
    upgradeTo: suggestedPlanFor(limitKey, currentCount),
  });
}

function assertLimit(tenant, limitKey, currentCount) {
  if (tenant && tenant.id && PLAN_CATALOG[tenant.plan]) { /* catalog plan names are slugs */ }
  const state = resolveState(tenant);
  const max = state.limits[limitKey];
  if (max === null || max === undefined) return; // unlimited
  if (Number(currentCount) >= max) throw limitError(tenant, limitKey, currentCount);
}

// The cheapest plan (by sort) that unlocks `feature`, or that raises `limitKey`
// beyond the current usage.
function suggestedPlanFor(featureOrLimit, currentCount) {
  const plans = Object.values(PLAN_CATALOG).sort((a, b) => a.sort - b.sort);
  for (const p of plans) {
    if (p.features.includes(featureOrLimit)) return p.id;
    if (['maxRooms', 'maxUsers'].includes(featureOrLimit)) {
      const max = p[featureOrLimit];
      if (max === null || (currentCount !== undefined && Number(currentCount) < max)) return p.id;
    }
  }
  return 'enterprise';
}

// ── Trial lifecycle ─────────────────────────────────────────────────────────
function startTrial(tenantId, planId) {
  const ends = new Date(Date.now() + TRIAL_DAYS * 86400000).toISOString().slice(0, 10);
  db.prepare(`UPDATE tenants SET status = 'trial', trial_started_at = date('now'), trial_ends_at = ?, plan = COALESCE(?, plan) WHERE id = ?`)
    .run(ends, PLAN_CATALOG[planId] ? planId : null, tenantId);
  return ends;
}

// Boot-time sweep: flip expired trials to suspended so requireEntitlement and
// requireTenant start refusing requests. Returns how many expired.
function sweepExpiredTrials() {
  const expired = db.prepare(`SELECT id, name, trial_ends_at FROM tenants
                              WHERE status = 'trial' AND trial_ends_at IS NOT NULL
                                AND date(trial_ends_at) < date('now')`).all();
  if (expired.length === 0) return 0;
  const mark = db.prepare(`UPDATE tenants SET status = 'suspended', updated_at = datetime('now') WHERE id = ?`);
  const log = db.prepare(`INSERT INTO billing_events (id, tenant_id, type, note) VALUES (?,?,?,?)`);
  expired.forEach(t => {
    mark.run(t.id);
    log.run('evt_' + require('nanoid')(10), t.id, 'trial.expired', 'Trial ended on ' + t.trial_ends_at + ' — account suspended pending upgrade');
  });
  return expired.length;
}

module.exports = {
  TRIAL_DAYS,
  PLAN_CATALOG,
  FEATURE_LABELS,
  catalogPlan,
  ensurePlansSeeded,
  resolveState,
  getSubscription,
  requireEntitlement,
  assertLimit,
  limitError,
  suggestedPlanFor,
  startTrial,
  sweepExpiredTrials,
  trialDaysLeft,
};
