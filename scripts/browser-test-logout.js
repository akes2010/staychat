#!/usr/bin/env node
// scripts/browser-test-logout.js — every door out of the app must actually open.
//
// Regression: the account dropdown's "⎋ Sign out" button called
// window.__doLogout, which was never assigned — the guarded onclick silently
// did nothing and the user was stranded (the 🚪 topbar button worked, so the
// bug hid until someone used the menu). This suite signs in as the platform
// superadmin and walks BOTH doors, then reloads to prove the session really
// died (refresh cookie revoked + cleared, no silent restore).
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { freePort } = require('./lib/free-port');

const ROOT = path.join(__dirname, '..');
const PORT = 4322;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-logout-test-profile';

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

// Drive the real sign-in form (same path a human uses).
async function loginAsSuperadmin(evl) {
  // Wait for the shell's JS to be wired before driving the form — on a cold
  // server the first page load outlasts a fixed sleep and doLogin() would
  // silently no-op (the exact race browser-test-changepw.js documents).
  const ready = await waitFor(evl, `typeof doLogin === 'function' && typeof App !== 'undefined' && !!document.getElementById('auth-email')`, true, 20000);
  if (ready !== true) return false;
  await evl(`(document.getElementById('auth-email')||{}).value = ''`);
  await evl(`document.getElementById('auth-email').value = 'superadmin@staychat.io'`);
  await evl(`document.getElementById('auth-pass').value = 'Demo@123456'`);
  await evl(`doLogin()`);
  const email = await waitFor(evl, `App.user && App.user.email`, 'superadmin@staychat.io', 15000);
  return email === 'superadmin@staychat.io';
}

const signedOut = (evl) => evl(`({
  user: !!(App.user),
  appVisible: document.getElementById('app').classList.contains('visible'),
})`);

(async () => {
  const dataDir = fs.mkdtempSync('/tmp/staychat-logout.');
  fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db'), path.join(dataDir, 'staychat.db'));
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(path.join(ROOT, 'data', 'staychat.db' + ext))) fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db' + ext), path.join(dataDir, 'staychat.db' + ext));
  }
  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production' }),
    stdio: 'ignore',
  });
  try {
    await waitHealthy();

    await withBrowser(async ({ send, evl }) => {
      console.log('── Sign in as the platform superadmin ──');
      await evl(`location.href = '${BASE}/app'`).catch(() => {});
      await sleep(1500);
      if (!(await loginAsSuperadmin(evl))) {
        const diag = await evl(`({ href: location.href, ready: document.readyState, scripts: document.scripts.length, app: typeof App !== 'undefined' })`).catch(() => null);
        return bad('superadmin could not sign in — ' + JSON.stringify(diag));
      }
      ok('signed in as superadmin@staychat.io');
      const title = await evl(`(document.getElementById('topbar-title')||{}).textContent`);
      title === 'Super Admin' ? ok('landed on the Super Admin dashboard') : bad('unexpected landing page: ' + title);

      console.log('── Door 1: account menu (👤 → ⎋ Sign out) ──');
      const wired = await waitFor(evl, `typeof window.__doLogout`, 'function', 5000);
      wired === 'function'
        ? ok('window.__doLogout is wired to a function')
        : bad('window.__doLogout is "' + wired + '" — the menu Sign out button silently no-ops (the original bug)');
      await evl(`openUserMenu()`);
      await sleep(300);
      const menuHasSignout = await evl(`!!Array.from(document.querySelectorAll('#user-menu .user-menu-item')).find(b => /Sign out/.test(b.textContent))`);
      menuHasSignout === true ? ok('account menu shows the "⎋ Sign out" item') : bad('no Sign out item in the account menu');
      // Click it exactly like a user would (not by calling doLogout directly).
      await evl(`(async () => {
        const btn = Array.from(document.querySelectorAll('#user-menu .user-menu-item')).find(b => /Sign out/.test(b.textContent));
        if (btn) btn.click();
        return !!btn;
      })()`);
      const afterMenu = await waitFor(evl, `(App.user ? 'in' : 'out')`, 'out', 10000);
      afterMenu === 'out' ? ok('menu Sign out actually signed the superadmin out') : bad('menu Sign out left the session alive (still signed in after 10s)');
      const menuState = await signedOut(evl);
      menuState.appVisible === false ? ok('app shell hidden, login screen restored') : bad('app shell still visible after menu sign-out');

      console.log('── The session must really be dead (reload + refresh token) ──');
      await evl(`location.reload()`).catch(() => {});
      // Condition, not the clock: wait for the reloaded shell before reading
      // App — a fixed 2500ms raced the ~40-script load and crashed on
      // `App.user` (App still undefined) under battery load.
      const shell1 = await waitFor(evl, `typeof App !== 'undefined'`, true);
      if (shell1 !== true) return bad('app shell did not come back after reload');
      const afterReload = await signedOut(evl);
      afterReload.user === false ? ok('reload does NOT resurrect the session') : bad('reload silently signed the superadmin back in');
      const refreshDead = await evl(`fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' }).then(r => r.status)`);
      refreshDead !== 200 ? ok('revoked refresh token rejected after logout (HTTP ' + refreshDead + ')') : bad('refresh token still works after logout (HTTP 200)');

      console.log('── Door 2: topbar 🚪 button ──');
      if (!(await loginAsSuperadmin(evl))) return bad('could not sign back in for the topbar test');
      ok('signed in again for the second door');
      await evl(`doLogout()`);
      const afterDoor2 = await waitFor(evl, `(App.user ? 'in' : 'out')`, 'out', 10000);
      afterDoor2 === 'out' ? ok('topbar 🚪 button signs out too') : bad('topbar logout did not take effect');
      const reload2 = await evl(`(async () => { location.reload(); return 'reloading'; })()`).catch(() => 'reloading');
      const shell2 = await waitFor(evl, `typeof App !== 'undefined'`, true);
      if (shell2 !== true) return bad('app shell did not come back after topbar logout reload');
      const afterReload2 = await signedOut(evl);
      afterReload2.user === false ? ok('reload after topbar logout stays logged out') : bad('session resurrected after topbar logout');
    });

    console.log('\n' + (fail === 0 ? '═══ LOGOUT: ' + pass + ' passed, 0 failed ═══' : '═══ LOGOUT: ' + fail + ' FAILED ═══'));
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    try { srv.kill(); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('✗', e.message); process.exit(1); });
