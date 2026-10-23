#!/usr/bin/env node
// scripts/browser-test-pos-visual.js — verifies the additive POS terminal
// redesign (public/css/pos-terminal.css) through the interface the cashier /
// barman actually uses.
//
// Boots a throwaway server (fresh DB, pro tenant + admin + seeded menu),
// signs in inside headless Chromium, then asserts through the app's own code
// path:
//   • the terminal picker → ticket board still renders and keeps its
//     original "+ New Ticket" button (system untouched),
//   • the ticket modal's product list is a responsive CARD GRID of large
//     tap-friendly tiles (not the old compact list),
//   • the two-pane terminal layout collapses to a single column at phone
//     width (responsive),
//   • tapping a product tile still adds it to the ticket, and a full cash
//   • checkout still closes the ticket — the redesign changes no behaviour.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { freePort } = require('./lib/free-port');

const ROOT = path.join(__dirname, '..');
const PORT = 4314;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-posvisual-test-profile';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (evl, expr, want, timeoutMs = 8000) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await evl(expr);
    if (last === want) return last;
    await sleep(150);
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
    if (!devtoolsUp) throw new Error('chromium DevTools endpoint never came up');
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

(async () => {
  // ── Fresh DB: pro tenant + admin + seeded restaurant/bar menu ─────────
  const dataDir = fs.mkdtempSync('/tmp/staychat-posvisual.');
  process.env.DATA_DIR = dataDir;
  const db = require(path.join(ROOT, 'server', 'db', 'connection'));
  require(path.join(ROOT, 'server', 'db', 'migrate'));
  const { nanoid } = require('nanoid');
  const bcrypt = require('bcryptjs');
  const tenantId = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?, 'pro', 'active')`)
    .run(tenantId, 'POS Visual Hotel', 'posv-' + nanoid(5));
  const adminEmail = ('posvadmin-' + nanoid(4) + '@posv.test').toLowerCase();
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?, 'hotel_admin')`)
    .run('user_' + nanoid(8), tenantId, 'POS Admin', adminEmail, bcrypt.hashSync('Demo@123456', 8));
  const insItem = db.prepare(`INSERT INTO menu_items (id, tenant_id, name, category, price) VALUES (?,?,?,?,?)`);
  [['Jollof Rice', 'Mains', 15], ['Pepper Soup', 'Soups', 20], ['Smirnoff', 'Drinks', 8], ['Biggie Beer', 'Drinks', 6]]
    .forEach(([n, c, p]) => insItem.run('mi_' + nanoid(8), tenantId, n, c, p));
  db.close();

  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'development' }),
    stdio: 'ignore',
  });
  try {
    await waitHealthy();

    await withBrowser(async ({ send, evl }) => {
      // Desktop-ish viewport so the grid has room to show multiple columns.
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await evl(`location.href = '${BASE}/app'`).catch(() => {});
      const landed = await waitFor(evl, `location.href`, `${BASE}/app`);
      if (landed !== `${BASE}/app`) return bad('never reached the app — at ' + landed);
      await sleep(1200);

      const login = await evl(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '${adminEmail}', password: 'Demo@123456' }) }).then(async r => r.status + ' ' + await r.text())`);
      if (!String(login).startsWith('200')) return bad('admin login failed — ' + login);
      ok('hotel admin signed in inside the browser');
      await evl(`tryRestoreSession()`);
      const ready = await waitFor(evl, `(() => {
        if (window.App && App.user && Array.isArray(App.permissions) && App.permissions.length > 0) return true;
        const now = Date.now();
        if (!window.__mcLastRestore || now - window.__mcLastRestore > 700) {
          window.__mcLastRestore = now;
          try { Promise.resolve(tryRestoreSession()).catch(() => {}); } catch (e) {}
        }
        return false;
      })()`, true, 20000);
      if (!ready) return bad('session/permissions never became ready');

      // ── 1. Terminal picker → restaurant terminal ──────────────────────
      await evl(`navigate('pos')`); await sleep(1200);
      const picker = await evl(`document.getElementById('content').textContent`);
      if (picker.includes('Restaurant Terminal') && picker.includes('Bar Terminal')) ok('terminal picker renders both terminals');
      else bad('terminal picker missing — ' + (picker || '').slice(0, 80));
      await evl(`window.__posPickTerminal('restaurant')`); await sleep(400);
      await evl(`window.__posConfirmTerminal('restaurant')`); await sleep(1000);
      const header = await evl(`(() => {
        const h = document.querySelector('#content .page-header');
        return h ? Array.from(h.querySelectorAll('button')).map(b => b.textContent.trim()) : null;
      })()`);
      if (header && header.some(b => b.includes('+ New Ticket'))) ok('terminal board keeps its original "+ New Ticket" button (system untouched)');
      else bad('terminal header wrong — ' + JSON.stringify(header));

      // ── 2. Open a ticket → product grid appears ───────────────────────
      await evl(`window.__posNewTicket()`); await sleep(500);
      const ticketForm = await evl(`!!document.getElementById('pt-label')`);
      if (ticketForm) ok('new-ticket modal opens');
      else bad('new-ticket modal did not open');
      await evl(`(() => { document.getElementById('pt-label').value = 'Table 5'; })()`);
      await evl(`window.__posCreateTicket()`);
      const gridUp = await waitFor(evl, `!!document.querySelector('.pos-menu-list')`, true, 8000);
      if (!gridUp) return bad('ticket modal / product list never appeared');
      await sleep(300);

      const listDisplay = await evl(`getComputedStyle(document.querySelector('.pos-menu-list')).display`);
      if (listDisplay === 'grid') ok('products render as a CARD GRID (display:grid on .pos-menu-list)');
      else bad('.pos-menu-list display is ' + listDisplay + ' — expected grid');

      const cols = await evl(`(() => {
        const v = getComputedStyle(document.querySelector('.pos-menu-list')).gridTemplateColumns;
        return v ? v.split(' ').filter(Boolean).length : 0;
      })()`);
      if (cols >= 2) ok('grid shows multiple product columns on desktop (' + cols + ' columns at 1280px)');
      else bad('grid has ' + cols + ' column(s) at 1280px');

      const tiles = await evl(`(() => {
        const t = document.querySelector('.pos-menu-item-btn');
        if (!t) return null;
        const r = t.getBoundingClientRect();
        return { count: document.querySelectorAll('.pos-menu-item-btn').length, w: Math.round(r.width), h: Math.round(r.height) };
      })()`);
      if (tiles && tiles.count === 4) ok('all 4 menu products render as tiles');
      else bad('tile count wrong — ' + JSON.stringify(tiles));
      if (tiles && tiles.h >= 90 && tiles.w >= 130) ok('tiles are large tap targets (' + tiles.w + '×' + tiles.h + 'px)');
      else bad('tiles too small — ' + JSON.stringify(tiles));

      // ── 3. Behaviour intact: tap adds to the ticket ───────────────────
      await evl(`document.querySelector('.pos-menu-item-btn').click()`);
      const cartLines = await waitFor(evl, `document.querySelectorAll('.pos-cart-line').length`, 1, 5000);
      if (cartLines === 1) ok('tapping a tile still adds the product to the ticket (cart line appears)');
      else bad('cart line count = ' + cartLines);
      // Compare against the TAPPED tile's own price — the grid is ordered by
      // category/name, so hardcoding which product comes first is brittle.
      const priceCheck = await evl(`(() => {
        const tile = document.querySelector('.pos-menu-item-btn');
        const priceText = ((tile && tile.querySelector('.pos-menu-item-price')) || {}).textContent || '';
        const total = (document.querySelector('.pos-cart-totals-row.grand') || {}).textContent || '';
        return { priceText, total };
      })()`);
      if (priceCheck && priceCheck.priceText && priceCheck.total.includes(priceCheck.priceText)) {
        ok('cart totals update with the tapped product\u2019s price (' + priceCheck.priceText + ')');
      } else bad('cart total does not match the tapped tile — ' + JSON.stringify(priceCheck));

      // ── 4. Responsive: single column at phone width ───────────────────
      await send('Emulation.setDeviceMetricsOverride', { width: 480, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(500);
      const narrow = await evl(`(() => {
        const l = getComputedStyle(document.querySelector('.pos-layout')).gridTemplateColumns;
        return { tracks: l ? l.split(' ').filter(Boolean).length : 0, val: l };
      })()`);
      if (narrow && narrow.tracks === 1) ok('layout collapses to a single column at 480px (responsive)');
      else bad('layout still ' + JSON.stringify(narrow) + ' at 480px');
      await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(400);

      // ── 5. Full cash checkout still closes the ticket ─────────────────
      const ticketId = await evl(`(() => {
        const b = Array.from(document.querySelectorAll('.modal-footer button')).find(x => x.textContent.includes('Checkout'));
        const m = b && b.getAttribute('onclick') && b.getAttribute('onclick').match(/__posCheckout\\('([^']+)'/);
        return m ? m[1] : null;
      })()`);
      if (!ticketId) return bad('could not extract the ticket id from the checkout button');
      await evl(`window.__posCheckout('${ticketId}')`); await sleep(600);
      const payTiles = await evl(`document.querySelectorAll('.pos-pay-option').length`);
      if (payTiles >= 4) ok('checkout renders the payment method tiles (' + payTiles + ')');
      else bad('payment tiles = ' + payTiles);
      await evl(`window.__posSelectMethod('${ticketId}', 'cash')`); await sleep(300);
      await evl(`(() => { document.getElementById('co-cash').value = '50'; })()`);
      await evl(`window.__posConfirmCheckout('${ticketId}')`);
      const openLeft = await waitFor(evl, `API.get('/api/pos/tickets').then(t => t.filter(x => x.status === 'open').length)`, 0, 8000);
      if (openLeft === 0) ok('cash checkout closes the ticket end-to-end (behaviour intact through the redesign)');
      else bad('open tickets after checkout = ' + openLeft);
      await evl(`closeModal()`).catch(() => {});
    });
  } finally {
    try { srv.kill(); } catch (e) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(PROFILE, { recursive: true, force: true }); break; }
      catch (e) { await sleep(400); }
    }
  }

  console.log('\n' + (fail ? '✗ ' + fail + ' check(s) FAILED, ' + pass + ' passed' : '✓ ALL ' + pass + ' CHECKS PASSED'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
