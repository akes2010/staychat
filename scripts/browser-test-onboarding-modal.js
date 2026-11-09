#!/usr/bin/env node
// scripts/browser-test-onboarding-modal.js — the first-run training-pack nudge
// must never replace a modal the admin already has open.
//
// Regression (BTS-050): maybeShowManualOnboarding() fired 1.8s after sign-in
// and called openModal() unconditionally, wiping whatever the admin had open —
// a gym registration being typed, a ticket mid-settlement. It now waits for
// #modal-container to go idle (bounded), and refuses to fire once the admin has
// signed out. This suite drives the real function on the real page and asserts:
//   • a probe modal + its typed input survive the nudge window untouched,
//   • the deferred nudge DOES appear once the slot goes idle (not dropped),
//   • once shown, it never opens again on that device — not on a second call,
//     not after a page reload (the flag is localStorage, so it must persist),
//   • a nudge pending at sign-out never lands on the sign-in screen.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { freePort } = require('./lib/free-port');

const ROOT = path.join(__dirname, '..');
const PORT = 4333; // unique — every suite must own its port
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-onboarding-test-profile';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (evl, expr, want, timeoutMs = 8000) => {
  const t0 = Date.now(); let last;
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

// The nudge's own copy, so a wording tweak cannot silently green this suite.
const ONBOARDING_TITLE = 'Start your team on the right foot';
const titleNow = `((document.querySelector('#modal-container .modal-title')||{}).textContent||'')`;

(async () => {
  // ── Fresh DB + a hotel admin (the only role the nudge targets) ─────────
  const dataDir = fs.mkdtempSync('/tmp/staychat-onboarding.');
  process.env.DATA_DIR = dataDir;
  const db = require(path.join(ROOT, 'server', 'db', 'connection'));
  require(path.join(ROOT, 'server', 'db', 'migrate'));
  const { nanoid } = require('nanoid');
  const bcrypt = require('bcryptjs');
  const tenantId = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?, 'pro', 'active')`)
    .run(tenantId, 'Onboarding UI Hotel', 'onbui-' + nanoid(5));
  const adminEmail = ('onbadmin-' + nanoid(4) + '@onb.test').toLowerCase();
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?, 'hotel_admin')`)
    .run('user_' + nanoid(8), tenantId, 'Onboarding Admin', adminEmail, bcrypt.hashSync('Demo@123456', 8));
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

      const login = await evl(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '${adminEmail}', password: 'Demo@123456' }) }).then(async r => r.status + ' ' + await r.text())`);
      if (!String(login).startsWith('200')) return bad('admin login failed — ' + login + ' (href=' + (await evl('location.href')) + ')');
      ok('hotel admin signed in inside the browser');
      await evl(`tryRestoreSession()`);
      const ready = await waitFor(evl, `(() => {
        if (window.App && App.user && Array.isArray(App.permissions) && App.permissions.length > 0) return true;
        const now = Date.now();
        if (!window.__obLastRestore || now - window.__obLastRestore > 700) {
          window.__obLastRestore = now;
          try { Promise.resolve(tryRestoreSession()).catch(() => {}); } catch (e) {}
        }
        return false;
      })()`, true, 20000);
      if (!ready) {
        const diag = await evl(`({ user: !!(window.App && App.user), perms: ((window.App && App.permissions) || []).length })`);
        const refresh = await evl(`fetch('/api/auth/refresh', { method: 'POST' }).then(async r => r.status + ' ' + (await r.text()).slice(0, 120)).catch(e => 'ERR ' + e.message)`);
        return bad('session never became ready — ' + JSON.stringify(diag) + ' refresh=' + refresh);
      }
      ok('session restored with the hotel admin\'s permissions');

      // ── 1. An open modal is never replaced ────────────────────────────────
      // Reset the once-per-device flag and clear anything the login-path nudge
      // already put up, then arm a fresh nudge against an open probe form.
      await evl(`localStorage.removeItem('sc_manual_onboarding_v1'); closeModal()`);
      await sleep(200);
      await evl(`openModal('New gym registration',
        '<label class="form-label">Daily price</label><input class="form-input" id="probe-field" value="half-typed">',
        '<button class="btn ghost" onclick="closeModal()">Cancel</button>')`);
      await evl(`maybeShowManualOnboarding()`);
      ok('nudge armed while a registration form is open');

      // Past the 1.8s fire and at least one 750ms retry — the old code had
      // already clobbered the form by now.
      await sleep(3400);
      const during = await evl(`(() => ({
        title: ${titleNow},
        field: (document.getElementById('probe-field') || {}).value,
        modals: document.querySelectorAll('#modal-container .modal').length,
      }))()`);
      during.title === 'New gym registration' && during.field === 'half-typed'
        ? ok('open registration form survives the nudge window untouched')
        : bad('the nudge replaced the open form — ' + JSON.stringify(during));
      during.title !== ONBOARDING_TITLE
        ? ok('training-pack nudge did not open over the form')
        : bad('training-pack nudge clobbered the open form');
      during.modals === 1
        ? ok('exactly one modal on screen (no stacked overlays)')
        : bad('modal stack depth wrong — ' + during.modals);

      // ── 2. Deferred, not dropped: it lands once the slot is idle ──────────
      await evl(`closeModal()`);
      const appeared = await waitFor(evl, `${titleNow} === ${JSON.stringify(ONBOARDING_TITLE)}`, true, 5000);
      appeared === true
        ? ok('deferred nudge appears once the modal slot goes idle')
        : bad('deferred nudge never appeared after the form closed — ' + JSON.stringify(await evl(titleNow)));

      // ── 3. Once per device: it must not open a second time ────────────────
      await evl(`closeModal()`);
      const keySet = await evl(`localStorage.getItem('sc_manual_onboarding_v1') === '1'`);
      keySet === true
        ? ok('device flag set once the nudge has been shown')
        : bad('device flag missing after the nudge was shown — it will repeat');
      await evl(`maybeShowManualOnboarding()`);
      await sleep(3200); // past a fresh 1.8s fire — nothing should appear
      const second = await evl(`(() => ({ title: ${titleNow}, html: (document.getElementById('modal-container') || {}).innerHTML || '' }))()`);
      !second.html.trim() && second.title !== ONBOARDING_TITLE
        ? ok('second call on the same device does not reopen the nudge')
        : bad('nudge opened twice on the same device — ' + JSON.stringify(second));

      // The flag is localStorage, so it must survive a page reload too — the
      // installed PWA must not greet the same admin again every morning.
      await evl(`location.reload()`).catch(() => {});
      // Let the boot DOMContentLoaded restore finish on its own first: calling
      // tryRestoreSession() into the dying page races the single-use refresh
      // token and can revoke the session. Only nudge it after 2.5s.
      const reloadAt = Date.now();
      let back = await waitFor(evl, `(() => {
        if (window.App && App.user && document.getElementById('app').classList.contains('visible')) return true;
        if (Date.now() - ${reloadAt} > 2500 && (!window.__obReloadRestore || Date.now() - window.__obReloadRestore > 1500)) {
          window.__obReloadRestore = Date.now();
          try { Promise.resolve(tryRestoreSession()).catch(() => {}); } catch (e) {}
        }
        return false;
      })()`, true, 25000);
      // The reload itself is what this check needs (fresh JS context + the same
      // localStorage): if the cookie restore lost a race, sign back in rather
      // than turning a session-restore flake into a nudge failure.
      if (back !== true) {
        const relog = await evl(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '${adminEmail}', password: 'Demo@123456' }) }).then(r => r.status)`);
        if (relog === 200) {
          await evl(`tryRestoreSession()`);
          back = await waitFor(evl, `!!(window.App && App.user && document.getElementById('app').classList.contains('visible'))`, true, 15000);
        }
      }
      if (back !== true) {
        const diag = await evl(`({
          href: location.href,
          ready: document.readyState,
          user: !!(window.App && App.user),
          appVisible: !!(document.getElementById('app') && document.getElementById('app').classList.contains('visible')),
          hasRestore: typeof tryRestoreSession === 'function',
          restoreInflight: !!window.__restoreInflight,
          toast: (function(){ var t=document.querySelectorAll('#toast-area > *'); return t.length ? t[t.length-1].textContent : ''; })(),
        })`).catch(e => 'EVAL FAILED ' + e.message);
        return bad('session did not come back after reload — nudge repeat check skipped — ' + JSON.stringify(diag));
      }
      await sleep(3200);
      const afterReload = await evl(`(() => ({ title: ${titleNow}, html: (document.getElementById('modal-container') || {}).innerHTML || '' }))()`);
      !afterReload.html.trim() && afterReload.title !== ONBOARDING_TITLE
        ? ok('nudge stays away after a reload on the same device')
        : bad('nudge reopened after reload — ' + JSON.stringify(afterReload));

      // ── 4. A nudge pending at sign-out must not land on the sign-in screen ─
      await evl(`closeModal()`);
      await evl(`openModal('Settle (probe)', '<input id="probe-field2" value="x">', '')`);
      await evl(`localStorage.removeItem('sc_manual_onboarding_v1'); maybeShowManualOnboarding()`);
      await evl(`window.__doLogout && window.__doLogout()`);
      await waitFor(evl, `window.App && App.user`, null, 10000);
      await sleep(500);
      await evl(`closeModal()`); // slot goes idle while signed out
      await sleep(3200);
      const afterOut = await evl(`(() => ({
        user: !!(window.App && App.user),
        title: ${titleNow},
        html: (document.getElementById('modal-container') || {}).innerHTML || '',
      }))()`);
      afterOut.user === false
        ? ok('admin signed out (nudge pending)')
        : bad('sign-out did not complete — still signed in');
      !afterOut.html.trim() && afterOut.title !== ONBOARDING_TITLE
        ? ok('pending nudge never opens on the sign-in screen')
        : bad('nudge opened after sign-out — ' + JSON.stringify(afterOut));
    });
    console.log('\n' + (fail === 0 ? '═══ ONBOARDING-NUDGE UI: ' + pass + ' passed, 0 failed ═══' : '═══ ONBOARDING-NUDGE UI: ' + fail + ' FAILED ═══'));
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    try { srv.kill(); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('✗', e.message); process.exit(1); });
