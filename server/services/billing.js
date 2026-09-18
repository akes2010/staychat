// server/services/billing.js
// Subscription lifecycle: hotels pick a plan on the public checkout page (or in
// the in-app Billing page), the system records the request with a unique
// payment reference, and the subscription activates when payment lands —
// either AUTOMATICALLY via a gateway webhook (Stripe/Paystack hosted checkout,
// configured by the platform operator in Super Admin → Platform Billing) or
// MANUALLY when an operator approves it against a bank-transfer/POS reference.
// The approval is what flips the tenant from trial/suspended to active with
// the new plan's entitlements.
'use strict';

const { nanoid } = require('nanoid');
const db = require('../db/connection');
const { PLAN_CATALOG, resolveState, getSubscription } = require('./entitlements');
const platformSettings = require('./platform-settings');
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

// ── Platform base URL ────────────────────────────────────────────────────────
// Used to build gateway callback/redirect URLs. Priority: APP_URL env (set it
// in production so proxies can't skew it) → the request's forwarded headers →
// localhost fallback (dev).
function resolvePlatformBaseUrl(req) {
  if (process.env.APP_URL) return String(process.env.APP_URL).replace(/\/+$/, '');
  if (req) {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (host) return proto + '://' + host;
  }
  return 'http://localhost:' + (process.env.PORT || 3000);
}

// ── Automated checkout (platform gateways) ─────────────────────────────────
// The PLATFORM operator configures Stripe/Paystack secret keys once, in
// Super Admin → Platform Billing. From then on every hotel's plan request
// returns a hosted-checkout URL; the gateway webhook (see routes/webhooks.js)
// calls approveSubscriptionByGatewayRef() — no manual approval needed.

function isAutoPaymentsEnabled() {
  return platformSettings.has('stripe_secret_key') || platformSettings.has('paystack_secret_key');
}

async function createStripeCheckout(sub, plan, baseUrl) {
  const secret = platformSettings.get('stripe_secret_key');
  const cycleLabel = sub.billing_cycle === 'yearly' ? ' — yearly' : ' — monthly';
  const body = new URLSearchParams({
    mode: 'payment',
    'payment_method_types[0]': 'card',
    client_reference_id: sub.id,
    customer_email: sub.tenant_email || '',
    success_url: baseUrl + '/pay?ref=' + sub.payment_reference + '&session_id={CHECKOUT_SESSION_ID}',
    cancel_url: baseUrl + '/app',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(Math.round(sub.amount * 100)),
    'line_items[0][price_data][product_data][name]': 'StayChat OS — ' + plan.name + ' plan' + cycleLabel,
    'metadata[subscription_id]': sub.id,
  });
  if (!sub.tenant_email) body.delete('customer_email');

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.url) {
    throw Object.assign(new Error('Stripe checkout failed: ' + (data.error?.message || res.status)), { status: 502 });
  }
  return { url: data.url, sessionId: data.id, provider: 'stripe' };
}

async function createPaystackCheckout(sub, plan, baseUrl) {
  const secret = platformSettings.get('paystack_secret_key');
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: Math.round(sub.amount * 100), // kobo
      email: sub.tenant_email || 'billing@staychat.io',
      reference: sub.payment_reference, // unique SC- reference — doubles as gateway ref
      callback_url: baseUrl + '/pay?ref=' + sub.payment_reference,
      metadata: { subscription_id: sub.id, plan: plan.name, hotel: sub.tenant_name || '' },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.data?.authorization_url) {
    throw Object.assign(new Error('Paystack checkout failed: ' + (data.message || res.status)), { status: 502 });
  }
  return { url: data.data.authorization_url, sessionId: data.data.access_code, provider: 'paystack' };
}

/**
 * Create (or reuse) a pending subscription for this tenant and — if the
 * platform has a gateway configured — return a hosted checkout URL for it.
 * Falls back to the manual SC- reference flow when no gateway is configured
 * or the gateway call fails (network/API errors must never block a hotel from
 * being able to request a plan).
 */
async function createCheckoutSession(tenant, planId, billingCycle, req) {
  const manual = requestPlan(tenant, planId, billingCycle, 'card');
  const base = {
    ...manual,
    checkoutUrl: null,
    provider: null,
    autoApprove: false,
  };

  if (!isAutoPaymentsEnabled()) return base;

  const plan = PLAN_CATALOG[planId];
  const sub = manual.subscription;
  // Tenant contact email for pre-filled guest details on the gateway form.
  sub.tenant_email = tenant.email || null;
  sub.tenant_name = tenant.name || null;

  try {
    const checkout = process.env.PLATFORM_GATEWAY === 'paystack' && platformSettings.has('paystack_secret_key')
      ? await createPaystackCheckout(sub, plan, resolvePlatformBaseUrl(req))
      : platformSettings.has('stripe_secret_key')
        ? await createStripeCheckout(sub, plan, resolvePlatformBaseUrl(req))
        : await createPaystackCheckout(sub, plan, resolvePlatformBaseUrl(req));

    db.prepare('UPDATE platform_subscriptions SET payment_method = ?, gateway_ref = COALESCE(?, gateway_ref) WHERE id = ?')
      .run(checkout.provider, checkout.sessionId, sub.id);
    logEvent(tenant.id, 'checkout.created', plan.name + ' (' + manual.billingCycle + ') hosted checkout opened via ' + checkout.provider, manual.amount, manual.paymentReference);
    return { ...base, checkoutUrl: checkout.url, provider: checkout.provider, autoApprove: true };
  } catch (err) {
    // Gateway outage / misconfiguration → degrade gracefully to the manual
    // reference flow. The subscription + SC- reference already exist.
    console.error('[billing] checkout creation failed, falling back to manual flow:', err.message);
    logEvent(tenant.id, 'checkout.failed', 'Hosted checkout unavailable (' + err.message + ') — manual reference flow continues', manual.amount, manual.paymentReference);
    return base;
  }
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

// ── Gateway-webhook auto-approval ───────────────────────────────────────────
// Called from routes/webhooks.js once a gateway event has been signature-
// verified. Idempotent: a duplicate/replayed webhook finds an already-processed
// reference and no-ops. When the webhook carries an amount, it must match the
// subscription total — a partial payment activates nothing and is logged for
// the operator to reconcile manually.
function approveSubscriptionByGatewayRef(provider, gatewayRef, opts = {}) {
  if (!gatewayRef) return null;
  // Matches, in order of specificity: the subscription's own id (Stripe's
  // client_reference_id / metadata.subscription_id), the gateway ref we stored
  // at checkout creation (Stripe session id, Paystack access code), or the
  // human SC- reference (Paystack uses it directly as the charge reference).
  const sub = db.prepare(
    `SELECT * FROM platform_subscriptions
     WHERE id = ? OR gateway_ref = ? OR payment_reference = ?
     ORDER BY (id = ?) DESC, requested_at DESC LIMIT 1`
  ).get(String(gatewayRef), String(gatewayRef), String(gatewayRef), String(gatewayRef));
  if (!sub) {
    console.warn('[billing] gateway event for unknown reference:', provider, gatewayRef);
    return null;
  }
  if (sub.status === 'active') return sub; // duplicate webhook after success — already live

  if (opts.amount != null && opts.amount > 0) {
    const paid = Math.round(opts.amount * 100);
    const due = Math.round(sub.amount * 100);
    if (paid < due) {
      logEvent(sub.tenant_id, 'payment.underpaid',
        provider + ' event amount ' + opts.amount + ' < due ' + sub.amount + ' — NOT activated, operator review needed',
        opts.amount, sub.payment_reference);
      return null;
    }
  }

  return approveSubscription(sub.id, {
    approvedBy: 'auto:' + provider,
    gatewayRef: String(gatewayRef),
  });
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
  approveSubscriptionByGatewayRef,
  createCheckoutSession,
  resolvePlatformBaseUrl,
  isAutoPaymentsEnabled,
  rejectSubscription,
  tenantBillingSnapshot,
  countPending,
  logEvent,
};
