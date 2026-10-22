#!/usr/bin/env node
// scripts/browser-test-platform-billing.js — the superadmin Platform Billing
// tab must actually render and save the new gateway keys (Korapay card +
// Flutterwave public key) through the real UI.
//
// Boots a throwaway server (production mode), signs in as SUPERADMIN in
// headless Chromium, opens Super Admin → Billing & Approvals, TYPES the Korapay
// public + secret keys with real CDP keystrokes, clicks "Save gateway keys",
// and verifies after the re-render:
//   • both keys persisted (masked hints shown — never echoed in full)
//   • the Korapay webhook URL is listed for the operator to register
//   • auto-approvals badge flips ON (both-keys rule)
//   • the Flutterwave public key input exists alongside the secret
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { freePort } = require('./lib/free-port');

const ROOT = path.join(__dirname, '..');
const PORT = 4325; // unique — every suite must own its port (4319 is offline-sync's)
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-pb-test-profile';

const PUB = 'pk_live_uiTestPub123';
const SEC = 'sk_live_uiTestSec456';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (evl, expr, want, timeoutMs = 8000) => {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await evl(expr);
    if (last === want) return last;
    await sleep(120);
  }
  return last;
};
let pass = 0, fail = 0;
let srv = null, dataDir = null;
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
    const type = async (text) => {
      for (const ch of text) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, code: 'Digit' + (ch.match(/\d/) ? ch : ''), windowsVirtualKeyCode: ch.charCodeAt(0) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Digit' + (ch.match(/\d/) ? ch : ''), windowsVirtualKeyCode: ch.charCodeAt(0) });
        await sleep(25);
      }
    };
    return await fn({ send, evl, type });
  } finally {
    try { chrome.kill(); } catch (e) {}
    await new Promise(res => {
      const t = setTimeout(res, 3000);
      chrome.once('exit', () => { clearTimeout(t); res(); });
    });
  }
}

(async () => {
  // Watchdog: never hang silently — fail loudly with whatever ran so far.
  const watchdog = setTimeout(() => {
    console.error('WATCHDOG: test exceeded 150s — aborting');
    console.log('\n═══ PLATFORM BILLING UI TEST: ' + pass + ' passed, ' + fail + ' failed (ABORTED) ═══');
    try { srv && srv.kill('SIGKILL'); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
    process.exit(1);
  }, 150000);

  dataDir = fs.mkdtempSync('/tmp/staychat-pb.');
  fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db'), path.join(dataDir, 'staychat.db'));
  for (const ext of ['-wal', '-shm']) {
    const src = path.join(ROOT, 'data', 'staychat.db' + ext);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dataDir, 'staychat.db' + ext));
  }

  // Fresh superadmin login + deterministic starting state (korapay unconfigured).
  const Database = require('better-sqlite3');
  const bcrypt = require('bcryptjs');
  const { nanoid } = require('nanoid');
  const raw = new Database(path.join(dataDir, 'staychat.db'));
  const SA_EMAIL = 'pb-probe@staychat.test';
  const SA_PASSWORD = 'PbProbe!2026x';
  raw.prepare('DELETE FROM users WHERE email = ?').run(SA_EMAIL);
  raw.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, avatar, active)
               VALUES (?, NULL, 'PB Probe', ?, ?, 'superadmin', 'PB', 1)`)
    .run('user_' + nanoid(14), SA_EMAIL, bcrypt.hashSync(SA_PASSWORD, 12));
  raw.prepare("DELETE FROM platform_settings WHERE key IN ('korapay_public_key','korapay_secret_key','flutterwave_public_key')").run();
  raw.close();

  srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production' }),
    stdio: 'ignore',
  });
  try {
    await waitHealthy();
    console.log('── Superadmin opens Platform Billing in the real UI ──');

    await withBrowser(async ({ send, evl, type }) => {
      await evl(`location.href = '${BASE}/app'`).catch(() => {});
      // Wait for the shell's JS to be wired — a fixed sleep races the cold
      // page load and tryRestoreSession() silently no-ops (the same race
      // browser-test-changepw.js documents).
      const ready = await waitFor(evl, `typeof tryRestoreSession === 'function' && typeof API !== 'undefined'`, true, 20000);
      if (ready !== true) {
        const diag = await evl(`({ href: location.href, ready: document.readyState, scripts: document.scripts.length, app: typeof App !== 'undefined' })`).catch(() => null);
        // Probe the SAME static file from the TEST process: separates "server
        // stopped serving" from "the browser's own fetch stalled".
        const probe = await Promise.race([
          fetch(BASE + '/js/countries.js').then(r => r.status + '/' + (r.headers.get('content-length') || '?')).catch(e => 'ERR ' + e.message),
          new Promise(r => setTimeout(() => r('TIMEOUT(3s)'), 3000)),
        ]);
        return bad('app shell never became ready — page=' + JSON.stringify(diag) + ' serverProbe=' + probe);
      }
      const login = await evl(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '${SA_EMAIL}', password: '${SA_PASSWORD}' }) }).then(r => r.status)`);
      if (login !== 200) return bad('superadmin login failed (HTTP ' + login + ')');
      ok('superadmin signed in inside the browser');
      await evl(`tryRestoreSession()`);
      const isSuper = await waitFor(evl, `(window.App && App.user && App.user.role) || null`, 'superadmin', 15000);
      if (isSuper !== 'superadmin') return bad('app session did not restore as superadmin');
      // startApp lands superadmins straight on the Super Admin console.
      const onConsole = await waitFor(evl, `!!document.querySelector('.filter-pills')`, true);
      if (!onConsole) return bad('super admin console did not render');
      ok('super admin console rendered');

      await evl(`window.__saTab('billing')`);
      const cardUp = await waitFor(evl, `!!document.getElementById('pb-korapay-pub')`, true);
      if (!cardUp) return bad('Billing & Approvals tab has no Korapay public-key input');
      ok('Billing & Approvals tab shows the Korapay card (pb-korapay-pub + pb-korapay)');
      const flwPubUp = await evl(`!!document.getElementById('pb-flutterwave-pub')`);
      if (flwPubUp) ok('Flutterwave card also exposes the public-key input');
      else bad('Flutterwave public-key input missing');

      const initial = await evl(`document.body.innerText`);
      if (initial.includes('Not configured — both keys required')) ok('fresh state: Korapay shows "Not configured — both keys required"');
      else bad('expected the unconfigured Korapay hint on a fresh DB copy');

      console.log('── Type both Korapay keys and save through the UI ──');
      await evl(`document.getElementById('pb-korapay-pub').focus()`);
      await sleep(150);
      await type(PUB);
      const typedPub = await evl(`document.getElementById('pb-korapay-pub').value`);
      if (typedPub !== PUB) return bad('typing the public key broke (got "' + typedPub + '")');
      await evl(`document.getElementById('pb-korapay').focus()`);
      await sleep(150);
      await type(SEC);
      const typedSec = await evl(`document.getElementById('pb-korapay').value`);
      if (typedSec !== SEC) return bad('typing the secret key broke (got "' + typedSec + '")');
      ok('both keys typed with real keystrokes');

      // Flutterwave public key — value assignment is enough (the save handler
      // reads .value; the typing regression was already covered above).
      await evl(`document.getElementById('pb-flutterwave-pub').value = 'FLWPUBK-uiTest789'`);

      const clicked = await evl(`(Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Save gateway keys')) || {}).click ? (Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Save gateway keys')).click(), true) : false`);
      if (!clicked) return bad('Save gateway keys button not found');
      // Save re-fetches the tab; wait for the persisted masked hints to appear.
      const saved = await waitFor(evl, `document.body.innerText.includes('Public pk_…')`, true);
      if (!saved) return bad('after save the Korapay card never showed the masked public-key hint');
      ok('save persisted — card now shows "Public pk_…" hint');

      const text = await evl(`document.body.innerText`);
      if (text.includes('sk_…')) ok('secret rendered masked (sk_… hint present)');
      else bad('no masked secret hint after save');
      if (text.includes(SEC)) bad('SECRET KEY ECHOED IN FULL in the UI');
      else ok('secret key never echoed in full');
      if (text.includes(PUB)) bad('PUBLIC KEY ECHOED IN FULL in the UI');
      else ok('public key never echoed in full');
      if (text.includes('/api/webhooks/platform/korapay')) ok('korapay webhook URL listed for registration');
      else bad('korapay webhook URL missing from the billing tab');
      // .badge renders uppercase via CSS text-transform, and innerText reflects
      // it ("AUTO-APPROVALS ON") — assert on the element's textContent, which
      // stays case-faithful to the source string.
      const autoBadge = await evl(`(Array.from(document.querySelectorAll('.badge')).find(b => /auto-approvals/i.test(b.textContent)) || {}).textContent || ''`);
      if (/auto-approvals on/i.test(autoBadge.trim())) ok('auto-approvals badge ON (both keys configured): "' + autoBadge.trim() + '"');
      else bad('auto-approvals badge did not flip ON (found: "' + autoBadge.trim() + '")');

      // Persistence: navigate away and back in (full page load — same code path
      // as a real reload), re-open the billing tab; the hints must survive.
      await evl(`(location.href = '${BASE}/app', true)`).catch(() => {});
      await sleep(1800);
      const restored = await waitFor(evl, `(window.App && App.user && App.user.role) || null`, 'superadmin', 10000);
      if (restored !== 'superadmin') return bad('session did not restore after reload');
      const consoleUp = await waitFor(evl, `!!document.querySelector('.filter-pills')`, true, 10000);
      if (!consoleUp) return bad('super admin console did not come back after reload');
      await evl(`window.__saTab('billing')`);
      const tabReady = await waitFor(evl, `!!document.getElementById('pb-korapay-pub')`, true, 10000);
      if (!tabReady) return bad('billing tab did not come back after reload');
      const persisted = await waitFor(evl, `document.body.innerText.includes('Public pk_…')`, true);
      if (persisted) ok('keys persist across a full page reload');
      else bad('saved keys did not survive a page reload');
    });
  } finally {
    // kill() alone doesn't wait — the next suite could boot onto a port still
    // held by this half-dead server (the settle-modal harness hit exactly this).
    if (srv) {
      try { srv.kill('SIGKILL'); } catch (e) {}
      await new Promise(res => {
        const t = setTimeout(res, 3000);
        srv.once('exit', () => { clearTimeout(t); res(); });
      });
    }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
  clearTimeout(watchdog);
  console.log('\n═══ PLATFORM BILLING UI TEST: ' + pass + ' passed, ' + fail + ' failed ═══');
  process.exit(fail ? 1 : 0);
})().catch(err => {
  console.error('PB UI TEST CRASH:', err);
  try { srv && srv.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  process.exit(1);
});

