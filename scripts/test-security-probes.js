#!/usr/bin/env node
// scripts/test-security-probes.js — adversarial probes against a throwaway server.
// Verifies:
//   1. No data router serves unauthenticated requests (whitelist for intentional public surfaces)
//   2. Cross-tenant isolation: tenant A cannot read or mutate tenant B's records
//   3. SQL-injection payloads in bodies and path params never corrupt data or 500
//   4. Session cookies carry httpOnly + SameSite=Strict + Secure (in production mode)
//
// Usage: node scripts/test-security-probes.js   (spawns its own server, DB copy)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 4425;
const BASE = 'http://localhost:' + PORT;
let srv = null;
let dataDir = null;
let passed = 0, failed = 0;
function check(label, cond, detail) {
  console.log((cond ? '  ✓ ' : '  ✗ FAIL: ') + label + (cond || !detail ? '' : ' — ' + detail));
  cond ? passed++ : failed++;
}

async function waitForHealth() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch (e) {}
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error('server never became healthy');
}

async function login(email, password) {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: password || 'Demo@123456' }),
  });
  const d = await r.json();
  if (!d.accessToken) throw new Error('login failed for ' + email);
  return d.accessToken;
}

async function req(method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch (e) {}
  return { status: r.status, data, headers: r.headers };
}

(async () => {
  dataDir = fs.mkdtempSync('/tmp/staychat-secprobe.');
  fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db'), path.join(dataDir, 'staychat.db'));
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(path.join(ROOT, 'data', 'staychat.db' + ext))) fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db' + ext), path.join(dataDir, 'staychat.db' + ext));
  }
  srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production' }),
    stdio: 'ignore',
  });
  await waitForHealth();

  // ── 1. Unauthenticated access sweep ──────────────────────────────────────
  console.log('\n── Unauthenticated access sweep ──');
  // Intentional public surfaces (no auth by design): health, auth flows, help/FAQ,
  // landing chat assistant, WhatsApp webhook (signature-gated), booking-engine
  // public config + wifi guest self-service lookup.
  const publicRouters = new Set(['health', 'auth', 'help', 'chat', 'webhooks', 'booking-engine', 'wifi']);
  const dataRouters = ['rooms', 'room-setup', 'bookings', 'pool', 'halls', 'guests', 'orders', 'pos',
    'accounting', 'eod', 'misc-services', 'ai-config', 'printers', 'plans', 'reports',
    'staff', 'shifts', 'users', 'menu', 'maintenance', 'inbox', 'payments', 'analytics', 'settings',
    'api-integrations', 'superadmin'];
  for (const router of dataRouters) {
    const { status } = await req('GET', '/api/' + router);
    check('GET /api/' + router + ' → 401 unauthenticated', status === 401, 'got ' + status);
  }
  // /api/billing root has no GET (404 is correct); its data sub-routes must still gate
  const billingState = await req('GET', '/api/billing/state');
  check('GET /api/billing/state → 401 unauthenticated', billingState.status === 401, 'got ' + billingState.status);
  const billingPricing = await req('GET', '/api/billing/pricing');
  check('GET /api/billing/pricing public by design (200)', billingPricing.status === 200, 'got ' + billingPricing.status);
  // chat is POST-only (public landing assistant); GET / → 404 is correct
  const chatPost = await req('POST', '/api/chat', null, { message: 'hello' });
  check('POST /api/chat reachable (public by design)', chatPost.status !== 404 && chatPost.status !== 401, 'got ' + chatPost.status);
  const chatSug = await req('GET', '/api/chat/suggestions');
  check('GET /api/chat/suggestions public (200)', chatSug.status === 200, 'got ' + chatSug.status);
  void publicRouters;

  // ── 2. Cross-tenant isolation ────────────────────────────────────────────
  console.log('\n── Cross-tenant isolation (Hospitally vs provisioned hotel) ──');
  const t1 = await login('admin@hospitally.com');
  const sa = await login('superadmin@staychat.io');

  // Provision an isolated tenant B through the real platform API (like a real signup)
  const stamp = Date.now().toString(36);
  const created = await req('POST', '/api/superadmin/tenants', sa, {
    name: 'Isolation Probe Hotel ' + stamp, plan: 'starter',
    email: 'probe-' + stamp + '@isolation.test', country: 'Testland',
  });
  check('tenant B provisioned via superadmin API', created.status === 201 && created.data && created.data.tempPassword, 'got ' + created.status);
  const t2 = await login(created.data.adminEmail, created.data.tempPassword);

  // Give tenant B real resources so cross-tenant probes have actual targets
  const mkRoom = await req('POST', '/api/rooms', t2, { number: 'P-' + stamp, rate: 10 });
  check('tenant B room created', mkRoom.status === 201, 'got ' + mkRoom.status);
  const t2Rooms = [{ id: mkRoom.data.id }];
  const mkConv = await req('POST', '/api/inbox/conversations', t2, { guestName: 'Probe Guest', guestPhone: '+000 000 0000' });
  check('tenant B conversation created (admin has inbox.use)', mkConv.status === 201, 'got ' + mkConv.status);
  const mkGuest = await req('POST', '/api/guests', t2, { name: 'Probe Guest B', phone: '+000 000 0001' });
  check('tenant B guest created (admin has guests.manage)', mkGuest.status === 201, 'got ' + mkGuest.status);
  const room2 = t2Rooms[0] && t2Rooms[0].id;
  const conv2 = mkConv.data && mkConv.data.id;
  const guest2 = mkGuest.data && mkGuest.data.id;

  // Tenant 1 must NOT see tenant 2's data
  const t1Rooms = (await req('GET', '/api/rooms', t1)).data || [];
  check('t1 room list contains no t2 rooms', !!room2 && !t1Rooms.some(r => r.id === room2));
  const t1Convs = (await req('GET', '/api/inbox/conversations', t1)).data || [];
  check('t1 inbox contains no t2 conversations', !!conv2 && !t1Convs.some(c => c.id === conv2));
  const t1Guests = (await req('GET', '/api/guests', t1)).data || [];
  check('t1 guest list contains no t2 guests', !!guest2 && !t1Guests.some(g => g.id === guest2));

  // Tenant 1 must NOT be able to fetch/mutate tenant 2's records by id
  const g1 = await req('GET', '/api/inbox/conversations/' + conv2, t1);
  check('t1 GET t2 conversation by id → 404', g1.status === 404, 'got ' + g1.status);
  const p1 = await req('PATCH', '/api/rooms/' + room2, t1, { status: 'cleaning' });
  check('t1 PATCH t2 room → 404', p1.status === 404, 'got ' + p1.status);
  const p3 = await req('PATCH', '/api/guests/' + guest2, t1, { name: 'HACKED' });
  check('t1 PATCH t2 guest → 404 (no cross-tenant mutation)', p3.status === 404, 'got ' + p3.status);
  const p5 = await req('POST', '/api/inbox/conversations/' + conv2 + '/messages', t1, { body: 'intrusion' });
  check('t1 POST message into t2 conversation → 404', p5.status === 404, 'got ' + p5.status);
  // settings must always reflect the caller's own tenant
  const s1 = (await req('GET', '/api/settings', t1)).data || {};
  const s2 = (await req('GET', '/api/settings', t2)).data || {};
  check('t1 settings return t1 hotel', s1.name === 'Hospitally Grand Resort', 'got ' + s1.name);
  check('t2 settings return its own hotel', !!s2.name && s2.name !== 'Hospitally Grand Resort', 'got ' + s2.name);

  // ── 3. SQL-injection probes ──────────────────────────────────────────────
  console.log('\n── SQL-injection probes ──');
  const sqliName = "Robert'); DROP TABLE guests;--";
  const guestsBefore = ((await req('GET', '/api/guests', t1)).data || []).length;
  const inj = await req('POST', '/api/guests', t1, { name: sqliName, phone: '+234 800 000 0001' });
  check('sqli guest creation accepted as inert data (201)', inj.status === 201, 'got ' + inj.status);
  const guestsAfter = (await req('GET', '/api/guests', t1)).data || [];
  check('guests table intact: exactly +1 row (nothing dropped/wiped)', Array.isArray(guestsAfter) && guestsAfter.length === guestsBefore + 1, 'before ' + guestsBefore + ', after ' + guestsAfter.length);
  check('payload stored as plain data exactly once', guestsAfter.filter(g => g.name === sqliName).length === 1);
  if (inj.status === 201 && inj.data && inj.data.id) {
    const del = await req('DELETE', '/api/guests/' + inj.data.id, t1);
    check('cleanup: injected guest deleted', del.status === 200 || del.status === 204 || del.status === 404, 'got ' + del.status);
  }
  // path-parameter injection must 404 (or 400), never 500 or leak rows
  const pathInj = await req('GET', "/api/inbox/conversations/x'%20OR%20'1'='1", t1);
  check('sqli in path param → 4xx, not 500', pathInj.status >= 400 && pathInj.status < 500, 'got ' + pathInj.status);

  // ── 4. Session cookie flags ──────────────────────────────────────────────
  console.log('\n── Session cookie flags (production mode) ──');
  const lr = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@hospitally.com', password: 'Demo@123456' }),
  });
  const setCookies = (lr.headers.getSetCookie ? lr.headers.getSetCookie() : [lr.headers.get('set-cookie')]).filter(Boolean);
  const access = setCookies.find(c => c.startsWith('access_token='));
  const refresh = setCookies.find(c => c.startsWith('refresh_token='));
  check('login sets access_token cookie', !!access);
  check('login sets refresh_token cookie', !!refresh);
  if (access) {
    check('access_token httpOnly', /httponly/i.test(access));
    check('access_token SameSite=Strict', /samesite=strict/i.test(access));
    check('access_token Secure (production)', /secure/i.test(access));
  }
  if (refresh) {
    check('refresh_token httpOnly', /httponly/i.test(refresh));
    check('refresh_token SameSite=Strict', /samesite=strict/i.test(refresh));
  }

  console.log('\n═══ SECURITY PROBES: ' + passed + ' passed, ' + failed + ' failed ═══');
  srv && srv.kill('SIGKILL');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('PROBE CRASH:', err);
  srv && srv.kill('SIGKILL');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(1);
});
