#!/usr/bin/env node
// scripts/browser-test-tenant-branding.js — UI verification for the tenant
// branding settings (logo upload + phone + address) through the interface the
// admin actually uses.
//
// Boots a throwaway server (fresh DB, pro-plan tenant + hotel admin), signs in
// inside headless Chromium, then asserts through the app's own code path:
//   • Settings → "Tenant Branding" card exists with phone/address inputs,
//   • Save Branding persists phone + address (server round-trip),
//   • a real image File picked through the file input uploads as a base64 data
//     URL, shows in the card preview AND paints into the sidebar logo slot,
//   • Save All Changes carries the branding too,
//   • after a full reload the logo is still in the sidebar (login payload),
//   • Remove Logo clears it everywhere.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 4320;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-branding-test-profile';

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
  for (let i = 0; i < 20; i++) {
    try { await fetch('http://localhost:9233/json/version'); throw new Error('port 9233 busy'); }
    catch (e) { if (e instanceof TypeError) break; await sleep(250); }
  }
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-popup-blocking',
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=9233', 'about:blank'], { stdio: 'ignore' });
  try {
    let devtoolsUp = false;
    for (let i = 0; i < 40 && !devtoolsUp; i++) {
      try {
        const v = await fetch('http://localhost:9233/json/version').then(r => r.json());
        devtoolsUp = !!v.webSocketDebuggerUrl;
      } catch (e) { await sleep(250); }
    }
    if (!devtoolsUp) throw new Error('chromium DevTools endpoint never came up');
    const list = await fetch('http://localhost:9233/json').then(r => r.json());
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
  // ── Fresh DB with a pro-plan tenant + hotel admin ───────────────────────
  const dataDir = fs.mkdtempSync('/tmp/staychat-branding.');
  process.env.DATA_DIR = dataDir;
  const db = require(path.join(ROOT, 'server', 'db', 'connection'));
  require(path.join(ROOT, 'server', 'db', 'migrate'));
  const { nanoid } = require('nanoid');
  const bcrypt = require('bcryptjs');
  const tenantId = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?, 'pro', 'active')`)
    .run(tenantId, 'Branding UI Hotel', 'brandui-' + nanoid(5));
  const adminEmail = ('brandadmin-' + nanoid(4) + '@brand.test').toLowerCase();
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?, 'hotel_admin')`)
    .run('user_' + nanoid(8), tenantId, 'Brand Admin', adminEmail, bcrypt.hashSync('Demo@123456', 8));
  db.close();

  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'development' }),
    stdio: 'ignore',
  });
  try {
    await waitHealthy();

    await withBrowser(async ({ evl }) => {
      await evl(`location.href = '${BASE}/app'`).catch(() => {});
      const landed = await waitFor(evl, `location.href`, `${BASE}/app`);
      if (landed !== `${BASE}/app`) return bad('never reached the app — at ' + landed);
      await sleep(1200);

      const login = await evl(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '${adminEmail}', password: 'Demo@123456' }) }).then(r => r.status)`).catch(() => 0);
      if (login !== 200) return bad('admin login failed (HTTP ' + login + ')');
      ok('hotel admin signed in inside the browser');
      await evl(`tryRestoreSession()`);
      // Condition, not the clock: navigate() is capability-gated. The boot path
      // also restores (app.js), so under battery load one attempt can lose the
      // refresh-token rotation race and get swallowed — RETRY (throttled; failed
      // refreshes never rotate tokens, so this is safe) until actually ready.
      const ready = await waitFor(evl, `(() => {
        if (window.App && App.user && Array.isArray(App.permissions) && App.permissions.length > 0) return true;
        const now = Date.now();
        if (!window.__mcLastRestore || now - window.__mcLastRestore > 700) {
          window.__mcLastRestore = now;
          try { Promise.resolve(tryRestoreSession()).catch(() => {}); } catch (e) {}
        }
        return false;
      })()`, true, 20000);
      if (!ready) {
        const diag = await evl(`({ user: !!(window.App && App.user), perms: ((window.App && App.permissions) || []).length, appVisible: document.getElementById('app').classList.contains('visible') })`);
        return bad('session/permissions never became ready — ' + JSON.stringify(diag));
      }

      // ── 1. Settings → Tenant Branding card ──────────────────────────────
      await evl(`navigate('settings')`); await sleep(900);
      const cardTitle = await waitFor(evl, `Array.from(document.querySelectorAll('#content .card-title')).some(c => c.textContent === 'Tenant Branding')`, true);
      if (cardTitle) ok('Settings shows the "Tenant Branding" card');
      else bad('Tenant Branding card missing');
      const fields = await evl(`({
        phone: !!document.getElementById('set-phone'),
        address: !!document.getElementById('set-address'),
        upload: !!document.querySelector('#content input[type=file]'),
        saveBtn: !!Array.from(document.querySelectorAll('#content button')).find(b => b.textContent.trim() === 'Save Branding'),
      })`);
      if (fields && fields.phone && fields.address && fields.upload && fields.saveBtn) {
        ok('card has phone, address, logo picker and its own Save button');
      } else bad('branding fields missing — ' + JSON.stringify(fields));

      // ── 2. Save Branding → server round-trip ────────────────────────────
      await evl(`(() => {
        document.getElementById('set-phone').value = '+234 801 999 7777';
        document.getElementById('set-address').value = '14 Adeola Odeku Street, Victoria Island';
      })()`);
      await evl(`(() => {
        Array.from(document.querySelectorAll('#content button')).find(b => b.textContent.trim() === 'Save Branding').click();
      })()`);
      const saved = await waitFor(evl, `API.get('/api/settings').then(s => s.phone === '+234 801 999 7777' && s.address === '14 Adeola Odeku Street, Victoria Island')`, true);
      if (saved) ok('Save Branding persists phone + address (server round-trip)');
      else bad('phone/address did not persist');

      // ── 3. Logo upload through the real file input ──────────────────────
      // Hand the input a genuine File object (built in-page from a real 1×1
      // PNG) via DataTransfer, then fire the change event the user would.
      const picked = await evl(`(async () => {
        const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const file = new File([arr], 'hotel-logo.png', { type: 'image/png' });
        const dt = new DataTransfer();
        dt.items.add(file);
        const input = document.querySelector('#content input[type=file]');
        if (!input) return 'no-input';
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
        return 'dispatched';
      })()`);
      if (picked !== 'dispatched') return bad('file input not found — ' + picked);
      const logoUp = await waitFor(evl, `API.get('/api/settings').then(s => !!(s.logo && s.logo.indexOf('data:image/') === 0))`, true);
      if (logoUp) ok('logo uploaded as a base64 data URL (server round-trip)');
      else bad('logo did not persist');
      const preview = await waitFor(evl, `!!document.querySelector('#tb-logo-preview img')`, true);
      if (preview) ok('card preview shows the uploaded logo');
      else bad('preview image missing');
      const sidebarNow = await waitFor(evl, `!!document.querySelector('.sb-logo-icon img')`, true);
      if (sidebarNow) ok('sidebar logo slot paints the uploaded logo immediately');
      else bad('sidebar logo not applied');

      // ── 4. Save All Changes carries branding too ────────────────────────
      await evl(`(() => {
        document.getElementById('set-address').value = '14 Adeola Odeku Street, Victoria Island, Lagos';
        Array.from(document.querySelectorAll('#content button')).find(b => b.textContent.trim() === 'Save All Changes').click();
      })()`);
      const saveAll = await waitFor(evl, `API.get('/api/settings').then(s => s.address === '14 Adeola Odeku Street, Victoria Island, Lagos')`, true);
      if (saveAll) ok('page-wide Save All Changes also saves the branding fields');
      else bad('Save All Changes did not carry the address');

      // ── 5. Full reload: login payload keeps the logo ────────────────────
      await evl(`location.reload()`).catch(() => {});
      await sleep(1800);
      await evl(`tryRestoreSession()`); await sleep(1500);
      const restored = await waitFor(evl, `!!(window.App && App.user)`, true, 10000);
      if (!restored) return bad('session did not survive the reload');
      const sidebarAfter = await waitFor(evl, `!!document.querySelector('.sb-logo-icon img')`, true);
      if (sidebarAfter) ok('after reload the sidebar still shows the logo (login payload)');
      else bad('logo lost after reload');
      await evl(`navigate('settings')`); await sleep(900);
      const persistedFields = await evl(`({
        phone: (document.getElementById('set-phone') || {}).value,
        address: (document.getElementById('set-address') || {}).value,
      })`);
      if (persistedFields && persistedFields.phone === '+234 801 999 7777' && String(persistedFields.address).indexOf('Victoria Island') !== -1) {
        ok('phone + address come back prefilled after reload');
      } else bad('saved branding not prefilled — ' + JSON.stringify(persistedFields));

      // ── 6. Remove Logo clears everywhere ────────────────────────────────
      const removed = await evl(`window.__tenantLogoRemove()`); // async handler
      const logoGone = await waitFor(evl, `API.get('/api/settings').then(s => !s.logo)`, true);
      const sidebarGone = await waitFor(evl, `!document.querySelector('.sb-logo-icon img')`, true);
      if (logoGone && sidebarGone) ok('Remove Logo clears the server value and restores the default sidebar bubble');
      else bad('logo removal incomplete — server=' + logoGone + ' sidebarImgGone=' + sidebarGone);
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
