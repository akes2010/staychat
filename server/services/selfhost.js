// server/services/selfhost.js
// The one-time $3,000 "Desk PC Edition" — the offline / locally-deployable
// installation of StayChat OS, sold as a perpetual licence (no subscription).
//
// This feature is deliberately SELF-CONTAINED: it creates its own idempotent
// table at load time, ships its own email templates, and only ever CALLS the
// existing platform services (billing log, platform settings, email transport,
// ws broadcast) without modifying them. Payment confirmation arrives either
// via verify-on-return (the status poll below), the operator's confirm route,
// or — so a customer who never comes back from the gateway still gets mailed
// their software — the platform gateway webhook falling back to
// confirmPayment() (see server/routes/webhooks.js).
//
// Flow:
//   1. Landing-page form → registerOrder(): a row in selfhost_orders with a
//      quotable SC- reference + a "registered" email to the customer.
//      If the platform operator configured Stripe/Paystack in Super Admin →
//      Platform Billing, a hosted ONE-TIME checkout URL is returned too.
//   2. Payment confirmed via one of:
//        a) verify-on-return: the customer comes back to the landing page and
//           the status poll asks the GATEWAY API (server-side, secret key) if
//           the stored checkout actually succeeded — signature-verified by
//           construction because we fetch it ourselves;
//        b) the platform operator: POST /api/selfhost/admin/orders/:ref/confirm
//           (bank transfer / POS / offline payment).
//   3. Delivery → licence key + tokenized download link generated, then the
//      SOFTWARE is emailed to the customer (selfhostDeliveredEmail below).
//      Idempotent: confirming or delivering twice never double-mails — an
//      explicit resendToCustomer() reuses the SAME key/token.
//
// Config (all optional):
//   SELFHOST_PACKAGE_PATH  installer zip to serve from the emailed link
//                          (default: <repo>/dist/staychat-desk.zip)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nanoid } = require('nanoid');
const db = require('../db/connection');
const billing = require('./billing');
const platformSettings = require('./platform-settings');
const email = require('./email');
const { broadcastSuperadmins } = require('../ws');

// The plan itself — the single source of truth for the price shown on the
// landing page, charged at checkout, and stored on every order.
const SELFHOST_PLAN = {
  id: 'selfhost_desk',
  name: 'Desk PC Edition (Self-Hosted)',
  price: 3000, // one-time, USD — no renewals
  billing: 'one_time',
};

// ── Schema (idempotent, runs at load — no changes to server/db/migrate.js) ──
function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS selfhost_orders (
      id TEXT PRIMARY KEY,                     -- sho_<nanoid>
      payment_reference TEXT UNIQUE NOT NULL,   -- SC-XXXXXXXX, quotable over the phone
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      hotel_name TEXT,
      phone TEXT,
      country TEXT,
      amount REAL NOT NULL DEFAULT 3000,       -- one-time, USD
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','delivered','cancelled')),
      payment_method TEXT,                     -- 'stripe' | 'paystack' | 'bank_transfer' | ...
      gateway_ref TEXT,                        -- checkout session id / gateway charge ref
      checkout_url TEXT,                       -- hosted checkout at registration (if any)
      license_key TEXT,                        -- generated at payment confirmation
      download_token TEXT,                     -- token behind the emailed download link
      requested_by_ip TEXT,
      approved_by TEXT,                        -- 'stripe' / 'paystack' / operator name
      paid_at TEXT,
      delivered_at TEXT,                       -- last time the software email went out
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_selfhost_status ON selfhost_orders(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_selfhost_gateway ON selfhost_orders(gateway_ref);
  `);
}
ensureSchema();
// Re-run on every call site entry point too (cheap no-op after first run) so
// a wiped DB re-created mid-process still works.
function ensureSchemaSoft() { try { ensureSchema(); } catch (e) { /* race with concurrent boot */ } }

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L — phone-readable

function makeReference() {
  let ref;
  do {
    ref = 'SC-' + Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  } while (
    db.prepare('SELECT 1 FROM selfhost_orders WHERE payment_reference = ?').get(ref) ||
    db.prepare('SELECT 1 FROM platform_subscriptions WHERE payment_reference = ?').get(ref)
  );
  return ref;
}

// Perpetual licence key, phone-readable: SCHK-XXXXX-XXXXX-XXXXX
function makeLicenseKey() {
  const group = () => Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  return 'SCHK-' + group() + '-' + group() + '-' + group();
}

// ── Where the installer package lives ────────────────────────────────────────
// The operator drops the built desktop package in place. The emailed link
// under /api/selfhost/download serves that file — until it exists, delivery
// still proceeds (licence key + "the platform team will send the installer"),
// so a missing artifact never blocks a paid order.
function packagePath() {
  return process.env.SELFHOST_PACKAGE_PATH
    ? path.resolve(process.env.SELFHOST_PACKAGE_PATH)
    : path.join(__dirname, '..', '..', 'dist', 'staychat-desk.zip');
}

function packageAvailable() {
  try { return fs.statSync(packagePath()).isFile(); } catch (e) { return false; }
}

function downloadUrlFor(order) {
  if (!order.download_token) return null;
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  return base + '/api/selfhost/download/' + order.payment_reference + '/' + order.download_token;
}

function publicView(order) {
  // Everything a (public, unauthenticated) status poll may see — no PII.
  return {
    ref: order.payment_reference,
    status: order.status,
    amount: order.amount,
    planId: SELFHOST_PLAN.id,
    planName: SELFHOST_PLAN.name,
    hasCheckoutUrl: !!order.checkout_url,
    paidAt: order.paid_at,
    deliveredAt: order.delivered_at,
  };
}

function logEvent(type, note, amount, ref) {
  billing.logEvent(null, type, note, amount, ref);
}

function notifySuperadmins() {
  const pending = db.prepare(`SELECT COUNT(*) c FROM selfhost_orders WHERE status = 'pending'`).get().c;
  // Platform room, not broadcast(null, …) — a null tenantId never addresses a
  // room, so the operator console's live badge would silently never fire.
  broadcastSuperadmins('selfhost.order_created', { count: pending });
}

// ── Email templates (local — server/services/email.js stays untouched) ──────
// Same visual language as the platform's branded wrap(): dark bg, white card.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function refBox(label, value) {
  return '<div style="text-align:center;background:#eff6ff;border:2px dashed #2563eb;border-radius:12px;padding:14px;margin:16px 0">' +
    '<div style="font-size:10.5px;letter-spacing:1.5px;color:#64748b;font-weight:700">' + esc(label) + '</div>' +
    '<div style="font-size:24px;font-weight:800;letter-spacing:2px;color:#1d4ed8;margin-top:4px;user-select:all">' + esc(value) + '</div></div>';
}

function wrap(title, bodyHtml) {
  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0f1b2d;font-family:-apple-system,Segoe UI,Roboto,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto;padding:32px 20px">' +
    '<div style="text-align:center;color:#fff;font-weight:800;font-size:17px;margin-bottom:20px">' +
    '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:linear-gradient(135deg,#4f8cff,#22d3a7);margin-right:8px"></span>StayChat OS</div>' +
    '<div style="background:#fff;border-radius:16px;padding:28px;color:#1e293b">' +
    '<h1 style="font-size:19px;margin:0 0 14px">' + esc(title) + '</h1>' +
    bodyHtml +
    '</div>' +
    '<div style="text-align:center;color:rgba(255,255,255,.55);font-size:11.5px;margin-top:16px">StayChat OS — Desk PC Edition · self-hosted, offline, yours forever</div>' +
    '</div></body></html>';
}

// Registration confirmation: quotes the payment reference, then promises the
// software by email the moment payment is confirmed.
function selfhostOrderReceivedEmail({ name, hotelName, amount, paymentReference, checkoutUrl }) {
  const html = wrap('Register your StayChat OS Desk PC Edition',
    '<p style="font-size:14px;line-height:1.7">Hi ' + esc(name || 'there') + ', we registered your request for the <b>Desk PC Edition</b> of StayChat OS' +
    (hotelName ? ' for <b>' + esc(hotelName) + '</b>' : '') + ' — the self-hosted build that runs offline on your own desk PC / local network.</p>' +
    '<p style="font-size:14px">One-time payment: <b>$' + Number(amount || 3000).toLocaleString('en-US') + '</b> — no subscription, no renewals, your data never leaves your premises.</p>' +
    refBox('PAYMENT REFERENCE', paymentReference) +
    (checkoutUrl
      ? '<p style="margin:18px 0 0"><a href="' + checkoutUrl + '" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;border-radius:10px;padding:11px 22px;font-weight:700;font-size:14px">Pay securely online →</a></p>'
      : '<p style="font-size:13px;color:#475569">Pay by bank transfer / POS and quote the reference above as the narration.</p>') +
    '<p style="font-size:13.5px;color:#475569;line-height:1.7;margin-top:14px"><b>What happens next?</b> The moment your payment is confirmed, your licence key and the installer package are emailed to you at this address.</p>');
  return {
    subject: 'Registered — StayChat OS Desk PC Edition (reference ' + paymentReference + ')',
    html,
    text: 'Hi ' + (name || 'there') + ',\n\nYour Desk PC Edition registration is recorded.\nOne-time payment: $' + (amount || 3000) +
      '\nPayment reference: ' + paymentReference +
      (checkoutUrl ? '\nPay online: ' + checkoutUrl : '\nQuote this reference with your bank transfer.') +
      '\n\nOnce payment is confirmed we email your licence key and the installer package.',
  };
}

// Delivery email: the actual software hand-off — licence key + download link.
function selfhostDeliveredEmail({ name, hotelName, reference, licenseKey, downloadUrl, version }) {
  const html = wrap('Your StayChat OS software is ready 🎉',
    '<p style="font-size:14px;line-height:1.7">Hi ' + esc(name || 'there') + ', your payment for the <b>Desk PC Edition</b>' +
    (hotelName ? ' (' + esc(hotelName) + ')' : '') + ' is confirmed — here is your software.</p>' +
    refBox('LICENCE KEY', licenseKey) +
    '<table style="width:100%;font-size:13.5px;line-height:1.9">' +
      '<tr><td style="color:#64748b;padding-right:10px;white-space:nowrap">Order reference</td><td><b>' + esc(reference) + '</b></td></tr>' +
      '<tr><td style="color:#64748b">Edition</td><td><b>Desk PC Edition</b> (self-hosted, offline / local network)</td></tr>' +
      (version ? '<tr><td style="color:#64748b">Version</td><td><b>' + esc(version) + '</b></td></tr>' : '') +
    '</table>' +
    (downloadUrl
      ? '<p style="margin:18px 0 0"><a href="' + downloadUrl + '" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;border-radius:10px;padding:11px 22px;font-weight:700;font-size:14px">Download the installer →</a></p>'
      : '<p style="font-size:13.5px;color:#475569">The installer package ships with this release — reply to this email if you need it re-sent.</p>') +
    '<ol style="font-size:13.5px;color:#475569;line-height:1.8;padding-left:20px;margin-top:16px">' +
      '<li>Download and run the installer on your desk PC or in-house server.</li>' +
      '<li>Start the app and paste your licence key when prompted.</li>' +
      '<li>Works on your local network — no internet connection required after install.</li>' +
    '</ol>' +
    '<p style="font-size:12.5px;color:#64748b;margin-top:12px">Keep this email: your licence key and download link re-issue on request against reference ' + esc(reference) + '.</p>');
  return {
    subject: 'Your StayChat OS software is ready — licence key inside',
    html,
    text: 'Hi ' + (name || 'there') + ',\n\nPayment confirmed — your StayChat OS Desk PC Edition software:\n\nLicence key: ' + licenseKey +
      '\nOrder reference: ' + reference +
      (downloadUrl ? '\nDownload: ' + downloadUrl : '\nThe platform team will send you the installer package.') +
      '\n\nInstall on your desk PC, paste the licence key when prompted, and it runs on your local network — no internet needed after install.',
  };
}

// ── Hosted one-time checkout (platform gateways) ─────────────────────────────
// Same gate as subscriptions: only when the operator configured a platform
// key in Super Admin → Platform Billing. Stripe (card, mode:payment) and
// Paystack (one-time initialize) are supported; any other configured provider
// simply falls back to the manual reference flow.
async function createStripeCheckout(order, baseUrl) {
  const secret = platformSettings.get('stripe_secret_key');
  const body = new URLSearchParams({
    mode: 'payment',
    'payment_method_types[0]': 'card',
    client_reference_id: order.id,
    customer_email: order.email || '',
    // Landing page reads ?sh_ref= (see the shForm script) and scrolls to the
    // Desk PC card, which carries id="deskpc" — both must match or the returning
    // customer never sees the status panel that triggers delivery.
    success_url: baseUrl + '/?sh_ref=' + order.payment_reference + '#deskpc',
    cancel_url: baseUrl + '/#deskpc',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(Math.round(order.amount * 100)),
    'line_items[0][price_data][product_data][name]': 'StayChat OS — ' + SELFHOST_PLAN.name + ' (one-time)',
    'metadata[type]': 'selfhost',
    'metadata[order_id]': order.id,
  });

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

async function createPaystackCheckout(order, baseUrl) {
  const secret = platformSettings.get('paystack_secret_key');
  const res = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: Math.round(order.amount * 100), // kobo
      email: order.email,
      reference: order.payment_reference, // unique SC- reference — doubles as gateway ref
      callback_url: baseUrl + '/?sh_ref=' + order.payment_reference + '#deskpc',
      metadata: { type: 'selfhost', order_id: order.id, plan: SELFHOST_PLAN.name, hotel: order.hotel_name || '' },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.data?.authorization_url) {
    throw Object.assign(new Error('Paystack checkout failed: ' + (data.message || res.status)), { status: 502 });
  }
  return { url: data.data.authorization_url, sessionId: data.data.access_code, provider: 'paystack' };
}

async function createCheckout(order, req) {
  if (!billing.isAutoPaymentsEnabled()) return null;
  try {
    const base = billing.resolvePlatformBaseUrl(req);
    const checkout = platformSettings.has('stripe_secret_key')
      ? await createStripeCheckout(order, base)
      : platformSettings.has('paystack_secret_key')
        ? await createPaystackCheckout(order, base)
        : null; // other rails (Flutterwave/OPay/…) → manual reference flow
    if (!checkout) return null;
    db.prepare(`UPDATE selfhost_orders SET gateway_ref = ?, payment_method = ?, checkout_url = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(checkout.sessionId, checkout.provider, checkout.url, order.id);
    logEvent('selfhost.checkout_created',
      'Desk PC Edition checkout opened via ' + checkout.provider + ' for ' + order.email,
      order.amount, order.payment_reference);
    return checkout;
  } catch (err) {
    // Gateway outage must never block a registration — manual flow continues.
    console.error('[selfhost] checkout creation failed, falling back to manual flow:', err.message);
    logEvent('selfhost.checkout_failed',
      'Hosted checkout unavailable (' + err.message + ') — manual reference flow continues',
      order.amount, order.payment_reference);
    return null;
  }
}

/**
 * Register a Desk PC Edition order from the landing-page form (public, no
 * account). Re-registration with the same email returns the existing open
 * order instead of stacking duplicates, so a retried form submit is harmless.
 */
async function registerOrder(input, req) {
  ensureSchemaSoft();
  const name = String(input.name || '').trim();
  const emailAddr = String(input.email || '').trim().toLowerCase();
  const hotelName = String(input.hotelName || input.hotel || '').trim();
  const phone = String(input.phone || '').trim() || null;
  const country = String(input.country || '').trim() || null;

  if (!name || name.length > 120) throw Object.assign(new Error('Your name is required'), { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailAddr) || emailAddr.length > 254) {
    throw Object.assign(new Error('A valid email address is required — the software is delivered by email'), { status: 400 });
  }
  if (!hotelName || hotelName.length > 160) throw Object.assign(new Error('Property / hotel name is required'), { status: 400 });

  // One open order per email: a second submit (or a double-click) returns the
  // existing registration with its reference instead of minting another one.
  const existing = db.prepare(
    `SELECT * FROM selfhost_orders WHERE LOWER(email) = ? AND status IN ('pending','paid','delivered') ORDER BY created_at DESC LIMIT 1`
  ).get(emailAddr);
  if (existing) {
    return { order: existing, checkoutUrl: existing.checkout_url || null, reused: true };
  }

  const id = 'sho_' + nanoid(10);
  const ref = makeReference();
  const ip = req ? (req.ip || null) : null;

  db.prepare(`INSERT INTO selfhost_orders (id, payment_reference, name, email, hotel_name, phone, country, amount, status, requested_by_ip)
              VALUES (?,?,?,?,?,?,?,?, 'pending', ?)`)
    .run(id, ref, name, emailAddr, hotelName, phone, country, SELFHOST_PLAN.price, ip);

  let order = db.prepare('SELECT * FROM selfhost_orders WHERE id = ?').get(id);
  const checkout = await createCheckout(order, req);
  order = db.prepare('SELECT * FROM selfhost_orders WHERE id = ?').get(id);

  logEvent('selfhost.registered',
    'Desk PC Edition registered for ' + hotelName + ' (' + emailAddr + ') — one-time $' + SELFHOST_PLAN.price + ' awaiting payment',
    SELFHOST_PLAN.price, ref);
  notifySuperadmins();

  // Confirmation email with the reference (+ card checkout link when we have one).
  email.sendEmail({ to: emailAddr, ...selfhostOrderReceivedEmail({
    name, hotelName, amount: SELFHOST_PLAN.price, paymentReference: ref,
    checkoutUrl: checkout ? checkout.url : null,
  }) }).catch(() => {});

  return { order, checkoutUrl: checkout ? checkout.url : null, reused: false };
}

function findByGatewayRef(gatewayRef) {
  if (!gatewayRef) return null;
  const g = String(gatewayRef);
  return db.prepare(
    `SELECT * FROM selfhost_orders
     WHERE id = ? OR gateway_ref = ? OR payment_reference = ?
     ORDER BY (id = ?) DESC, created_at DESC LIMIT 1`
  ).get(g, g, g, g) || null;
}

// ── Verify-on-return ─────────────────────────────────────────────────────────
// Instead of editing the platform's webhook handlers, this module asks the
// GATEWAY ITSELF (server-to-server, secret key held in platform settings)
// whether the stored checkout session actually succeeded. Throttled per order
// so the landing page's status poll can't turn into an API hammer.
const lastGatewayCheck = new Map();
const CHECK_THROTTLE_MS = 8000;

async function verifyGatewayPayment(order) {
  if (!order || order.status !== 'pending') return order;
  if (!order.payment_method || !['stripe', 'paystack'].includes(order.payment_method)) return order;

  const now = Date.now();
  const last = lastGatewayCheck.get(order.id) || 0;
  if (now - last < CHECK_THROTTLE_MS) return order;
  lastGatewayCheck.set(order.id, now);

  try {
    if (order.payment_method === 'stripe' && order.gateway_ref) {
      const secret = platformSettings.get('stripe_secret_key');
      if (!secret) return order;
      const res = await fetch('https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(order.gateway_ref), {
        headers: { Authorization: 'Bearer ' + secret },
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.payment_status === 'paid') {
        const { order: confirmed } = await confirmPayment('stripe', order.gateway_ref, {
          approvedBy: 'verify:stripe',
          amount: (data.amount_total || 0) / 100,
        });
        return confirmed || order;
      }
    } else if (order.payment_method === 'paystack') {
      const secret = platformSettings.get('paystack_secret_key');
      if (!secret) return order;
      const res = await fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(order.payment_reference), {
        headers: { Authorization: 'Bearer ' + secret },
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      const tx = data && data.data;
      if (res.ok && data.status && tx && tx.status === 'success') {
        const { order: confirmed } = await confirmPayment('paystack', tx.reference || order.payment_reference, {
          approvedBy: 'verify:paystack',
          amount: (tx.amount || 0) / 100, // kobo → dollars
        });
        return confirmed || order;
      }
    }
  } catch (err) {
    // Gateway unreachable → keep showing "pending"; never fail the status poll.
    console.warn('[selfhost] gateway verification skipped:', err.message);
  }
  return db.prepare('SELECT * FROM selfhost_orders WHERE id = ?').get(order.id) || order;
}

/**
 * Confirm payment and deliver the software. Returns { matched, order }:
 *   matched=false → some other system's reference (caller decides fallback)
 *   matched=true  → this IS a Desk PC Edition reference; order carries the
 *                   resulting state (idempotent on gateway replays)
 */
async function confirmPayment(provider, gatewayRef, opts = {}) {
  ensureSchemaSoft();
  const order = findByGatewayRef(gatewayRef);
  if (!order) return { matched: false, order: null };

  // Replay after success → no-op (still returns the order for the caller).
  if (order.status === 'paid' || order.status === 'delivered') return { matched: true, order };

  const due = Math.round(order.amount * 100);
  const paid = opts.amount != null && opts.amount > 0 ? Math.round(opts.amount * 100) : null;
  if (paid !== null && paid < due) {
    logEvent('selfhost.underpaid',
      provider + ' event amount ' + opts.amount + ' < due ' + order.amount + ' — NOT delivered, operator review needed',
      opts.amount, order.payment_reference);
    return { matched: true, order: db.prepare('SELECT * FROM selfhost_orders WHERE id = ?').get(order.id) };
  }

  db.prepare(`UPDATE selfhost_orders
              SET status = 'paid', paid_at = datetime('now'), approved_by = ?,
                  gateway_ref = COALESCE(NULLIF(?, ''), gateway_ref), payment_method = COALESCE(NULLIF(?, ''), payment_method)
              WHERE id = ?`)
    .run(opts.approvedBy || provider || 'manual', String(gatewayRef || ''), String(provider || ''), order.id);

  const fresh = db.prepare('SELECT * FROM selfhost_orders WHERE id = ?').get(order.id);
  logEvent('selfhost.paid',
    'Payment confirmed for Desk PC Edition (' + fresh.email + ') via ' + (opts.approvedBy || provider),
    fresh.amount, fresh.payment_reference);

  // Now the actual hand-off: licence key + emailed software.
  const delivered = await deliver(fresh, { approvedBy: opts.approvedBy || provider });
  return { matched: true, order: delivered };
}

/**
 * Generate the licence + email the customer their software. Safe to call
 * again for a resend — it reuses the SAME licence key and download token, and
 * only the (explicit) caller triggers another email.
 */
async function deliver(orderIn, opts = {}) {
  ensureSchemaSoft();
  const licenseKey = orderIn.license_key || makeLicenseKey();
  const downloadToken = orderIn.download_token || crypto.randomBytes(24).toString('hex');
  if (!orderIn.license_key || !orderIn.download_token) {
    db.prepare(`UPDATE selfhost_orders SET license_key = ?, download_token = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(licenseKey, downloadToken, orderIn.id);
  }
  const order = db.prepare('SELECT * FROM selfhost_orders WHERE id = ?').get(orderIn.id);

  db.prepare(`UPDATE selfhost_orders
              SET status = 'delivered',
                  delivered_at = COALESCE(delivered_at, datetime('now')),
                  updated_at = datetime('now')
              WHERE id = ?`).run(order.id);
  logEvent('selfhost.delivered',
    'StayChat OS Desk PC Edition (licence ' + licenseKey + ') emailed to ' + order.email +
    (opts.approvedBy ? ' — confirmed by ' + opts.approvedBy : ''),
    order.amount, order.payment_reference);

  await resendToCustomer(order);
  return db.prepare('SELECT * FROM selfhost_orders WHERE id = ?').get(order.id);
}

/** Email the software (licence key + download link) to the customer. */
async function resendToCustomer(order) {
  return email.sendEmail({ to: order.email, ...selfhostDeliveredEmail({
    name: order.name,
    hotelName: order.hotel_name,
    reference: order.payment_reference,
    licenseKey: order.license_key || '(issuing now)',
    downloadUrl: downloadUrlFor(order),
    version: process.env.APP_VERSION || null,
  }) });
}

// Operator approval path (manual bank transfer / POS / offline card): mark
// paid AND deliver in one action. Accepts id or SC- reference.
async function confirmAndDeliver(refOrId, opts = {}) {
  ensureSchemaSoft();
  const row = db.prepare(
    'SELECT * FROM selfhost_orders WHERE id = ? OR payment_reference = ?'
  ).get(String(refOrId), String(refOrId));
  if (!row) throw Object.assign(new Error('Order not found'), { status: 404 });
  if (row.status === 'cancelled') throw Object.assign(new Error('This order was cancelled'), { status: 409 });
  if (row.status === 'delivered') return row; // already done — idempotent
  const { order } = await confirmPayment('manual', row.payment_reference, {
    approvedBy: opts.approvedBy || 'superadmin',
    amount: opts.amount != null ? opts.amount : row.amount,
  });
  return order;
}

/** Public status for the landing-page poll (no PII beyond the ref itself). */
async function getStatus(ref) {
  ensureSchemaSoft();
  let order = db.prepare('SELECT * FROM selfhost_orders WHERE payment_reference = ?').get(String(ref || ''));
  if (!order) return null;
  // Coming back from a card checkout? Ask the gateway whether it actually
  // succeeded → this is what flips the order to paid and mails the software.
  order = await verifyGatewayPayment(order);
  return publicView(order);
}

function listOrders(status) {
  ensureSchemaSoft();
  return status
    ? db.prepare('SELECT * FROM selfhost_orders WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status)
    : db.prepare('SELECT * FROM selfhost_orders ORDER BY created_at DESC LIMIT 200').all();
}

function countPending() {
  ensureSchemaSoft();
  return db.prepare(`SELECT COUNT(*) c FROM selfhost_orders WHERE status = 'pending'`).get().c;
}

module.exports = {
  SELFHOST_PLAN,
  ensureSchema,
  packagePath,
  packageAvailable,
  downloadUrlFor,
  registerOrder,
  confirmPayment,
  confirmAndDeliver,
  verifyGatewayPayment,
  deliver,
  resendToCustomer,
  getStatus,
  listOrders,
  countPending,
  publicView,
  findByGatewayRef,
  makeReference,
  makeLicenseKey,
};