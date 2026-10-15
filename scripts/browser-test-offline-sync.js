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
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
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
  for (let i = 0; i < 20; i++) {
    try { await fetch('http://localhost:9229/json/version'); throw new Error('port 9229 busy — a previous chromium instance is still shutting down'); }
    catch (e) { if (e instanceof TypeError) break; await sleep(250); }
  }
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-popup-blocking',
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=9229', 'about:blank'], { stdio: 'ignore' });
  try {
    let devtoolsUp = false;
    for (let i = 0; i < 40 && !devtoolsUp; i++) {
      try {
        const v = await fetch('http://localhost:9229/json/version').then(r => r.json());
        devtoolsUp = !!v.webSocketDebuggerUrl;
      } catch (e) { await sleep(250); }
    }
    if (!devtoolsUp) throw new Error('our chromium DevTools endpoint never came up');
    const list = await fetch('http://localhost:9229/json').then(r => r.json());
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
      await sleep(1500);
      const login = await evl(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reception@hospitally.com', password: 'Demo@123456' }) }).then(r => r.status)`);
      if (login !== 200) return bad('receptionist login failed (HTTP ' + login + ')');
      ok('receptionist signed in inside the browser');
      // Publish the fresh session into window.App exactly like the app does
      // on reload (same call the settle suite uses).
      await evl(`tryRestoreSession()`);
      const booted = await waitFor(evl, '!!(window.App && App.user)', true, 12000);
      if (booted !== true) return bad('app did not boot after login');
      ok('app booted with a session');
      const offlineReady = await waitFor(evl, '!!(window.Offline && document.getElementById("offline-queue-badge"))', true, 8000);
      if (offlineReady !== true) return bad('offline module / badge missing — check index.html script tag');
      ok('offline outbox module loaded with its badge element');

      // Stash a room id while still online (the write path under test is the
      // queue, not the read cache).
      const roomId = await evl(`(async () => { const rooms = await API.get('/api/rooms'); return rooms && rooms[0] && rooms[0].id; })()`);
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
