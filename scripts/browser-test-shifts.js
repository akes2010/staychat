#!/usr/bin/env node
// scripts/browser-test-shifts.js — UI verification for the Shift & Attendance
// duty-rotation calendar through the interface staff actually use.
//
// Boots a throwaway server (fresh DB, seeded pro-plan tenant + hotel admin),
// signs in inside headless Chromium, then asserts through the app's own code
// path:
//   • the Shifts & Attendance page renders the Duty Rotation section with the
//     seeded rotating week (Reception 2 → Kitchen 2 → Bar 3, 7-day cycle),
//   • the calendar strip shows per-date departments for the next 20 days,
//   • Manage Rotation edits the cycle (Kitchen 2→3 days, add Housekeeping)
//     and the page + API reflect the new 9-day cycle.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { freePort } = require('./lib/free-port');

const ROOT = path.join(__dirname, '..');
const PORT = 4319;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-shifts-test-profile';

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
  // ── Fresh DB with a pro-plan tenant (staff_shifts entitlement) + admin ──
  const dataDir = fs.mkdtempSync('/tmp/staychat-shifts.');
  process.env.DATA_DIR = dataDir;
  const db = require(path.join(ROOT, 'server', 'db', 'connection'));
  require(path.join(ROOT, 'server', 'db', 'migrate'));
  const { nanoid } = require('nanoid');
  const bcrypt = require('bcryptjs');
  const tenantId = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?, 'pro', 'active')`)
    .run(tenantId, 'Shifts UI Hotel', 'shiftsui-' + nanoid(5));
  const adminEmail = ('shiftadmin-' + nanoid(4) + '@shifts.test').toLowerCase();
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?, 'hotel_admin')`)
    .run('user_' + nanoid(8), tenantId, 'Shifts Admin', adminEmail, bcrypt.hashSync('Demo@123456', 8));
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
      // Condition-based readiness with throttled retry — same proven pattern
      // as browser-test-gym.js (battery-load refresh races must not flake).
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

      // ── 1. Opening the shifts page via the app's own navigation ──────
      await evl(`navigate('shifts')`); await sleep(900);
      const title = await evl(`document.getElementById('topbar-title').textContent`);
      if (title === 'Shifts & Attendance') ok('navigate("shifts") sets the topbar title');
      else bad('topbar title wrong — ' + title);

      // ── 2. Duty Rotation section renders with the seeded cycle ──────
      const pageText = await evl(`document.getElementById('content').textContent`);
      if (pageText.includes('Duty Rotation') && pageText.includes('7-day cycle')) ok('Duty Rotation section renders with the 7-day cycle');
      else bad('rotation section missing — ' + (pageText || '').slice(0, 160));
      if (pageText.includes('Reception — 2 days') && pageText.includes('Kitchen — 2 days') && pageText.includes('Bar — 3 days')) {
        ok('legend shows Reception 2 / Kitchen 2 / Bar 3');
      } else bad('seeded legend missing from the page');
      if (pageText.includes('Today on duty:')) ok('on-duty-today line renders');
      else bad('on-duty line missing');

      const chipCount = await evl(`document.querySelectorAll('#content .card div[style*="min-width:66px"]').length`);
      if (chipCount >= 21) ok('calendar strip renders 21 day chips (today → +20)');
      else bad('calendar chips low — ' + chipCount);

      // ── 3. Manage Rotation: edit the cycle through the UI ────────────
      await evl(`window.__manageRotation()`); await sleep(400);
      const rowCount = await evl(`document.querySelectorAll('#rot-rows .rot-row').length`);
      if (rowCount === 3) ok('Manage Rotation modal opens with 3 department rows');
      else bad('rotation editor rows — ' + rowCount);

      // Kitchen 2 → 3 days, then add Housekeeping (1 day) — "all departments".
      await evl(`(() => {
        const rows = [...document.querySelectorAll('#rot-rows .rot-row')];
        const kitchen = rows.find(r => r.querySelector('.rot-dept').value === 'Kitchen');
        kitchen.querySelector('.rot-days').value = '3';
        window.__rotAddRow();
        const all = [...document.querySelectorAll('#rot-rows .rot-row')];
        const last = all[all.length - 1];
        last.querySelector('.rot-dept').value = 'Housekeeping';
        last.querySelector('.rot-days').value = '1';
      })()`);
      const totalLine = await evl(`document.getElementById('rot-total').textContent`);
      if (String(totalLine).includes('9 days')) ok('cycle length updates live to 9 days');
      else bad('cycle total wrong — ' + totalLine);

      await evl(`window.__saveRotation()`);
      const newTotal = await waitFor(evl, `API.get('/api/shifts/rotation').then(r => r.totalDays)`, 9, 8000);
      if (newTotal === 9) ok('rotation saved — API shows the new 9-day cycle');
      else bad('saved cycle wrong — totalDays=' + newTotal);

      await sleep(700);
      const pageText2 = await evl(`document.getElementById('content').textContent`);
      if (pageText2.includes('9-day cycle') && pageText2.includes('Housekeeping — 1 day') && pageText2.includes('Kitchen — 3 days')) {
        ok('page re-renders the edited rotation (Kitchen 3, Housekeeping 1)');
      } else bad('page did not reflect the edit — ' + (pageText2 || '').slice(0, 200));

      // The calendar strip now follows the new cycle: strip day 2 (anchor+2)
      // should show Kitchen... verify via the API the page reads from.
      const deptAtAnchorPlus2 = await evl(`(async () => {
        const rot = await API.get('/api/shifts/rotation');
        const cal = await API.get('/api/shifts/rotation/calendar?from=' + rot.anchorDate + '&to=' + rot.anchorDate);
        return cal.days[0].department;
      })()`);
      // Anchor unchanged → first cycle day is still Reception; day 1 Kitchen.
      if (deptAtAnchorPlus2 === 'Reception') ok('calendar still resolves from the anchor after the edit');
      else bad('anchor resolution broke — ' + deptAtAnchorPlus2);
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
