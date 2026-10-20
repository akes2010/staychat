#!/usr/bin/env node
// scripts/browser-test-changepw.js — the account menu's "🔒 Change password"
// must actually change the signed-in superadmin's password.
//
// Regression: POST /api/auth/change-password existed server-side (requireAuth
// only) but NOTHING in the app ever called it — no signed-in user, superadmin
// included, could change their own password in-app. This suite drives the real
// menu → modal flow in headless Chromium on a scratch DB copy and proves the
// password really rotates: the old one must 401 afterwards, the new one must
// sign in. Modelled on browser-test-logout.js (same CDP harness).
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 4323;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-cpw-profile';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (evl, expr, want, timeoutMs = 15000) => {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await evl(expr);
    if (last === want) return last;
    await sleep(250);
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
      try { const v = await fetch('http://localhost:9229/json/version').then(r => r.json()); devtoolsUp = !!v.webSocketDebuggerUrl; }
      catch (e) { await sleep(250); }
    }
    if (!devtoolsUp) throw new Error('our chromium DevTools endpoint never came up');
    const list = await fetch('http://localhost:9229/json').then(r => r.json());
    const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map();
    ws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evl = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.value; };
    return await fn({ evl });
  } finally {
    try { chrome.kill(); } catch (e) {}
    await new Promise(res => { const t = setTimeout(res, 3000); chrome.once('exit', () => { clearTimeout(t); res(); }); });
  }
}

const loginAs = async (evl, email, passw) => {
  // Wait for the shell's JS to be wired before driving the form — on a cold
  // server the first page load outlasts a fixed sleep and doLogin() would
  // silently no-op (the exact race that made this suite flake at 12:51).
  const ready = await waitFor(evl, `typeof doLogin === 'function' && typeof App !== 'undefined' && !!document.getElementById('auth-email')`, true, 20000);
  if (ready !== true) return false;
  await evl(`(document.getElementById('auth-email')||{}).value = '${email}'`);
  await evl(`document.getElementById('auth-pass').value = '${passw}'`);
  await evl(`doLogin()`);
  const got = await waitFor(evl, `App.user && App.user.email`, email, 12000);
  return got === email;
};
const lastToast = (evl) => evl(`(function(){ var t=document.querySelectorAll('#toast-area > *'); return t.length ? t[t.length-1].textContent : ''; })()`);

(async () => {
  const dataDir = fs.mkdtempSync('/tmp/staychat-cpw.');
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
    await withBrowser(async ({ evl }) => {
      console.log('── Sign in as superadmin ──');
      await evl(`location.href = '${BASE}/app'`).catch(() => {});
      await sleep(1500);
if (!(await loginAs(evl, 'superadmin@staychat.io', 'Demo@123456'))) {
        bad('superadmin could not sign in — aborting, the rest would only noise up the output');
        return;
      }
      ok('signed in as superadmin@staychat.io');

      console.log('── Account menu must offer "🔒 Change password" ──');
      await evl(`openUserMenu()`);
      await sleep(300);
      const hasItem = await evl(`!!Array.from(document.querySelectorAll('#user-menu .user-menu-item')).find(b => /Change password/.test(b.textContent))`);
      hasItem === true ? ok('account menu shows the "🔒 Change password" item') : bad('no Change password item in the account menu');
      await evl(`(Array.from(document.querySelectorAll('#user-menu .user-menu-item')).find(b => /Change password/.test(b.textContent))||{click:function(){}}).click()`);
      await sleep(400);
      const modalOpen = await evl(`!!document.getElementById('cp-current') && !!document.getElementById('cp-new') && !!document.getElementById('cp-confirm')`);
      modalOpen === true ? ok('modal opens with current/new/repeat fields') : bad('change-password modal did not open (fields missing)');

      console.log('── Validation: weak new password is refused client-side ──');
      await evl(`document.getElementById('cp-current').value='Demo@123456';document.getElementById('cp-new').value='short';document.getElementById('cp-confirm').value='short';document.getElementById('cp-save').click()`);
      await sleep(500);
      const weakToast = await lastToast(evl);
      const stillOpen = await evl(`!!document.getElementById('cp-new')`);
      (/8\+/.test(weakToast || '') && stillOpen === true)
        ? ok('weak password rejected with guidance, modal stays open') : bad('weak password not blocked: toast=' + JSON.stringify(weakToast));

      console.log('── Wrong current password is refused by the server ──');
      await evl(`document.getElementById('cp-current').value='NotThePass1!';document.getElementById('cp-new').value='CpwTest!2026x';document.getElementById('cp-confirm').value='CpwTest!2026x';document.getElementById('cp-save').click()`);
      const wrongCur = await waitFor(evl, `(function(){var t=document.querySelectorAll('#toast-area > *');return t.length?/current password is incorrect/i.test(t[t.length-1].textContent):false})()`, true, 10000);
      wrongCur === true ? ok('server rejects wrong current password (401 surfaced as toast)') : bad('wrong current password was not rejected');
      const stillIn = await evl(`App.user ? 'in' : 'out'`);
      stillIn === 'in' ? ok('session survives the failed attempt') : bad('user was signed out by a failed change');

      console.log('── Real change: correct current + strong new password ──');
      await evl(`document.getElementById('cp-current').value='Demo@123456';document.getElementById('cp-new').value='CpwTest!2026x';document.getElementById('cp-confirm').value='CpwTest!2026x';document.getElementById('cp-save').click()`);
      const out = await waitFor(evl, `(App.user ? 'in' : 'out')`, 'out', 12000);
      out === 'out' ? ok('password changed and user signed out to apply it') : bad('user still signed in after successful change');

      console.log('── New password must actually work; old one must not ──');
      const oldRejected = !(await loginAs(evl, 'superadmin@staychat.io', 'Demo@123456'));
      await sleep(800); // let any error toast land before the next attempt
      oldRejected ? ok('OLD password now rejected (HTTP 401 path)') : bad('OLD password still works — change did not persist');
      (await loginAs(evl, 'superadmin@staychat.io', 'CpwTest!2026x'))
        ? ok('NEW password signs the superadmin in') : bad('NEW password does not work');
    });      console.log('\n' + (fail === 0 ? '═══ CHANGE-PASSWORD UI: ' + pass + ' passed, 0 failed ═══' : '═══ CHANGE-PASSWORD UI: ' + fail + ' FAILED ═══'));
      process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    try { srv.kill(); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('✗', e.message); process.exit(1); });
