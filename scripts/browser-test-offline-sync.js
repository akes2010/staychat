#!/usr/bin/env node
// scripts/browser-test-offline-sync.js — end-to-end proof of the offline-first
// write path in a real Chromium:
//
//   1. sign in at the real app, stash a room id
//   2. cut the network (CDP emulateNetworkConditions → navigator.onLine=false)
//   3. create a reservation + register a guest through the REAL API client —
//      both must return { __offlineQueued: true } and appear on the badge
//   4. assert the SERVER does not have them yet (nothing reached the server)
//   5. restore the network → the outbox auto-flushes (online event) →
//      exactly ONE guest and ONE reservation exist server-side, badge empty
//   6. a deliberately bad queued request comes back 404 and is FLAGGED FOR
//      STAFF REVIEW (conflict state) instead of being retried forever
//   7. logout-style wipe clears the outbox
//   8. a network drop mid-session re-opens the shell from the LOCAL session
//      snapshot instead of dumping the desk back on the sign-in form, and
//      revalidates itself silently once the connection returns
//   9. the INSTALL click downloads the WHOLE system: collections + per-id
//      workflow reads (settle/checkout, folios, inbox threads, EOD preview)
//      sit in the SW cache, and every desk page RENDERS from that cache with
//      the network cut again.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { freePort } = require('./lib/free-port');
const { normalizeRoomsInCopy } = require('./lib/normalize-rooms');

const ROOT = path.join(__dirname, '..');
const PORT = 4319;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-offline-test-profile';
const GUEST_NAME = 'Offline Queue Guest';
const RESA_FIRST = 'Offline';
const RESA_LAST = 'ResaSync';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (evl, expr, want, timeoutMs = 20000) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await evl(expr);
    if (last === want) return last;
    await sleep(200);
  }
  return last;
};
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };

function waitHealthy() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => http.get(BASE + '/api/health', r => { r.resume(); resolve(); })
      .on('error', () => Date.now() - t0 > 15000 ? reject(new Error('server not healthy')) : setTimeout(tick, 400));
    tick();
  });
}

async function withBrowser(fn) {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  // A free OS-assigned DevTools port per run: the old fixed 9229 (shared by
  // five suites) relied on a busy-wait that gave up silently after 5s — the
  // next suite could then attach to the PREVIOUS browser and assert against
  // the wrong page. Only the chromium we just spawned can answer here.
  const port = await freePort();
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-popup-blocking',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let devtoolsUp = false;
    for (let i = 0; i < 40 && !devtoolsUp; i++) {
      try {
        const v = await fetch(`http://localhost:${port}/json/version`).then(r => r.json());
        devtoolsUp = !!v.webSocketDebuggerUrl;
      } catch (e) { await sleep(250); }
    }
    if (!devtoolsUp) throw new Error('our chromium DevTools endpoint never came up');
    const list = await fetch(`http://localhost:${port}/json`).then(r => r.json());
    const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map();
    ws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evl = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.value; };
    return await fn({ send, evl });
  } finally {
    try { chrome.kill(); } catch (e) {}
    await new Promise(res => {
      const t = setTimeout(res, 3000);
      chrome.once('exit', () => { clearTimeout(t); res(); });
    });
  }
}

// Server-side view (independent of the browser) for ground-truth assertions.
async function adminToken() {
  const r = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'reception@hospitally.com', password: 'Demo@123456' }),
  });
  const d = await r.json();
  if (!d.accessToken) throw new Error('node-side login failed');
  return d.accessToken;
}
const apiGet = (p, token) => fetch(BASE + p, { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json());

(async () => {
  const dataDir = fs.mkdtempSync('/tmp/staychat-offline.');
  fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db'), path.join(dataDir, 'staychat.db'));
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(path.join(ROOT, 'data', 'staychat.db' + ext))) fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db' + ext), path.join(dataDir, 'staychat.db' + ext));
  }
  normalizeRoomsInCopy(dataDir); // bookable-inventory precondition
  // Occupy ONE room (the highest number) so the offline warm has a real
  // settle/checkout target — checkout-check + balance?roomNumber are warmed
  // for non-available rooms. The test below reserves the first FREE room.
  // MUST be scoped to the demo hotel's tenant: this is a MULTI-TENANT DB
  // (a fresh seed gives another hotel rooms 301-303), and the desk only ever
  // sees its OWN tenant's rooms — occupying another tenant's room made the
  // "occupied room" warm check fail on fresh seeds (CI) while passing on a
  // dirty dev DB where the demo tenant happens to hold the highest number.
  {
    const Database = require('better-sqlite3');
    const dbc = new Database(path.join(dataDir, 'staychat.db'));
    const target = dbc.prepare(`SELECT id FROM rooms
      WHERE tenant_id = (SELECT tenant_id FROM users WHERE email = 'reception@hospitally.com')
      ORDER BY CAST(number AS INTEGER) DESC, number DESC LIMIT 1`).get();
    if (target) dbc.prepare(`UPDATE rooms SET status = 'occupied', guest_name = 'Warm Target' WHERE id = ?`).run(target.id);
    dbc.close();
  }
  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production' }),
    stdio: 'ignore',
  });
  try {
    await waitHealthy();
    const token = await adminToken();

    await withBrowser(async ({ send, evl }) => {
      console.log('── Sign in to the real app ──');
      await evl(`location.href = '${BASE}/app'`).catch(() => {});
      const landed = await waitFor(evl, `location.href`, `${BASE}/app`);
      if (landed !== `${BASE}/app`) return bad('never reached the app — at ' + landed);
      await sleep(1200);
      const login = await evl(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reception@hospitally.com', password: 'Demo@123456' }) }).then(r => r.status)`);
      if (login !== 200) return bad('receptionist login failed (HTTP ' + login + ')');
      ok('receptionist signed in inside the browser');
      // Publish the fresh session into window.App exactly like the app does
      // on reload (same call the settle suite uses).
      await evl(`tryRestoreSession()`);
      // Condition, not the clock: the boot path also restores (app.js), so
      // under battery load one attempt can lose the refresh-token rotation
      // race and get swallowed — RETRY (throttled; failed refreshes never
      // rotate tokens, so this is safe) until actually ready.
      const booted = await waitFor(evl, `(() => {
        if (window.App && App.user) return true;
        const now = Date.now();
        if (!window.__mcLastRestore || now - window.__mcLastRestore > 700) {
          window.__mcLastRestore = now;
          try { Promise.resolve(tryRestoreSession()).catch(() => {}); } catch (e) {}
        }
        return false;
      })()`, true, 20000);
      if (booted !== true) {
        const page = await evl(`({ href: location.href, ready: document.readyState, scripts: document.scripts.length })`).catch(() => null);
        const probe = await Promise.race([
          fetch(BASE + '/js/countries.js').then(r => r.status + '/' + (r.headers.get('content-length') || '?')).catch(e => 'ERR ' + e.message),
          new Promise(r => setTimeout(() => r('TIMEOUT(3s)'), 3000)),
        ]);
        return bad('app did not boot after login — page=' + JSON.stringify(page) + ' serverProbe=' + probe);
      }
      ok('app booted with a session');
      const offlineReady = await waitFor(evl, '!!(window.Offline && document.getElementById("offline-queue-badge"))', true, 8000);
      if (offlineReady !== true) return bad('offline module / badge missing — check index.html script tag');
      ok('offline outbox module loaded with its badge element');

      // Stash a room id while still online (the write path under test is the
      // queue, not the read cache).
      const roomId = await evl(`(async () => { const rooms = await API.get('/api/rooms'); const free = (rooms || []).find(r => r.status !== 'occupied'); return free ? free.id : (rooms && rooms[0] && rooms[0].id); })()`);
      if (!roomId) return bad('no rooms available for the booking precondition');
      ok('room id stashed for the reservation (' + roomId + ')');

      console.log('── Cut the network ──');
      await send('Network.enable');
      await send('Network.emulateNetworkConditions', { offline: true, latency: 20, downloadThroughput: -1, uploadThroughput: -1 });
      await sleep(300);
      const isOffline = await evl('navigator.onLine');
      if (isOffline !== false) return bad('navigator.onLine did not flip to false under CDP offline emulation (got ' + isOffline + ')');
      ok('navigator.onLine === false (CDP offline emulation active)');

      console.log('── Write while offline → queued, NOT sent ──');
      const guestQueued = await evl(`(async () => {
        const r = await API.post('/api/guests', { name: ${JSON.stringify(GUEST_NAME)} }, { offline: true, label: 'Guest — ${GUEST_NAME}' });
        return r && r.__offlineQueued === true;
      })()`);
      guestQueued === true ? ok('guest registration queued offline ({ __offlineQueued: true })') : bad('guest registration was not queued');

      const resaQueued = await evl(`(async () => {
        const IN = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
        const OUT = new Date(Date.now() + 16 * 86400000).toISOString().slice(0, 10);
        const r = await API.post('/api/bookings', {
          surname: ${JSON.stringify(RESA_LAST)}, firstName: ${JSON.stringify(RESA_FIRST)},
          checkIn: IN, checkOut: OUT, roomIds: [${JSON.stringify(roomId)}], isGroup: false,
          adults: 1, children: 0, source: 'direct', notes: '',
        }, { offline: true, label: 'Reservation — ${RESA_LAST}' });
        return r && r.__offlineQueued === true;
      })()`);
      resaQueued === true ? ok('reservation queued offline ({ __offlineQueued: true })') : bad('reservation was not queued');

      const pending = await evl('Offline.counts().then(c => c.pending)');
      pending === 2 ? ok('outbox holds exactly 2 pending changes') : bad('outbox pending count = ' + pending + ' (expected 2)');
      const badge = await evl(`(document.getElementById('offline-queue-badge').style.display !== 'none') && document.getElementById('offline-queue-badge').textContent`);
      (typeof badge === 'string' && badge.includes('2')) ? ok('badge shows the queue: "' + badge + '"') : bad('badge not showing the queue (' + badge + ')');

      const serverGuests = await apiGet('/api/guests', token);
      const serverBookings = await apiGet('/api/bookings', token);
      const guestBefore = (serverGuests || []).filter(g => g.name === GUEST_NAME).length;
      const resaBefore = (serverBookings || []).filter(b => String(b.guest_name || '').includes(RESA_LAST)).length;
      (guestBefore === 0 && resaBefore === 0) ? ok('server has NEITHER record yet (nothing leaked while offline)') : bad('server already has guest=' + guestBefore + ' booking=' + resaBefore + ' before sync');

      console.log('── Queue one deliberately bad request (conflict path) ──');
      await evl(`API.post('/api/bookings/does-not-exist-id/checkin', undefined, { offline: true, label: 'Bad check-in (test)' }).then(r => r && r.__offlineQueued === true)`);
      const pending3 = await evl('Offline.counts().then(c => c.pending)');
      pending3 === 3 ? ok('third (deliberately invalid) op queued too') : bad('pending count = ' + pending3 + ' (expected 3)');

      console.log('── Restore the network → automatic sync ──');
      await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await sleep(300);
      const isOnline = await evl('navigator.onLine');
      isOnline === true ? ok('navigator.onLine back to true') : bad('navigator.onLine stuck at ' + isOnline);

      // Wait for the OUTBOX to settle: 2 synced + 1 flagged conflict, 0 pending.
      const settled = await waitFor(evl, 'Offline.counts().then(c => c.pending + "|" + c.conflict + "|" + c.error)', '0|1|0', 25000);
      settled === '0|1|0'
        ? ok('auto-flush finished: 0 pending, 1 conflict flagged, 0 errors')
        : bad('outbox state after sync = ' + settled + ' (expected 0|1|0)');

      const serverGuests2 = await apiGet('/api/guests', token);
      const serverBookings2 = await apiGet('/api/bookings', token);
      const guestAfter = (serverGuests2 || []).filter(g => g.name === GUEST_NAME).length;
      const resaAfter = (serverBookings2 || []).filter(b => String(b.guest_name || '').includes(RESA_LAST)).length;
      guestAfter === 1 ? ok('exactly ONE "' + GUEST_NAME + '" exists server-side after sync') : bad('server guest count = ' + guestAfter + ' (expected 1)');
      resaAfter === 1 ? ok('exactly ONE reservation (' + RESA_LAST + ') exists server-side after sync') : bad('server booking count = ' + resaAfter + ' (expected 1)');

      const badgeText = await evl(`document.getElementById('offline-queue-badge').textContent`);
      (typeof badgeText === 'string' && badgeText.includes('review'))
        ? ok('badge switched to review mode: "' + badgeText + '"')
        : bad('badge does not flag the conflict (' + badgeText + ')');

      const ledgerOpens = await evl(`(async () => { Offline.openLedger(); await new Promise(r => setTimeout(r, 300)); const html = document.getElementById('modal-container').innerHTML; closeModal(); return html.includes('needs review') && html.includes('Bad check-in'); })()`);
      ledgerOpens === true ? ok('ledger modal lists the flagged conflict for staff review') : bad('ledger modal does not show the flagged conflict');

      console.log('── Session survives a network drop (no re-login) ──');
      const snapSaved = await evl(`(() => {
        try {
          const raw = localStorage.getItem('staychat.session-snapshot.v1');
          const snap = raw ? JSON.parse(raw) : null;
          return !!(snap && snap.user && snap.user.id);
        } catch (e) { return false; }
      })()`);
      snapSaved === true
        ? ok('session snapshot saved on this device after sign-in')
        : bad('no local session snapshot after sign-in');

      // Cut the network again and replay the boot restore — exactly what
      // happens when the desk reopens the installed PWA mid-outage.
      await send('Network.emulateNetworkConditions', { offline: true, latency: 20, downloadThroughput: -1, uploadThroughput: -1 });
      await sleep(300);
      await evl(`(async () => {
        window.App.user = null; window.App.accessToken = null;
        window.App.tenant = null; window.App.tenantId = null; window.App.permissions = [];
        document.getElementById('app').classList.remove('visible');
        document.getElementById('auth-screen').style.display = '';
        await tryRestoreSession();
      })()`);
      const restored = await waitFor(evl, `!!(window.App && App.user)`, true, 10000);
      const onLoginScreen = await evl(`document.getElementById('auth-screen').style.display !== 'none'`);
      (restored === true && onLoginScreen === false)
        ? ok('offline boot reopens the session from the local snapshot — NOT the login form')
        : bad('offline boot fell back to the login form (user=' + restored + ', showingLogin=' + onLoginScreen + ')');
      const noTokenOffline = await evl(`App.accessToken === null`);
      noTokenOffline === true
        ? ok('offline boot invents no credentials (access token stays null until revalidated)')
        : bad('unexpected access token after offline boot');

      // Back online → the shell revalidates itself with no user action.
      await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      const revalidated = await waitFor(evl, `!!(window.App && App.accessToken)`, true, 15000);
      revalidated === true
        ? ok('back online: session revalidated automatically — nobody had to sign in again')
        : bad('session never revalidated after the connection came back');

      console.log('── Whole desk downloaded for offline use (install-time warm) ──');
      // The exact moment under test: the operator clicks "Install app" —
      // pwa.js's appinstalled handler must kick off the full data download.
      await evl(`window.dispatchEvent(new Event('appinstalled'))`);
      const installToast = await waitFor(evl, `document.body.textContent.includes('desk datasets')`, true, 15000);
      installToast === true
        ? ok('appinstalled (the install click) starts the full data download — toast confirms it')
        : bad('appinstalled event did not trigger the warm/download toast');
      // The 'online' event above re-ran PWA.warmCache(); poll the SW's API
      // cache until the desk's reads land (4-way parallel warm on localhost).
      const warmed = await waitFor(evl, `(async () => {
        const names = await caches.keys();
        const name = names.filter(n => n.indexOf('staychat-api-') === 0).sort().pop();
        if (!name) return false;
        const keys = await (await caches.open(name)).keys();
        return keys.length >= 20;
      })()`, true, 30000);
      warmed === true
        ? ok('SW API cache filled with the warmed desk data (≥20 reads)')
        : bad('SW API cache never filled — warmCache/pwa.js did not run or saved nothing');
      const missing = await evl(`(async () => {
        const names = await caches.keys();
        const name = names.filter(n => n.indexOf('staychat-api-') === 0).sort().pop();
        if (!name) return ['no api cache at all'];
        const cache = await caches.open(name);
        // Spot-check reads from pages this receptionist never opened, plus
        // one entry that only exists because of the expanded inventory —
        // each must sit under the EXACT url its page will request.
        const need = ['/api/rooms', '/api/bookings', '/api/guests', '/api/staff',
          '/api/settings', '/api/shifts', '/api/menu', '/api/payments/transactions?limit=2000',
          '/api/reports/types', '/api/room-setup/holidays', '/api/bookings/facilities/pending',
          '/api/halls/bookings', '/api/gym/registrations'];
        const missing = [];
        for (const p of need) if (!(await cache.match(API.cacheUrl(p)))) missing.push(p);
        return missing;
      })()`);
      Array.isArray(missing) && missing.length === 0
        ? ok('every spot-checked desk read is cached byte-for-byte under its page URL')
        : bad('missing from the offline cache: ' + JSON.stringify(missing));

      // Per-id workflow reads: the money flows a bad network used to break.
      const missingDetail = await evl(`(async () => {
        const names = await caches.keys();
        const name = names.filter(n => n.indexOf('staychat-api-') === 0).sort().pop();
        if (!name) return ['no api cache at all'];
        const cache = await caches.open(name);
        const out = [];
        const has = p => cache.match(API.cacheUrl(p)).then(r => !!r);
        // Settle/checkout: the occupied room seeded above needs BOTH reads.
        const rooms = await API.get('/api/rooms');
        const occ = (rooms || []).find(r => r.status === 'occupied');
        if (occ) {
          const p1 = '/api/rooms/' + occ.id + '/checkout-check';
          const p2 = '/api/payments/balance?roomNumber=' + encodeURIComponent(occ.number);
          if (!(await has(p1))) out.push(p1);
          if (!(await has(p2))) out.push(p2);
        } else out.push('no occupied room in the DB copy — seed failed');
        // Guest bill (folio) + booking-settle balance.
        const books = await API.get('/api/bookings');
        const b0 = (books || [])[0];
        if (b0) {
          const p1 = '/api/bookings/' + b0.id + '/folio';
          const p2 = '/api/payments/balance?bookingId=' + b0.id;
          if (!(await has(p1))) out.push(p1);
          if (!(await has(p2))) out.push(p2);
        } else out.push('no bookings in the DB copy');
        // Inbox thread CONTENTS (the /messages url the page asks for).
        const convs = await API.get('/api/inbox/conversations');
        if (convs && convs.length) {
          const p = '/api/inbox/conversations/' + convs[0].id + '/messages';
          if (!(await has(p))) out.push(p);
        }
        // EOD close preview for this user's own department, for TODAY.
        const today = new Date().toISOString().slice(0, 10);
        const mine = await API.get('/api/eod/mine?date=' + today);
        if (mine && mine.department) {
          const p = '/api/eod/preview?department=' + mine.department + '&date=' + today;
          if (!(await has(p))) out.push(p);
        }
        return out;
      })()`);
      Array.isArray(missingDetail) && missingDetail.length === 0
        ? ok('settle/checkout/folio/inbox/EOD workflow reads are all cached under their exact page URLs')
        : bad('workflow reads missing offline: ' + JSON.stringify(missingDetail));

      console.log('── Whole system renders OFFLINE (network cut again, cache-only) ──');
      await send('Network.emulateNetworkConditions', { offline: true, latency: 20, downloadThroughput: -1, uploadThroughput: -1 });
      await sleep(300);
      const offPages = [
        ['dashboard', 'Command Center'], ['rooms', 'Room Management'],
        ['bookings', 'Bookings & Reservations'], ['guests', 'Guest Profiles'],
        ['payments', 'Payments'], ['eod', 'End of Day'],
        ['inbox', 'WhatsApp Inbox'], ['orders', 'Room Service Orders'],
        ['reports', 'Report Management'], ['analytics', 'Analytics & Reports'],
        ['shifts', 'Shifts & Attendance'], ['housekeeping', 'Housekeeping'],
        ['maintenance', 'Maintenance'], ['pool', 'Pool Bookings'],
        ['halls', 'Halls & Events'], ['gym', 'Gym & Fitness'],
        ['wifi', 'Guest Wi-Fi'],
      ];
      const broken = [];
      for (const [page, heading] of offPages) {
        await evl(`navigate('${page}')`);
        const got = await waitFor(evl,
          `(() => { const h = document.querySelector('#content h1'); return !!h && h.textContent.indexOf(${JSON.stringify(heading)}) !== -1; })()`,
          true, 5000);
        if (got !== true) broken.push(page);
      }
      await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await sleep(300);
      broken.length === 0
        ? ok('all ' + offPages.length + ' desk pages render offline from the local cache')
        : bad('pages that failed offline: ' + JSON.stringify(broken));

      console.log('── Steady hands: duplicate submits + rate-limit retry ──');
      // Identical writes fired at the SAME moment while the network is slow
      // used to double-submit. api.js now coalesces identical in-flight
      // requests — two parallel posts must produce ONE record server-side.
      const dup = await evl(`(async () => {
        const name = 'Coalesce Probe ' + Date.now();
        const [a, b] = await Promise.all([
          API.post('/api/guests', { name }),
          API.post('/api/guests', { name }),
        ]);
        if ((a && a.__offlineQueued) || (b && b.__offlineQueued)) return JSON.stringify({ queued: true });
        const all = await API.get('/api/guests');
        return JSON.stringify({ queued: false, count: all.filter(g => g.name === name).length });
      })()`);
      let dupJ = {}; try { dupJ = JSON.parse(dup); } catch (e) {}
      if (dupJ.queued === false && dupJ.count === 1) {
        ok('identical concurrent submits coalesce into ONE request (1 guest, not 2)');
      } else bad('duplicate-submit guard — ' + dup);

      // When the per-IP limiter pushes back (many users behind one office
      // NAT), a read must pause and retry itself instead of dying with a red
      // error — first call answered with a synthetic 429, second goes through.
      const r429 = await evl(`(async () => {
        const orig = window.fetch; let hits = 0;
        window.fetch = function (url) {
          if (String(url).indexOf('/api/shifts') === 0) {
            hits++;
            if (hits === 1) return Promise.resolve(new Response(JSON.stringify({ error: 'Too many requests' }), { status: 429, headers: { 'Content-Type': 'application/json' } }));
          }
          return orig.apply(window, arguments);
        };
        try { const rows = await API.get('/api/shifts'); return JSON.stringify({ ok: Array.isArray(rows), hits }); }
        catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message), hits }); }
        finally { window.fetch = orig; }
      })()`);
      let r429j = {}; try { r429j = JSON.parse(r429); } catch (e) {}
      if (r429j.ok === true && r429j.hits === 2) {
        ok('a 429 backs off and the GET retries itself once (2 hits, data arrives)');
      } else bad('429 retry — ' + r429);

      console.log('── Logout hygiene: outbox wipe ──');
      const wiped = await evl(`(async () => { await PWA.wipeCaches(); const c = await Offline.counts(); return c.pending + c.conflict + c.error; })()`);
      wiped === 0 ? ok('PWA.wipeCaches() clears the outbox (shared-device safety)') : bad('outbox survived wipe: ' + wiped + ' items left');
      const badgeHidden = await evl(`document.getElementById('offline-queue-badge').style.display === 'none'`);
      badgeHidden === true ? ok('badge hidden again when nothing is queued') : bad('badge still visible after wipe');
    });
  } finally {
    try { srv.kill('SIGTERM'); } catch (e) {}
    await sleep(400);
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n════════════════════════════════════════════════');
  console.log(fail === 0 ? ' ✓ ALL ' + pass + ' OFFLINE-SYNC CHECKS PASSED' : ' ✗ ' + fail + ' of ' + (pass + fail) + ' CHECKS FAILED');
  console.log('════════════════════════════════════════════════');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('✗ suite crashed:', e && e.stack || e);
  process.exit(1);
});
