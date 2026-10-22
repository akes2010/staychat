#!/usr/bin/env node
// Browser-test the public booking engine with headless Chromium (CDP, no new deps).
// Boots a throwaway server on a DB copy, then drives /book.html as a guest:
// rooms tab + facilities tab → booking → confirmation slip rendering.
// Usage: node scripts/browser-test-ota.js
'use strict';
const { execFileSync, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { freePort } = require('./lib/free-port');
const { normalizeRoomsInCopy } = require('./lib/normalize-rooms');

const ROOT = path.join(__dirname, '..');
const PORT = 4277;
const BASE = 'http://localhost:' + PORT;
const SHOTS = path.join(ROOT, 'deploy', 'browser-shots');
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// The hotel name is local data — tenants get renamed on any deployment — so
// anchor the render assertion on what THIS server's public booking-engine API
// reports for the subdomain, not on a hardcoded demo literal. The property
// under test is "book.html renders the tenant's branding from the API"; this
// still catches empty/undefined/'[object Object]' output and a page showing
// the wrong hotel, while surviving seed drift.
async function hotelNameFrom(origin) {
  try {
    const r = await fetch(origin + '/api/booking-engine/config?subdomain=hospitally');
    if (!r.ok) return null;
    const name = (await r.json()).hotelName;
    return name ? String(name).trim() : null;
  } catch (e) { return null; }
}

function waitHealthy() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      http.get(BASE + '/api/health', r => { r.resume(); resolve(); })
        .on('error', () => Date.now() - start > 15000 ? reject(new Error('server not healthy')) : setTimeout(tick, 400));
    };
    tick();
  });
}

// ── Tiny CDP client ──────────────────────────────────────────────────────────
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; 
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) { this.handlers.forEach(h => h(msg)); }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify(Object.assign({ id, method, params }, sessionId ? { sessionId } : {})));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  onEvent(fn) { this.handlers.push(fn); }
}

async function connectCdp(port) {
  // Headless Chromium writes DevToolsActivePort inside its user-data dir (and
  // some builds skip the /tmp/.org.chromium.Chromium file entirely), so fetch
  // the page target over the HTTP endpoint instead of reading a JSON file.
  const list = await fetch(`http://localhost:${port}/json`).then(r => r.json());
  const page = list.find(t => t.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return new CDP(ws);
}

(async () => {
  let failed = 0;
  const ok = (m) => console.log('  ✓ ' + m);
  const bad = (m) => { failed++; console.log('  ✗ ' + m); };

  // 1. Boot server on a DB copy
  const dataDir = fs.mkdtempSync('/tmp/staychat-browsertest.');
  fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db'), path.join(dataDir, 'staychat.db'));
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(path.join(ROOT, 'data', 'staychat.db' + ext))) fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db' + ext), path.join(dataDir, 'staychat.db' + ext));
  }
  normalizeRoomsInCopy(dataDir); // bookable-inventory precondition (see helper)
  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'development' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  srv.stdout.on('data', d => serverLog += d); srv.stderr.on('data', d => serverLog += d);
  try { await waitHealthy(); ok('test server healthy on ' + PORT); }
  catch (e) { console.error('server failed to boot:\n' + serverLog.slice(-2000)); process.exit(1); }

  // 2. Launch Chromium with CDP
  const cdpPort = await freePort(); // free port per run — no fixed-port collisions
  const userDataDir = fs.mkdtempSync('/tmp/chrome-test-profile.');
  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${cdpPort}`, '--window-size=420,900', 'about:blank',
  ], { stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { await fetch(`http://localhost:${cdpPort}/json/version`); up = true; }
    catch (e) { await sleep(250); }
  }
  if (!up) throw new Error('Chromium CDP port never came up');
  const cdp = await connectCdp(cdpPort);
  ok('Chromium connected');

  const shots = [];
  async function shot(name) {
    const ss = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOTS, name + '.png');
    fs.writeFileSync(file, Buffer.from(ss.data, 'base64'));
    shots.push(file);
  }
  async function evaljs(expr) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async function goto(url) {
    await cdp.send('Page.navigate', { url });
    // Condition, not the clock — but never TRUST a single CDP evaluate issued
    // during navigation: the response can be lost with the torn-down context
    // and the await hangs forever (observed under memory pressure). Race each
    // probe with a short timeout and bound the whole wait.
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const st = await Promise.race([
        evaljs(`location.href + '|' + document.readyState`).catch(() => null),
        new Promise(r => setTimeout(() => r('probe-timeout'), 1000)),
      ]);
      if (st === url + '|complete') break;
      await sleep(150);
    }
    await sleep(700); // let fetch-rendered content settle before assertions
  }

  try {
    // ── Guest: open the booking page ──────────────────────────────────────
    await goto(BASE + '/book.html?hotel=hospitally');
    await shot('01-book-page');
    const hotel = await evaljs('document.getElementById("h-name").textContent');
    const expectedHotel = await hotelNameFrom(BASE);
    hotel && expectedHotel && hotel.trim() === expectedHotel
      ? ok('booking page renders hotel: ' + hotel)
      : bad('hotel name wrong: rendered ' + JSON.stringify(hotel) + ', API says ' + JSON.stringify(expectedHotel));
    const tabsVisible = await evaljs('!!document.getElementById("tab-facilities") && document.getElementById("tab-facilities").style.display !== "none"');
    tabsVisible ? ok('Facilities tab visible') : bad('Facilities tab missing/hidden');

    // ── Rooms flow: search → select → book ────────────────────────────────
    await evaljs('document.getElementById("search").click()');
    await sleep(900);
    const roomCount = await evaljs('document.querySelectorAll("#rooms .room").length');
    roomCount > 0 ? ok('room search shows ' + roomCount + ' rooms') : bad('room search returned 0');
    await shot('02-room-results');
    await evaljs(`(async () => {
      const el = document.querySelector('#rooms .room'); el.click();
      document.getElementById('g-name').value = 'Browser Tester';
      document.getElementById('g-phone').value = '+2348011122233';
      document.getElementById('g-email').value = 'browser-test@example.com';
      document.getElementById('submit').click(); return true; })()`);
    await sleep(1500);
    const code = await evaljs('document.getElementById("d-code").textContent');
    const slipShown = await evaljs('document.getElementById("step-done").style.display');
    if (code && code.startsWith('BE-') && slipShown === 'block') ok('room booking made in-browser, code ' + code);
    else bad('room booking flow failed: code=' + code + ' display=' + slipShown);
    await shot('03-room-booked');

    // ── Facilities flow: switch tab → search → book a hall ────────────────
    await goto(BASE + '/book.html?hotel=hospitally');
    await evaljs('document.getElementById("tab-facilities").click()');
    await sleep(200);
    const pane = await evaljs('document.getElementById("pane-facilities").style.display');
    pane === 'block' ? ok('facilities pane opens') : bad('facilities pane hidden after tab click: ' + pane);
    await evaljs('document.getElementById("f-search").click()');
    await sleep(1800);
    const facCount = await evaljs('document.querySelectorAll("#facilities .room").length');
    facCount > 0 ? ok('facility search shows ' + facCount + ' facilities') : bad('facility search returned 0');
    await shot('04-facility-results');
    const hallCode = await evaljs(`(async () => {
      const cards = [...document.querySelectorAll('#facilities .room')];
      const hall = cards.find(c => c.dataset.kind === 'hall' && !c.style.opacity);
      if (!hall) return null;
      hall.click();
      document.getElementById('g-name').value = 'Browser Facility Tester';
      document.getElementById('g-phone').value = '+2348044455566';
      document.getElementById('f-date').value = new Date(Date.now() + 6 * 864e5).toISOString().slice(0, 10);
      document.getElementById('g-event').value = 'Browser Test Wedding';
      document.getElementById('submit').click();
      return true; })()`);
    await sleep(1500);
    const facCode = await evaljs('document.getElementById("d-code").textContent');
    if (facCode && facCode.startsWith('BE-')) ok('facility booking made in-browser, code ' + facCode);
    else bad('facility booking flow failed: ' + facCode);
    await shot('05-facility-booked');

    // ── Confirmation slip renders from a deep link ────────────────────────
    await goto(BASE + '/confirmation.html?hotel=hospitally&code=' + facCode);
    await sleep(900);
    const slipVisible = await evaljs('document.getElementById("slip").classList.contains("open")');
    const facilityName = await evaljs('document.getElementById("s-rooms").textContent');
    slipVisible ? ok('confirmation slip opens from deep link') : bad('slip did not render');
    facilityName.includes('Ballroom') || facilityName.includes('Pavilion') || facilityName.includes('Boardroom')
      ? ok('slip shows facility: ' + facilityName.trim()) : bad('slip missing facility name: ' + facilityName);
    await shot('06-confirmation-slip');

    // ── Live-site screenshots (read-only, real :3000 server) ──────────────
    try {
      await goto('http://localhost:3000/book.html?hotel=hospitally');
      await shot('07-live-book-page');
      const liveHotel = await evaljs('document.getElementById("h-name").textContent');
      const liveExpected = await hotelNameFrom('http://localhost:3000');
      liveHotel && liveExpected && liveHotel.trim() === liveExpected
        ? ok('LIVE server book page renders: ' + liveHotel)
        : bad('live page: rendered ' + JSON.stringify(liveHotel) + ', API says ' + JSON.stringify(liveExpected));
      await goto('http://localhost:3000/book.html?hotel=hospitally#fac');
    } catch (e) { console.log('  (live-site shot skipped: ' + e.message + ')'); }

  } catch (e) {
    bad('browser test crashed: ' + e.message);
    console.error(serverLog.slice(-1500));
  } finally {
    console.log('\nScreenshots saved to deploy/browser-shots/:');
    shots.forEach(f => console.log('  ' + path.basename(f)));
    try { cdp.ws.close(); } catch (e) {}
    try { chrome.kill(); } catch (e) {}
    try { srv.kill(); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(failed === 0 ? '\n═══ BROWSER TEST: ALL PASSED ═══' : `\n═══ BROWSER TEST: ${failed} FAILURE(S) ═══`);
  process.exit(failed === 0 ? 0 : 1);
})();
