#!/usr/bin/env node
// scripts/test-korapay.js — Korapay (Kora) money-path regression battery.
//
// Phase A (in-process, fetch stubbed — no network calls):
//   • auto-payments gate counts Korapay ONLY when BOTH public + secret keys exist
//   • hosted checkout posts exactly the documented initialize payload:
//     POST /merchant/api/v1/charges/initialize, Bearer <PUBLIC key>,
//     amount in MAJOR units (never ×100), the SC- reference, and
//     notification_url → /api/webhooks/platform/korapay
//
// Phase B (spawned server against a throwaway DB copy):
//   • superadmin settings API: allowed-keys gate, secrets masked (never echoed),
//     korapay webhook URL listed, autoPaymentsEnabled flips on
//   • hotel admin cannot write platform keys (role gate)
//   • webhook: missing / forged / wrong-scope signatures → 403 (fail closed)
//   • both valid signature candidates (raw on-wire bytes of `data`, and the
//     re-serialized `data` object) → 200
//   • activation: right ref + amount + USD → subscription active;
//     wrong currency (NGN) → never; underpay → never (billing event logged);
//     replay of an already-activated ref → still 200, stays active
//
// Usage: node scripts/test-korapay.js    (also part of `npm test`)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.KORA_TEST_PORT) || 4427;
const BASE = 'http://localhost:' + PORT;

const PUB_KEY = 'pk_live_koraProbePublic123456';
const SEC_KEY = 'sk_live_koraProbeSecret123456';
const SA_EMAIL = 'kora-probe@staychat.test';
const SA_PASSWORD = 'KoraProbe!2026x';

let srv = null;
let dataDir = null;
let serverLog = '';
let passed = 0, failed = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ✓ ' : '  ✗ FAIL: ') + label + (cond || !detail ? '' : ' — ' + detail));
  cond ? passed++ : failed++;
}
function cleanup() {
  if (srv) { try { srv.kill('SIGKILL'); } catch (e) {} srv = null; }
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} dataDir = null; }
}
async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('server never became healthy. Server log:\n' + serverLog.slice(-3000));
}
async function login(email, password) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.accessToken) throw new Error('login failed for ' + email + ' → HTTP ' + r.status + ' ' + JSON.stringify(d));
  return d.accessToken;
}
async function req(method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}
const hmac = input => crypto.createHmac('sha256', SEC_KEY).update(input).digest('hex');
async function postWebhook(bodyStr, headers) {
  const r = await fetch(BASE + '/api/webhooks/platform/korapay', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: bodyStr,
  });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
}

(async () => {
  // ── Throwaway DB copy ──────────────────────────────────────────────────────
  dataDir = fs.mkdtempSync('/tmp/staychat-kora.');
  fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db'), path.join(dataDir, 'staychat.db'));
  for (const ext of ['-wal', '-shm']) {
    const src = path.join(ROOT, 'data', 'staychat.db' + ext);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dataDir, 'staychat.db' + ext));
  }

  // Load .env the same way server/index.js does so both processes derive the
  // same CREDENTIALS_ENCRYPTION_KEY (settings written here must decrypt there).
  try { require('dotenv').config({ path: path.join(ROOT, '.env') }); } catch (e) { /* optional */ }
  process.env.DATA_DIR = dataDir; // before any server module opens the DB
  delete process.env.PLATFORM_GATEWAY; // phase A pins nothing — precedence must be Korapay

  const Database = require('better-sqlite3');
  const bcrypt = require('bcryptjs');
  const { nanoid } = require('nanoid');
  const raw = new Database(path.join(dataDir, 'staychat.db'));
  raw.pragma('journal_mode = WAL');

  // Superadmin login for phase B.
  raw.prepare('DELETE FROM users WHERE email = ?').run(SA_EMAIL);
  raw.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, avatar, active)
               VALUES (?, NULL, 'Kora Probe', ?, ?, 'superadmin', 'KP', 1)`)
    .run('user_' + nanoid(14), SA_EMAIL, bcrypt.hashSync(SA_PASSWORD, 12));
  const noTenants = raw.prepare('SELECT COUNT(*) c FROM tenants').get().c;
  raw.close();
  if (!noTenants) throw new Error('scratch DB has no tenants — seed data/staychat.db first');

  // ── Phase A: checkout payload (fetch stubbed) ──────────────────────────────
  console.log('── Phase A: hosted checkout payload (offline) ──');
  const billing = require(path.join(ROOT, 'server', 'services', 'billing'));
  const platformSettings = require(path.join(ROOT, 'server', 'services', 'platform-settings'));

  // Deterministic gate: clear every other platform gateway key in the copy so
  // provider precedence can't hide behind a key left over in dev data.
  for (const k of ['stripe_secret_key', 'stripe_webhook_secret', 'paystack_secret_key',
    'flutterwave_secret_key', 'flutterwave_public_key', 'flutterwave_webhook_secret',
    'opay_secret_key', 'payoneer_client_secret', 'airtm_api_token', 'crypto_webhook_secret']) {
    platformSettings.set(k, null);
  }
  platformSettings.set('korapay_public_key', null);
  platformSettings.set('korapay_secret_key', null);
  check('no keys → auto-payments off', billing.isAutoPaymentsEnabled() === false);
  platformSettings.set('korapay_public_key', PUB_KEY);
  check('public key ALONE → still off (both keys required)', billing.isAutoPaymentsEnabled() === false);
  platformSettings.set('korapay_secret_key', SEC_KEY);
  check('public + secret → auto-payments on', billing.isAutoPaymentsEnabled() === true);

  const dbConn = require(path.join(ROOT, 'server', 'db', 'connection'));
  const tenantFull = dbConn.prepare('SELECT * FROM tenants ORDER BY created_at ASC LIMIT 1').get();

  const realFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url: String(url), opts };
    return { ok: true, status: 200, json: async () => ({ status: true, message: 'ok', data: { reference: 'x', checkout_url: 'https://checkout.korapay.com/session/abc' } }) };
  };
  let result = null, thrown = null;
  try {
    result = await billing.createCheckoutSession(tenantFull, 'starter', 'monthly', null);
  } catch (e) { thrown = e; }
  global.fetch = realFetch;

  check('checkout threw no error', !thrown, thrown && thrown.stack);
  check('provider is korapay', !!result && result.provider === 'korapay', JSON.stringify(result && { provider: result.provider, checkoutUrl: result.checkoutUrl }));
  check('hosted checkout URL returned', !!result && result.checkoutUrl === 'https://checkout.korapay.com/session/abc');
  check('marked auto-approve (webhook settles it)', !!result && result.autoApprove === true);
  if (captured) {
    check('initialize endpoint', captured.url === 'https://api.korapay.com/merchant/api/v1/charges/initialize', captured.url);
    check('authenticated with the PUBLIC key', captured.opts.headers.Authorization === 'Bearer ' + PUB_KEY, captured.opts.headers.Authorization);
    let sent = null;
    try { sent = JSON.parse(captured.opts.body); } catch (e) {}
    check('payload parses as JSON', !!sent, captured.opts.body);
    if (sent && result) {
      check('amount in MAJOR units (=== subscription amount, not ×100)',
        sent.amount === result.amount && sent.amount === 29, 'sent=' + sent.amount + ' due=' + result.amount);
      check('currency USD', sent.currency === 'USD', sent.currency);
      check('reference is the SC- payment reference', sent.reference === result.paymentReference, sent.reference + ' vs ' + result.paymentReference);
      check('redirect_url targets /pay?ref=', String(sent.redirect_url).includes('/pay?ref=' + result.paymentReference), sent.redirect_url);
      check('notification_url → platform korapay webhook', String(sent.notification_url).endsWith('/api/webhooks/platform/korapay'), sent.notification_url);
      check('customer email present', !!(sent.customer && sent.customer.email), JSON.stringify(sent.customer));
      check('narration names the plan', String(sent.narration).includes('Starter'), sent.narration);
    }
  } else {
    check('fetch was called at least once', false, 'captured=null');
  }

  // Webhook fixtures are inserted AFTER phase A because requestPlan (called
  // above) replaces that tenant's own previous pending request — inserting
  // first would clobber them. plan_id must be a real PLAN_CATALOG key.
  const tenantRow = { id: tenantFull.id };
  const raw2 = new Database(path.join(dataDir, 'staychat.db'));
  const insSub = raw2.prepare(`INSERT INTO platform_subscriptions
      (id, tenant_id, plan_id, billing_cycle, amount, status, payment_reference, payment_method)
      VALUES (?,?,?,?,?,?,?,?)`);
  insSub.run('sub_kora_act', tenantRow.id, 'starter', 'monthly', 29, 'pending_approval', 'SC-KORA-ACT', 'korapay');
  insSub.run('sub_kora_ngn', tenantRow.id, 'starter', 'monthly', 29, 'pending_approval', 'SC-KORA-NGN', 'korapay');
  insSub.run('sub_kora_under', tenantRow.id, 'starter', 'monthly', 29, 'pending_approval', 'SC-KORA-UNDER', 'korapay');
  raw2.close();

  // Release the parent's DB handle before the spawned server takes over.
  try { dbConn.close(); } catch (e) {}

  // ── Phase B: spawned server ────────────────────────────────────────────────
  console.log('\n── Phase B: settings API + webhook rules (spawned server) ──');
  srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', d => { serverLog += d; });
  srv.stderr.on('data', d => { serverLog += d; });
  await waitForHealth();

  const sa = await login(SA_EMAIL, SA_PASSWORD);

  const pb = await req('GET', '/api/superadmin/platform-billing', sa);
  check('GET platform-billing → 200', pb.status === 200, 'got ' + pb.status);
  check('korapay public key visible (masked)', pb.data && pb.data.settings && pb.data.settings.korapay_public_key && pb.data.settings.korapay_public_key.set === true);
  check('korapay secret key visible (masked)', pb.data && pb.data.settings.korapay_secret_key && pb.data.settings.korapay_secret_key.set === true);
  check('autoPaymentsEnabled true', pb.data && pb.data.autoPaymentsEnabled === true);
  check('korapay webhook URL listed', !!(pb.data && pb.data.webhookUrls && /\/api\/webhooks\/platform\/korapay$/.test(pb.data.webhookUrls.korapay)), JSON.stringify(pb.data && pb.data.webhookUrls));
  const pbDump = JSON.stringify(pb.data);
  check('neither key leaks in full', pbDump.indexOf(SEC_KEY) === -1 && pbDump.indexOf(PUB_KEY) === -1);
  const hint = pb.data.settings.korapay_secret_key.hint || '';
  check('secret rendered as hint (sk_…xxxx)', /^sk_…/.test(hint) && hint.length < 20, hint);

  const badKey = await req('PUT', '/api/superadmin/platform-billing', sa, { evil_key: 'x' });
  check('unknown setting rejected → 400', badKey.status === 400, 'got ' + badKey.status);
  const put = await req('PUT', '/api/superadmin/platform-billing', sa, { korapay_public_key: PUB_KEY, korapay_secret_key: SEC_KEY });
  check('PUT korapay keys → 200', put.status === 200 && JSON.stringify(put.data.updated) === JSON.stringify(['korapay_public_key', 'korapay_secret_key']), JSON.stringify(put.data));
  check('PUT response masks the secret too', JSON.stringify(put.data).indexOf(SEC_KEY) === -1);

  let hotelTok = null;
  try { hotelTok = await login('admin@hospitally.com', 'Demo@123456'); } catch (e) {}
  if (hotelTok) {
    const forbidden = await req('PUT', '/api/superadmin/platform-billing', hotelTok, { korapay_secret_key: 'sk_evil' });
    check('hotel admin cannot write platform keys → 401/403', forbidden.status === 401 || forbidden.status === 403, 'got ' + forbidden.status);
  } else {
    check('hotel admin login for role-gate probe', false, 'admin@hospitally.com unavailable');
  }

  // Webhook signature rules.
  const dataAct = JSON.stringify({ reference: 'SC-KORA-ACT', amount: 29, currency: 'USD', status: 'success' });
  const bodyAct = '{"event":"charge.success","data":' + dataAct + '}';

  const noSig = await postWebhook(bodyAct);
  check('no signature → 403', noSig.status === 403, 'got ' + noSig.status);
  const forged = await postWebhook(bodyAct, { 'x-korapay-signature': 'deadbeef' });
  check('forged signature → 403', forged.status === 403, 'got ' + forged.status);
  const wrongScope = await postWebhook(bodyAct, { 'x-korapay-signature': hmac(bodyAct) });
  check('signature over WHOLE body (wrong scope) → 403', wrongScope.status === 403, 'got ' + wrongScope.status);

  const dataUnknown = JSON.stringify({ reference: 'SC-KORA-NOPE', amount: 29, currency: 'USD', status: 'success' });
  const unknown = await postWebhook('{"event":"charge.success","data":' + dataUnknown + '}', { 'x-korapay-signature': hmac(dataUnknown) });
  check('valid raw-bytes signature (unknown ref) → 200', unknown.status === 200, 'got ' + unknown.status + ' ' + JSON.stringify(unknown.data));

  // Re-serialized candidate: raw carries float 29000.00, JSON round-trip → 29000,
  // so the HMAC only matches if the handler accepts the re-serialized object.
  const rawNgn = '{"reference":"SC-KORA-NGN","amount":29000.00,"currency":"NGN","status":"success"}';
  const reNgn = JSON.stringify(JSON.parse(rawNgn));
  check('test fixture: raw and re-serialized differ', reNgn !== rawNgn, rawNgn + ' vs ' + reNgn);
  const ngn = await postWebhook('{"event":"charge.success","data":' + rawNgn + '}', { 'x-korapay-signature': hmac(reNgn) });
  check('valid RE-serialized signature → 200', ngn.status === 200, 'got ' + ngn.status + ' ' + JSON.stringify(ngn.data));

  // Activation: right ref + amount + USD.
  const act = await postWebhook(bodyAct, { 'x-korapay-signature': hmac(dataAct) });
  check('charge.success with raw-bytes signature → 200', act.status === 200, 'got ' + act.status);
  const replay = await postWebhook(bodyAct, { 'x-korapay-signature': hmac(dataAct) });
  check('replay of activated ref → 200 (idempotent)', replay.status === 200, 'got ' + replay.status);

  // Underpay: signed but amount < due → never activates.
  const dataUnder = JSON.stringify({ reference: 'SC-KORA-UNDER', amount: 10, currency: 'USD', status: 'success' });
  const under = await postWebhook('{"event":"charge.success","data":' + dataUnder + '}', { 'x-korapay-signature': hmac(dataUnder) });
  check('underpaid charge → 200 ack', under.status === 200, 'got ' + under.status);

  // Give the (already synchronous) handlers a beat, then read back state.
  await new Promise(r => setTimeout(r, 300));
  const subs = await req('GET', '/api/superadmin/subscriptions', sa);
  const byRef = ref => (subs.data || []).find(s => s.payment_reference === ref);
  const actSub = byRef('SC-KORA-ACT');
  check('USD full payment → subscription ACTIVE', actSub && actSub.status === 'active', JSON.stringify(actSub && actSub.status));
  check('activated via gateway (auto:korapay)', actSub && String(actSub.approved_by || '').startsWith('auto:korapay'), JSON.stringify(actSub && actSub.approved_by));
  const ngnSub = byRef('SC-KORA-NGN');
  check('NGN settlement → NOT activated (operator review)', ngnSub && ngnSub.status === 'pending_approval', JSON.stringify(ngnSub && ngnSub.status));
  const underSub = byRef('SC-KORA-UNDER');
  check('underpay → NOT activated', underSub && underSub.status === 'pending_approval', JSON.stringify(underSub && underSub.status));

  const events = await req('GET', '/api/superadmin/billing-events', sa);
  const underEvt = (events.data || []).find(e => e.payment_reference === 'SC-KORA-UNDER' && e.type === 'payment.underpaid');
  check('underpay logged as payment.underpaid for reconciliation', !!underEvt, JSON.stringify(underEvt));

  // Tenant actually flipped live.
  const tenants = await req('GET', '/api/superadmin/tenants', sa);
  const t = (tenants.data || []).find(x => x.id === tenantRow.id);
  check('tenant subscription_status now active', t && t.subscriptionStatus === 'active', JSON.stringify(t && t.subscriptionStatus));

  console.log('\n═══ KORAPAY TESTS: ' + passed + ' passed, ' + failed + ' failed ═══');
  if (failed) console.log('── server log tail ──\n' + serverLog.slice(-3000));
  cleanup();
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('KORA TEST CRASH:', err);
  if (serverLog) console.error('── server log tail ──\n' + serverLog.slice(-3000));
  cleanup();
  process.exit(1);
});
