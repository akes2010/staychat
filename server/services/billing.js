// server/services/billing.js
// Subscription lifecycle: hotels pick a plan on the public checkout page (or in
// the in-app Billing page), the system records the request with a unique
// payment reference, and a platform operator (superadmin) approves it once
// payment lands — by bank transfer, POS, crypto or any gateway configured in
// the platform's payment_gateways catalog. The approval is what flips the
// tenant from trial/suspended to active with the new plan's entitlements.
//
// This is deliberately gateway-agnostic: card processors (Stripe/Paystack) can
// be wired by generating their hosted checkout URL here and matching their
// webhook to approveSubscription() — the plumbing points are marked inline.
'use strict';

const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { PLAN_CATALOG, resolveState, getSubscription } = require('./entitlements');
const { broadcast } = require('../ws');

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — phone-readable

// Short, human-dictatable subscription reference, e.g. SC-7K2M9QX4.
function makePaymentReference() {
  let ref;
  do {
    ref = 'SC-' + Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  } while (db.prepare('SELECT 1 FROM platform_subscriptions WHERE payment_reference = ?').get(ref));
  return ref;
}

function logEvent(tenantId, type, note, amount, ref) {
  db.prepare('INSERT INTO billing_events (id, tenant_id, type, note, amount, payment_reference) VALUES (?,?,?,?,?,?)')
    .run('evt_' + nanoid(10), tenantId || null, type, note || null, amount ?? null, ref || null);
}

function notifySuperadmins() {
  broadcast(null, 'billing.pending_request', { count: countPending() });
}

function countPending() {
  return db.prepare(`SELECT COUNT(*) c FROM platform_subscriptions WHERE status = 'pending_approval'`).get().c;
}

// A hotel requests a plan: records a pending subscription with a payment
// reference and (if the tenant is still trialing) bumps the plan immediately so
// they can try the requested tier's features during the trial. Replaces any
// previous pending request.
function requestPlan(tenant, planId, billingCycle, paymentMethod) {
  const plan = PLAN_CATALOG[planId];
  if (!plan) throw Object.assign(new Error('Unknown plan: ' + planId), { status: 400 });
  const cycle = billingCycle === 'yearly' ? 'yearly' : 'monthly';
  const amount = cycle === 'yearly' ? plan.priceYearly : plan.priceMonthly;

  const ref = makePaymentReference();
  const id = 'sub_' + nanoid(10);

  const doRequest = db.transaction(() => {
    // Supersede any previous pending request — one outstanding request per hotel.
    db.prepare(`UPDATE platform_subscriptions SET status = 'superseded' WHERE tenant_id = ? AND status = 'pending_approval'`).run(tenant.id);
    db.prepare(`INSERT INTO platform_subscriptions (id, tenant_id, plan_id, billing_cycle, amount, status, payment_reference, payment_method, requested_by)
                VALUES (?,?,?,?,?, 'pending_approval', ?,?,?)`)
      .run(id, tenant.id, planId, cycle, amount, ref, paymentMethod || 'bank_transfer', tenant._requestedBy || null);

    // During an active trial the requested plan applies immediately (try before buy).
    // Expired/suspended tenants stay suspended until an operator approves payment.
    if (tenant.status === 'trial') {
      db.prepare(`UPDATE tenants SET plan = ?, updated_at = datetime('now') WHERE id = ?`).run(planId, tenant.id);
    }
    logEvent(tenant.id, 'plan.requested', `${plan.name} (${cycle}) requested via ${paymentMethod || 'bank_transfer'} — awaiting payment/approval`, amount, ref);
  });
  doRequest();

  notifySuperadmins();
  return { subscription: getSubscription(tenant.id), plan, amount, paymentReference: ref, billingCycle: cycle };
}

// Platform operator marks the payment as received → tenant goes live instantly.
function approveSubscription(subId, opts = {}) {
  const sub = db.prepare('SELECT * FROM platform_subscriptions WHERE id = ?').get(subId);
  if (!sub) throw Object.assign(new Error('Subscription not found'), { status: 404 });
  if (sub.status !== 'pending_approval') throw Object.assign(new Error('This request has already been processed'), { status: 409 });

  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(sub.tenant_id);
  const plan = PLAN_CATALOG[sub.plan_id] || PLAN_CATALOG.starter;
  const cycle = sub.billing_cycle === 'yearly' ? 'yearly' : 'monthly';
  const months = cycle === 'yearly' ? 12 : 1;
  const periodEnd = new Date(Date.now() + months * 30 * 86400000).toISOString().slice(0, 10);

  const doApprove = db.transaction(() => {
    db.prepare(`UPDATE platform_subscriptions
                SET status = 'active', period_start = date('now'), period_end = ?, approved_at = datetime('now'),
                    approved_by = ?, gateway_ref = COALESCE(?, gateway_ref)
                WHERE id = ?`).run(periodEnd, opts.approvedBy || 'superadmin', opts.gatewayRef || null, subId);

    // Historical paid subscription goes superseded; active one stays 'active'.
    db.prepare(`UPDATE platform_subscriptions SET status = 'superseded' WHERE tenant_id = ? AND id != ? AND status = 'active'`).run(sub.tenant_id, subId);

    // Tenant goes live: active status, subscribed plan, legacy columns synced
    // so every existing route (requireTenant, reports, dashboards) agrees.
    db.prepare(`UPDATE tenants
                SET status = 'active', plan = ?, mrr = ?, subscription_status = 'active',
                    plan_id = (SELECT id FROM plans WHERE LOWER(name) = ? LIMIT 1),
                    billing_cycle = ?, next_billing_date = ?, updated_at = datetime('now')
                WHERE id = ?`)
      .run(sub.plan_id, cycle === 'yearly' ? Math.round(plan.priceYearly / 12) : plan.priceMonthly,
           plan.name.toLowerCase(), cycle, periodEnd, sub.tenant_id);

    logEvent(sub.tenant_id, 'plan.activated', `${plan.name} activated (${cycle}) — valid until ${periodEnd}${opts.gatewayRef ? ' via ' + opts.gatewayRef : ''}`, sub.amount, sub.payment_reference);
  });
  doApprove();

  broadcast(tenant.id, 'subscription.activated', { planId: sub.plan_id, planName: plan.name, periodEnd });
  return db.prepare('SELECT * FROM platform_subscriptions WHERE id = ?').get(subId);
}

// Operator marks a request as paid-declined / cancelled. Tenant keeps current state.
function rejectSubscription(subId, reason) {
  const sub = db.prepare('SELECT * FROM platform_subscriptions WHERE id = ?').get(subId);
  if (!sub) throw Object.assign(new Error('Subscription not found'), { status: 404 });
  if (sub.status !== 'pending_approval') throw Object.assign(new Error('This request has already been processed'), { status: 409 });
  db.prepare(`UPDATE platform_subscriptions SET status = 'rejected', approved_at = datetime('now'), approved_by = approved_by WHERE id = ?`).run(subId);
  logEvent(sub.tenant_id, 'plan.request_rejected', reason || 'Payment not received / request declined', sub.amount, sub.payment_reference);
  return db.prepare('SELECT * FROM platform_subscriptions WHERE id = ?').get(subId);
}

// Full picture for the in-app Billing page and the superadmin console.
function tenantBillingSnapshot(tenant) {
  const state = resolveState(tenant);
  const history = db.prepare('SELECT * FROM platform_subscriptions WHERE tenant_id = ? ORDER BY requested_at DESC LIMIT 20').all(tenant.id);
  const pending = history.find(s => s.status === 'pending_approval') || null;
  return { ...state, history, pending };
}

module.exports = {
  makePaymentReference,
  requestPlan,
  approveSubscription,
  rejectSubscription,
  tenantBillingSnapshot,
  countPending,
  logEvent,
};
