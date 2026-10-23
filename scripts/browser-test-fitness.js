#!/usr/bin/env node
// scripts/browser-test-fitness.js — UI verification for the additive Gym &
// Pool membership module through the interface staff actually use.
//
// Boots a throwaway server (fresh DB, seeded pro-plan tenant + hotel admin),
// signs in inside headless Chromium, then asserts through the app's own code
// path:
//   • the Gym & Fitness page still renders its original buttons untouched AND
//     gains the injected "🤝 Gym & Pool" button,
//   • the empty state offers plan creation, the plan manager creates a
//     combined plan (month/quarter/year prices + features + benefits),
//   • the plan card shows all three price tiers, features and benefits,
//   • selecting the plan + Quarterly auto-fills the quarterly price and a
//     quarterly registration persists with the correct period (start + 3
//     months − 1 day),
//   • the Pool Bookings page gains the same injected button.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { freePort } = require('./lib/free-port');

const ROOT = path.join(__dirname, '..');
const PORT = 4326;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-fitness-test-profile';

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
  // ── Fresh DB with a pro-plan tenant (gym_bookings + pool_bookings) + admin
  const dataDir = fs.mkdtempSync('/tmp/staychat-fitness.');
  process.env.DATA_DIR = dataDir;
  const db = require(path.join(ROOT, 'server', 'db', 'connection'));
  require(path.join(ROOT, 'server', 'db', 'migrate'));
  const { nanoid } = require('nanoid');
  const bcrypt = require('bcryptjs');
  const tenantId = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?, 'pro', 'active')`)
    .run(tenantId, 'Fitness UI Hotel', 'fitui-' + nanoid(5));
  const adminEmail = ('fitadmin-' + nanoid(4) + '@fitui.test').toLowerCase();
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?, 'hotel_admin')`)
    .run('user_' + nanoid(8), tenantId, 'Fit Admin', adminEmail, bcrypt.hashSync('Demo@123456', 8));
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

      // ── 1. Gym page: original buttons untouched + new button injected ──
      await evl(`navigate('gym')`); await sleep(1200);
      const gymHeader = await evl(`(() => {
        const h = document.querySelector('#content .page-header');
        if (!h) return null;
        const btns = Array.from(h.querySelectorAll('button')).map(b => b.textContent.trim());
        return { btns, fm: !!document.getElementById('fm-open-btn') };
      })()`);
      if (gymHeader && gymHeader.btns.some(b => b.includes('+ New Registration'))) ok('gym header keeps its original "+ New Registration" button (system untouched)');
      else bad('original gym buttons missing — ' + JSON.stringify(gymHeader));
      if (gymHeader && gymHeader.fm) ok('injected "🤝 Gym & Pool" button appears on the Gym & Fitness page');
      else bad('fm-open-btn not injected on the gym page — ' + JSON.stringify(gymHeader));

      // ── 2. Modal opens with the plan empty-state ──────────────────────
      await evl(`window.__fmOpen()`); await sleep(800);
      const emptyTxt = await evl(`(document.getElementById('fm-modal-body') || {}).textContent || ''`);
      if (emptyTxt.includes('No membership plans yet')) ok('modal shows the no-plans empty state');
      else bad('empty state missing — ' + (emptyTxt || '').slice(0, 80));
      const firstPlanBtn = await evl(`!!document.getElementById('fm-first-plan-btn')`);
      if (firstPlanBtn) ok('empty state offers "Create the first plan"');
      else bad('first-plan button missing');

      // ── 3. Plan manager creates a combined plan ───────────────────────
      await evl(`window.__fmManagePlans()`); await sleep(500);
      const formUp = await evl(`!!document.getElementById('fmp-name')`);
      if (formUp) ok('plan manager opens with the add-plan form');
      else bad('plan form did not open');

      await evl(`(() => {
        document.getElementById('fmp-name').value = 'Ultimate Combo';
        document.getElementById('fmp-scope').value = 'both';
        document.getElementById('fmp-monthly').value = '60';
        document.getElementById('fmp-quarterly').value = '160';
        document.getElementById('fmp-yearly').value = '580';
        document.getElementById('fmp-features').value = 'Gym access\\nPool access\\nSauna';
        document.getElementById('fmp-benefits').value = 'Free towel service\\nGuest day pass';
      })()`);
      await evl(`window.__fmSavePlan()`);
      const planCount = await waitFor(evl, `API.get('/api/fitness/plans').then(p => p.length)`, 1);
      if (planCount === 1) ok('combined plan saved via the UI (API shows 1 plan)');
      else bad('plan did not persist — count=' + planCount);

      const plan = await evl(`API.get('/api/fitness/plans').then(p => p[0])`);
      if (plan && plan.name === 'Ultimate Combo' && plan.scope === 'both' && plan.price_monthly === 60 &&
          plan.price_quarterly === 160 && plan.price_yearly === 580 && plan.features.length === 3 && plan.benefits.length === 2) {
        ok('plan round-trips scope/monthly-quarterly-yearly prices + features + benefits');
      } else bad('plan fields wrong — ' + JSON.stringify(plan));

      // ── 4. Back to the main modal: plan card shows all three tiers ────
      await evl(`window.__fmOpen()`); await sleep(800);
      const cardText2 = await evl(`(() => { const c = document.querySelector('.fm-plan-card'); return c ? c.textContent : ''; })()`);
      if (cardText2.includes('$60') && cardText2.includes('$160') && cardText2.includes('$580')) ok('plan card shows all three price tiers ($60/mo · $160/qtr · $580/yr)');
      else bad('price tiers missing from the card — ' + cardText2.slice(0, 120));
      if (cardText2.includes('Sauna') && cardText2.includes('Guest day pass')) ok('features and benefits render on the plan card');
      else bad('features/benefits missing — ' + cardText2.slice(0, 120));

      // ── 5. Select plan → quarterly auto-fill → register ───────────────
      await evl(`window.__fmSelectPlan('${plan.id}')`); await sleep(400);
      const monthlyDefault = await evl(`document.getElementById('fm-amount') && document.getElementById('fm-amount').value`);
      if (String(monthlyDefault) === '60') ok('monthly is the default duration and auto-fills $60');
      else bad('monthly default wrong — ' + monthlyDefault);

      await evl(`window.__fmSetDuration('quarterly')`); await sleep(200);
      const quarterlyAuto = await evl(`document.getElementById('fm-amount').value`);
      if (String(quarterlyAuto) === '160') ok('switching to Quarterly auto-fills the $160 quarterly price');
      else bad('quarterly auto-fill wrong — ' + quarterlyAuto);

      await evl(`(() => {
        document.getElementById('fm-name').value = 'Ngozi Umeh';
        document.getElementById('fm-phone').value = '+2348098765432';
        document.getElementById('fm-start').value = '2026-05-10';
        window.__fmRefreshSummary();
      })()`);
      const summary = await evl(`(document.getElementById('fm-summary') || {}).textContent || ''`);
      if (summary.includes('2026-05-10') && summary.includes('2026-08-09')) ok('summary previews the quarterly period 2026-05-10 → 2026-08-09');
      else bad('period preview wrong — ' + summary.slice(0, 120));

      await evl(`window.__fmSubmit()`);
      const memCount = await waitFor(evl, `API.get('/api/fitness/memberships').then(m => m.length)`, 1);
      if (memCount === 1) ok('quarterly membership registered via the UI (API shows 1)');
      else bad('membership did not persist — count=' + memCount);

      const mem = await evl(`API.get('/api/fitness/memberships').then(m => m[0])`);
      if (mem && mem.member_name === 'Ngozi Umeh' && mem.duration === 'quarterly' && mem.amount === 160 &&
          mem.start_date === '2026-05-10' && mem.end_date === '2026-08-09' && mem.scope === 'both' && mem.status === 'active') {
        ok('membership carries member/duration/amount + correct quarterly period (start + 3 months − 1 day)');
      } else bad('membership fields wrong — ' + JSON.stringify(mem));

      const listText = await evl(`(document.getElementById('fm-list') || {}).textContent || ''`);
      if (listText.includes('Ngozi Umeh') && listText.includes('Quarterly')) ok('active-memberships list shows the member with the Quarterly badge');
      else bad('member row missing from the list — ' + listText.slice(0, 120));

      // ── 6. Pool page gains the same button ────────────────────────────
      await evl(`closeModal()`); await sleep(200);
      await evl(`navigate('pool')`); await sleep(1200);
      const poolBtn = await evl(`!!document.getElementById('fm-open-btn')`);
      if (poolBtn) ok('injected "🤝 Gym & Pool" button appears on the Pool Bookings page too');
      else bad('fm-open-btn not injected on the pool page');
      const poolHeader = await evl(`(() => {
        const h = document.querySelector('#content .page-header');
        return h ? Array.from(h.querySelectorAll('button')).map(b => b.textContent.trim()) : null;
      })()`);
      if (poolHeader && poolHeader.some(b => b.includes('+ New Booking'))) ok('pool header keeps its original buttons (system untouched)');
      else bad('original pool buttons missing — ' + JSON.stringify(poolHeader));
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
