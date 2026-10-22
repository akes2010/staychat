#!/usr/bin/env node
// scripts/browser-test-gym.js — UI verification for the Gym Management &
// Booking module through the interface staff actually use.
//
// Boots a throwaway server (fresh DB, seeded pro-plan tenant + hotel admin),
// signs in inside headless Chromium, then asserts through the app's own code
// path:
//   • the sidebar renders the "Gym & Fitness" nav item and opens the page,
//   • Manage Gyms creates a gym (name/type/facilities/capacity/daily-monthly-
//     yearly prices) and the page re-renders it,
//   • New Registration registers a member with the price auto-filled from the
//     gym's registration price for the chosen type.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 4317;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-gym-test-profile';

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
    try { await fetch('http://localhost:9230/json/version'); throw new Error('port 9230 busy'); }
    catch (e) { if (e instanceof TypeError) break; await sleep(250); }
  }
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-popup-blocking',
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=9230', 'about:blank'], { stdio: 'ignore' });
  try {
    let devtoolsUp = false;
    for (let i = 0; i < 40 && !devtoolsUp; i++) {
      try {
        const v = await fetch('http://localhost:9230/json/version').then(r => r.json());
        devtoolsUp = !!v.webSocketDebuggerUrl;
      } catch (e) { await sleep(250); }
    }
    if (!devtoolsUp) throw new Error('chromium DevTools endpoint never came up');
    const list = await fetch('http://localhost:9230/json').then(r => r.json());
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
  // ── Fresh DB with a pro-plan tenant (gym_bookings entitlement) + admin ──
  const dataDir = fs.mkdtempSync('/tmp/staychat-gym.');
  process.env.DATA_DIR = dataDir;
  const db = require(path.join(ROOT, 'server', 'db', 'connection'));
  require(path.join(ROOT, 'server', 'db', 'migrate'));
  const { nanoid } = require('nanoid');
  const bcrypt = require('bcryptjs');
  const tenantId = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?, 'pro', 'active')`)
    .run(tenantId, 'Gym UI Hotel', 'gymui-' + nanoid(5));
  // lowercase like the app itself stores emails — login lookup is case-insensitive
  const adminEmail = ('gymadmin-' + nanoid(4) + '@gym.test').toLowerCase();
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?, 'hotel_admin')`)
    .run('user_' + nanoid(8), tenantId, 'Gym Admin', adminEmail, bcrypt.hashSync('Demo@123456', 8));
  db.close();

  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'development' }),
    stdio: 'ignore',
  });
  try {
    await waitHealthy();

    await withBrowser(async ({ evl }) => {
      await evl(`location.href = '${BASE}/app'`).catch(() => {});
      // Wait for the SPA to actually land before touching it — a fixed sleep
      // raced the navigation and fired the login from about:blank.
      const landed = await waitFor(evl, `location.href`, `${BASE}/app`);
      if (landed !== `${BASE}/app`) return bad('never reached the app — at ' + landed);
      await sleep(1200);

      // Sign in from the page itself so the httpOnly cookies land in the jar.
      const login = await evl(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '${adminEmail}', password: 'Demo@123456' }) }).then(async r => r.status + ' ' + await r.text())`);
      if (!String(login).startsWith('200')) return bad('admin login failed — ' + login + ' (href=' + (await evl('location.href')) + ')');
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

      // ── 1. Sidebar shows the module ──────────────────────────────────
      const navInfo = await evl(`(() => {
        const b = document.querySelector('.nav-item[data-page="gym"]');
        return b ? { label: b.textContent.trim(), visible: b.offsetParent !== null } : null;
      })()`);
      if (navInfo && navInfo.label.includes('Gym') && navInfo.visible) ok('sidebar renders the "Gym & Fitness" nav item');
      else bad('sidebar gym nav item missing — ' + JSON.stringify(navInfo));

      // ── 2. Opening the page via the app's own navigation ─────────────
      await evl(`navigate('gym')`); await sleep(800);
      const title = await evl(`document.getElementById('topbar-title').textContent`);
      if (title === 'Gym & Fitness') ok('navigate("gym") sets the topbar title');
      else bad('topbar title wrong — ' + title);
      const empty = await evl(`document.getElementById('content').textContent`);
      if (empty.includes('No gyms set up yet')) ok('fresh gym page shows the empty state');
      else bad('empty state missing — ' + (empty || '').slice(0, 80));

      // ── 3. Manage Gyms → create a gym with every required field ──────
      await evl(`window.__manageGyms()`); await sleep(400);
      const formUp = await evl(`!!document.getElementById('ag-name')`);
      if (formUp) ok('Manage Gyms modal opens with the add-gym form');
      else bad('add-gym form did not open');

      await evl(`(() => {
        document.getElementById('ag-name').value = 'Sky Fitness Centre';
        document.getElementById('ag-type').value = 'Premium';
        document.getElementById('ag-cap').value = '6';
        document.getElementById('ag-daily').value = '10';
        document.getElementById('ag-monthly').value = '80';
        document.getElementById('ag-yearly').value = '800';
        document.getElementById('ag-fac-0').checked = true;   // Free Weights
        document.getElementById('ag-fac-3').checked = true;   // Sauna
        document.getElementById('ag-desc').value = 'Rooftop gym';
      })()`);
      await evl(`window.__addGym()`);
      const gymsLoaded = await waitFor(evl, `API.get('/api/gym/gyms').then(g => g.length)`, 1);
      if (gymsLoaded === 1) ok('gym created via the UI (API shows 1 gym)');
      else bad('gym did not persist — count=' + gymsLoaded);

      const gymFields = await evl(`API.get('/api/gym/gyms').then(g => g[0])`);
      if (gymFields && gymFields.name === 'Sky Fitness Centre' && gymFields.type === 'Premium' &&
          gymFields.capacity === 6 && gymFields.price_daily === 10 && gymFields.price_monthly === 80 &&
          gymFields.price_yearly === 800 && Array.isArray(gymFields.facilities) && gymFields.facilities.length === 2) {
        ok('name/type/facilities/capacity/daily-monthly-yearly prices all round-trip');
      } else bad('gym fields wrong — ' + JSON.stringify(gymFields));

      await evl(`closeModal()`); await sleep(300);
      const pageShowsGym = await evl(`document.getElementById('content').textContent`);
      if (pageShowsGym.includes('Sky Fitness Centre')) ok('gym page re-renders with the new gym');
      else bad('gym card missing from the page');

      // ── 4. New Registration with price auto-fill ─────────────────────
      await evl(`window.__openNewGymRegistration()`); await sleep(400);
      const dailyAuto = await evl(`document.getElementById('gr-amount') && document.getElementById('gr-amount').value`);
      if (String(dailyAuto) === '10') ok('daily price auto-fills (10)');
      else bad('daily auto-fill wrong — ' + dailyAuto);

      await evl(`(() => {
        const t = document.getElementById('gr-type');
        t.value = 'monthly';
        window.__gymPicked();
      })()`);
      const monthlyAuto = await evl(`document.getElementById('gr-amount').value`);
      if (String(monthlyAuto) === '80') ok('monthly price auto-fills when type changes (80)');
      else bad('monthly auto-fill wrong — ' + monthlyAuto);

      await evl(`(() => {
        document.getElementById('gr-name').value = 'Ada Obi';
        document.getElementById('gr-phone').value = '+2348012345678';
      })()`);
      await evl(`window.__submitGymRegistration()`);
      const regs = await waitFor(evl, `API.get('/api/gym/registrations').then(r => r.length)`, 1);
      if (regs === 1) ok('registration created via the UI (API shows 1 registration)');
      else bad('registration did not persist — count=' + regs);

      const reg = await evl(`API.get('/api/gym/registrations').then(r => r[0])`);
      // monthly → end = start + 1 calendar month − 1 day (same math as the route)
      let expectedEnd = null;
      if (reg) {
        const d = new Date(reg.start_date + 'T00:00:00Z');
        const day = d.getUTCDate();
        d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
        const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        d.setUTCDate(Math.min(day, last));
        d.setUTCDate(d.getUTCDate() - 1);
        expectedEnd = d.toISOString().slice(0, 10);
      }
      if (reg && reg.member_name === 'Ada Obi' && reg.registration_type === 'monthly' && reg.amount === 80 && reg.status === 'active' && reg.end_date === expectedEnd) {
        ok('registration row carries member/type/amount + correct monthly period (ends ' + expectedEnd + ')');
      } else bad('registration fields wrong — ' + JSON.stringify(reg) + ' expectedEnd=' + expectedEnd);

      await sleep(600);
      const pageText = await evl(`document.getElementById('content').textContent`);
      if (pageText.includes('Ada Obi') && pageText.includes('Monthly')) ok('gym page lists the member registration');
      else bad('registration row missing from the page — ' + (pageText || '').slice(0, 120));
    });
  } finally {
    try { srv.kill(); } catch (e) {}
    fs.rmSync(dataDir, { recursive: true, force: true });
    // Chromium can still be flushing profile files right after kill() — retry.
    for (let i = 0; i < 5; i++) {
      try { fs.rmSync(PROFILE, { recursive: true, force: true }); break; }
      catch (e) { await sleep(400); }
    }
  }

  console.log('\n' + (fail ? '✗ ' + fail + ' check(s) FAILED, ' + pass + ' passed' : '✓ ALL ' + pass + ' CHECKS PASSED'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
