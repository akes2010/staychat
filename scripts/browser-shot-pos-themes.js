#!/usr/bin/env node
// scripts/browser-shot-pos-themes.js — recapture the separated POS terminal
// themes on demand (the shots live in deploy/browser-shots/ and are committed
// so a reviewer can eyeball restaurant vs bar without booting anything).
//
//   node scripts/browser-shot-pos-themes.js
//
// Boots a throwaway server (fresh temp DB: tenant, admin, per-outlet menu and
// one open ticket per outlet), drives headless Chromium through the app's own
// code path and writes five PNGs:
//
//   pos-terminals-picker.png             — the picker's two themed cards
//   pos-terminal-restaurant.png          — warm restaurant till
//   pos-terminal-restaurant-ticket.png   — its ticket modal (restaurant menu)
//   pos-terminal-bar.png                 — dark bar till
//   pos-terminal-bar-ticket.png          — its ticket modal (bar menu)
//
// Nothing in the repo's data/ directory is touched and nothing here is part of
// the regression battery — it is a visual-review tool.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { freePort } = require('./lib/free-port');
const WebSocket = require('ws');

const OUT = path.join(ROOT, 'deploy', 'browser-shots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (evl, expr, want, timeoutMs = 10000) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await evl(expr);
    if (last === want) return last;
    await sleep(150);
  }
  return last;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // ── Fresh DB: pro tenant + admin + a menu row per outlet + one open ticket
  const dataDir = fs.mkdtempSync('/tmp/staychat-shot.');
  process.env.DATA_DIR = dataDir;
  const db = require(path.join(ROOT, 'server', 'db', 'connection'));
  require(path.join(ROOT, 'server', 'db', 'migrate'));
  const { nanoid } = require('nanoid');
  const bcrypt = require('bcryptjs');
  const tenantId = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?, 'pro', 'active')`)
    .run(tenantId, 'Hospitally Grand Resort', 'shot-' + nanoid(5));
  const adminEmail = ('shotadmin-' + nanoid(4) + '@shot.test').toLowerCase();
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?, 'hotel_admin')`)
    .run('user_' + nanoid(8), tenantId, 'John Manager', adminEmail, bcrypt.hashSync('Demo@123456', 8));

  const insMenu = db.prepare(`INSERT INTO menu_items (id, tenant_id, name, category, price, available, outlet) VALUES (?,?,?,?,?,1,?)`);
  [['Grilled Chicken', 'Mains', 18, 'restaurant'], ['Caesar Salad', 'Salads', 11, 'restaurant'],
   ['Chocolate Cake', 'Desserts', 8, 'restaurant'], ['Coke / Sprite', 'Drinks', 3, 'both'],
   ['Mojito', 'Cocktails', 9, 'bar'], ['Old Fashioned', 'Cocktails', 12, 'bar'],
   ['Local Lager', 'Beer', 5, 'bar'], ['Bar Snack Mix', 'Bar Snacks', 6, 'bar']]
    .forEach(([n, c, p, o]) => insMenu.run('mi_' + nanoid(8), tenantId, n, c, p, o));

  const now = new Date().toISOString();
  const insTk = db.prepare(`INSERT INTO pos_tickets (id, tenant_id, outlet, label, guest_name, room_number, items, subtotal, discount_pct, service_pct, tax_pct, total, status, opened_by, created_at)
    VALUES (@id,@tenant_id,@outlet,@label,@guest_name,@room_number,@items,@subtotal,0,0,0,@total,'open',@opened_by,@created_at)`);
  insTk.run({ id: 'tk_' + nanoid(8), tenant_id: tenantId, outlet: 'restaurant', label: 'Table 5', guest_name: 'Ms. Chen', room_number: '106',
    items: JSON.stringify([{ id: 'i1', name: 'Grilled Chicken', price: 18, qty: 2 }, { id: 'i2', name: 'Coke / Sprite', price: 3, qty: 2 }]),
    subtotal: 42, total: 42, opened_by: 'Priya Sharma', created_at: now });
  insTk.run({ id: 'tk_' + nanoid(8), tenant_id: tenantId, outlet: 'restaurant', label: 'Table 2', guest_name: 'Walk-in', room_number: null,
    items: JSON.stringify([{ id: 'i1', name: 'Caesar Salad', price: 11, qty: 1 }]), subtotal: 11, total: 11, opened_by: 'Priya Sharma', created_at: now });
  insTk.run({ id: 'tk_' + nanoid(8), tenant_id: tenantId, outlet: 'bar', label: 'Bar Seat 2', guest_name: 'Mr. Williams', room_number: '204',
    items: JSON.stringify([{ id: 'i1', name: 'Mojito', price: 9, qty: 3 }, { id: 'i2', name: 'Bar Snack Mix', price: 6, qty: 1 }]),
    subtotal: 33, total: 33, opened_by: 'Diane Okoro', created_at: now });
  db.close();

  const PORT = await freePort();
  const BASE = 'http://localhost:' + PORT;
  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'development' }),
    stdio: 'ignore',
  });
  const waitHealthy = () => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => http.get(BASE + '/api/health', r => { r.resume(); resolve(); })
      .on('error', () => Date.now() - t0 > 15000 ? reject(new Error('server not healthy')) : setTimeout(tick, 400));
    tick();
  });

  try {
    await waitHealthy();
    const profile = fs.mkdtempSync('/tmp/staychat-shot-profile.');
    const cport = await freePort();
    const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-popup-blocking',
      `--user-data-dir=${profile}`, `--remote-debugging-port=${cport}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
    try {
      let up = false;
      for (let i = 0; i < 40 && !up; i++) {
        try { const v = await fetch(`http://localhost:${cport}/json/version`).then(r => r.json()); up = !!v.webSocketDebuggerUrl; }
        catch (e) { /* not up yet */ }
        if (!up) await sleep(250);
      }
      if (!up) throw new Error('chromium DevTools never came up');
      const list = await fetch(`http://localhost:${cport}/json`).then(r => r.json());
      const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
      await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
      let id = 0; const pending = new Map();
      ws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
      const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
      const evl = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.value; };

      await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await evl(`location.href = '${BASE}/app'`).catch(() => {});
      await waitFor(evl, `location.href`, `${BASE}/app`);
      await sleep(1500);
      const login = await evl(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '${adminEmail}', password: 'Demo@123456' }) }).then(r => r.status)`);
      if (login !== 200) throw new Error('login failed: ' + login);
      const ready = await waitFor(evl, `(() => {
        if (window.App && App.user && Array.isArray(App.permissions) && App.permissions.length > 0) return true;
        const now = Date.now();
        if (!window.__mcLastRestore || now - window.__mcLastRestore > 700) {
          window.__mcLastRestore = now;
          try { Promise.resolve(tryRestoreSession()).catch(() => {}); } catch (e) {}
        }
        return false;
      })()`, true, 20000);
      if (!ready) throw new Error('session never became ready');

      const shot = async (name) => {
        await sleep(700);
        const r = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
        console.log('  → ' + name);
      };

      // 1. Terminal picker (both cards, each previewing its outlet)
      await evl(`navigate('pos')`); await sleep(1400);
      await shot('pos-terminals-picker.png');

      // 2. Restaurant terminal board
      await evl(`navigate('posRestaurant')`); await sleep(1600);
      await shot('pos-terminal-restaurant.png');

      // 3. Restaurant ticket modal (product grid + receipt panel)
      await evl(`(async () => { const ts = await API.get('/api/pos/tickets'); const t = ts.find(x => x.outlet === 'restaurant'); await window.__posOpenTicket(t.id); return true; })()`);
      await sleep(1500);
      await shot('pos-terminal-restaurant-ticket.png');
      await evl(`closeModal()`);

      // 4. Bar terminal board
      await evl(`navigate('posBar')`); await sleep(1600);
      await shot('pos-terminal-bar.png');

      // 5. Bar ticket modal
      await evl(`(async () => { const ts = await API.get('/api/pos/tickets'); const t = ts.find(x => x.outlet === 'bar'); await window.__posOpenTicket(t.id); return true; })()`);
      await sleep(1500);
      await shot('pos-terminal-bar-ticket.png');
    } finally {
      try { chrome.kill(); } catch (e) {}
      await new Promise(res => { const t = setTimeout(res, 3000); chrome.once('exit', () => { clearTimeout(t); res(); }); });
    }
  } finally {
    try { srv.kill(); } catch (e) {}
  }
  console.log('✓ 5 terminal shots written to ' + OUT);
})().catch(e => { console.error(e); process.exit(1); });
