#!/usr/bin/env node
// scripts/browser-test-tables.js — UI verification for the Tables & Seating
// module through the interface staff actually use.
//
// Boots a throwaway server (fresh DB, pro-plan tenant + hotel admin), signs in
// inside headless Chromium, then asserts through the app's own code path:
//   • the sidebar renders the "Tables" nav item and opens the page,
//   • Add Table creates restaurant + bar tables (sitting setting, chairs per
//     table, location) and the page groups them by location,
//   • a duplicate name is rejected by the UI flow (server 409, no new row),
//   • location filter pills narrow the list,
//   • the active toggle flips a table inactive (and back),
//   • editing changes sitting + chairs, and delete removes the row.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 4319;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-tables-test-profile';

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
    try { await fetch('http://localhost:9232/json/version'); throw new Error('port 9232 busy'); }
    catch (e) { if (e instanceof TypeError) break; await sleep(250); }
  }
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-popup-blocking',
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=9232', 'about:blank'], { stdio: 'ignore' });
  try {
    let devtoolsUp = false;
    for (let i = 0; i < 40 && !devtoolsUp; i++) {
      try {
        const v = await fetch('http://localhost:9232/json/version').then(r => r.json());
        devtoolsUp = !!v.webSocketDebuggerUrl;
      } catch (e) { await sleep(250); }
    }
    if (!devtoolsUp) throw new Error('chromium DevTools endpoint never came up');
    const list = await fetch('http://localhost:9232/json').then(r => r.json());
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
  // ── Fresh DB with a pro-plan tenant + hotel admin (tables.use/manage) ───
  const dataDir = fs.mkdtempSync('/tmp/staychat-tables.');
  process.env.DATA_DIR = dataDir;
  const db = require(path.join(ROOT, 'server', 'db', 'connection'));
  require(path.join(ROOT, 'server', 'db', 'migrate'));
  const { nanoid } = require('nanoid');
  const bcrypt = require('bcryptjs');
  const tenantId = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?, 'pro', 'active')`)
    .run(tenantId, 'Tables UI Hotel', 'tblui-' + nanoid(5));
  const adminEmail = ('tbladmin-' + nanoid(4) + '@tbl.test').toLowerCase();
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?, 'hotel_admin')`)
    .run('user_' + nanoid(8), tenantId, 'Tables Admin', adminEmail, bcrypt.hashSync('Demo@123456', 8));
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
      await evl(`tryRestoreSession()`); await sleep(1500);

      // ── 1. Sidebar + page ───────────────────────────────────────────────
      const navInfo = await evl(`(() => {
        const b = document.querySelector('.nav-item[data-page="tables"]');
        return b ? { label: b.textContent.trim(), visible: b.offsetParent !== null } : null;
      })()`);
      if (navInfo && navInfo.label.includes('Tables') && navInfo.visible) ok('sidebar renders the "Tables" nav item');
      else bad('sidebar tables nav item missing — ' + JSON.stringify(navInfo));

      await evl(`navigate('tables')`); await sleep(800);
      const h1 = await waitFor(evl, `(document.querySelector('#content .page-header h1') || {}).textContent || ''`, 'Tables & Seating');
      if (h1 === 'Tables & Seating') ok('navigate("tables") opens the Tables & Seating page');
      else bad('page header missing — "' + h1 + '"');
      const empty = await evl(`document.getElementById('content').textContent`);
      if (empty.includes('No tables yet')) ok('fresh page shows the empty state');
      else bad('empty state missing');

      // ── 2. Add Table form ───────────────────────────────────────────────
      await evl(`window.__openAddTable()`); await sleep(400);
      const formInfo = await evl(`(() => {
        const s = document.getElementById('at-sitting');
        return {
          name: !!document.getElementById('at-name'), chairs: !!document.getElementById('at-chairs'),
          persons: !!document.getElementById('at-persons'),
          loc: !!document.getElementById('at-loc'), sittingOptions: s ? s.options.length : 0,
        };
      })()`);
      if (formInfo && formInfo.name && formInfo.chairs && formInfo.persons && formInfo.loc && formInfo.sittingOptions === 7) {
        ok('Add Table modal has name, sitting (7 settings), chairs, persons and location fields');
      } else bad('form fields wrong — ' + JSON.stringify(formInfo));

      await evl(`(() => {
        document.getElementById('at-name').value = 'Window One';
        document.getElementById('at-sitting').value = 'Window Side';
        document.getElementById('at-chairs').value = '4';
        document.getElementById('at-persons').value = '5';
        document.getElementById('at-loc').value = 'restaurant';
      })()`);
      await evl(`window.__addTable()`);
      const n1 = await waitFor(evl, `API.get('/api/tables').then(t => t.length)`, 1);
      const t1 = await evl(`API.get('/api/tables').then(t => t[0])`);
      if (n1 === 1 && t1 && t1.name === 'Window One' && t1.sitting === 'Window Side' && t1.chairs === 4 && t1.persons === 5 && t1.location === 'restaurant' && t1.active === true) {
        ok('restaurant table created with sitting/chairs/persons/location and active by default');
      } else bad('create wrong — n=' + n1 + ' ' + JSON.stringify(t1));

      await evl(`(() => {
        window.__openAddTable();
        document.getElementById('at-name').value = 'Bar High';
        document.getElementById('at-sitting').value = 'Bar Counter';
        document.getElementById('at-chairs').value = '2';
        document.getElementById('at-loc').value = 'bar';
      })()`); await sleep(300);
      await evl(`window.__addTable()`);
      const n2 = await waitFor(evl, `API.get('/api/tables').then(t => t.length)`, 2);
      if (n2 === 2) ok('bar table created (API shows 2 tables)');
      else bad('second create failed — n=' + n2);

      // ── 3. Page groups by location ──────────────────────────────────────
      const pageText = await evl(`document.getElementById('content').textContent`);
      if (pageText.includes('Restaurant') && pageText.includes('Bar') && pageText.includes('Window One') && pageText.includes('Bar High')) {
        ok('page lists both tables under Restaurant and Bar sections');
      } else bad('location grouping missing — ' + (pageText || '').slice(0, 140));

      // ── 4. Duplicate name rejected through the UI flow ──────────────────
      await evl(`(() => {
        window.__openAddTable();
        document.getElementById('at-name').value = 'window one';
        document.getElementById('at-loc').value = 'restaurant';
      })()`); await sleep(300);
      await evl(`window.__addTable()`); await sleep(600);
      const n3 = await evl(`API.get('/api/tables').then(t => t.length)`);
      const modalStill = await evl(`!!document.getElementById('at-name')`);
      if (n3 === 2 && modalStill) ok('duplicate name in the same location is rejected (no row added, form stays open)');
      else bad('duplicate not blocked — n=' + n3 + ' modalOpen=' + modalStill);
      await evl(`closeModal()`); await sleep(200);

      // ── 5. Location filter pills ────────────────────────────────────────
      await evl(`window.__tableFilter('bar')`); await sleep(300);
      const barOnly = await evl(`(() => {
        const t = document.getElementById('content').textContent;
        return { hasBar: t.includes('Bar High'), hasRestaurantTable: t.includes('Window One') };
      })()`);
      if (barOnly && barOnly.hasBar && !barOnly.hasRestaurantTable) ok('Bar filter shows only the bar table');
      else bad('filter wrong — ' + JSON.stringify(barOnly));
      await evl(`window.__tableFilter('all')`); await sleep(300);

      // ── 6. Active toggle ────────────────────────────────────────────────
      await evl(`document.querySelectorAll('#content .toggle input')[0].click()`);
      const toggled = await waitFor(evl, `API.get('/api/tables').then(t => t.find(x => x.name === 'Window One').active)`, false);
      if (toggled === false) ok('active toggle flips the restaurant table inactive (server round-trip)');
      else bad('toggle did not persist');
      const inactiveShown = await waitFor(evl, `document.getElementById('content').textContent.includes('Inactive')`, true);
      if (inactiveShown) ok('inactive table is visibly marked on the page');
      else bad('inactive badge missing');

      // ── 7. Edit sitting + chairs ────────────────────────────────────────
      await evl(`(() => {
        const btn = Array.from(document.querySelectorAll('#content button'))
          .find(b => b.textContent.trim() === 'Edit' && b.closest('div').parentElement.textContent.includes('Bar High'));
        (btn || Array.from(document.querySelectorAll('#content button')).find(b => b.textContent.trim() === 'Edit')).click();
      })()`); await sleep(400);
      const editUp = await evl(`!!document.getElementById('et-name') && document.getElementById('et-name').value`);
      if (editUp === 'Bar High') ok('Edit modal opens prefilled (Bar High)');
      else bad('edit modal wrong — ' + editUp);
      await evl(`(() => {
        document.getElementById('et-sitting').value = 'Lounge';
        document.getElementById('et-chairs').value = '6';
        document.getElementById('et-persons').value = '7';
      })()`);
      // Save via the modal footer button (id-agnostic, same as a user click)
      await evl(`(() => {
        const f = document.querySelector('.modal-footer');
        Array.from(f.querySelectorAll('button')).find(b => b.textContent.indexOf('Save Changes') !== -1).click();
      })()`);
      const edited = await waitFor(evl, `API.get('/api/tables').then(t => { const x = t.find(v => v.name === 'Bar High'); return x && x.chairs === 6 && x.persons === 7 && x.sitting === 'Lounge'; })`, true);
      if (edited === true) ok('edit saves new sitting + chairs + persons (Bar High → Lounge, 6 chairs, 7 persons)');
      else bad('edit did not persist');

      // ── 8. Delete with confirmation ─────────────────────────────────────
      // The save's load() re-renders the list — wait for the PAGE (not just
      // the API) before hunting the button, or we race the loading spinner.
      const pageReady = await waitFor(evl, `document.getElementById('content').textContent.includes('Lounge')`, true);
      if (!pageReady) bad('page did not re-render after the edit');
      const delClicked = await evl(`(() => {
        const btn = Array.from(document.querySelectorAll('#content button'))
          .find(b => b.textContent.trim() === 'Delete' && b.parentElement.textContent.includes('Bar High'));
        if (btn) btn.click();
        return !!btn;
      })()`);
      if (!delClicked) return bad('Delete button for Bar High not found on the page');
      const confirmUp = await waitFor(evl, `!!document.getElementById('confirm-yes-btn')`, true);
      if (confirmUp) ok('Delete asks for confirmation first');
      else bad('confirm modal missing');
      await evl(`document.getElementById('confirm-yes-btn').click()`);
      const nFinal = await waitFor(evl, `API.get('/api/tables').then(t => t.length)`, 1);
      if (nFinal === 1) ok('confirmed delete removes the table (1 left)');
      else bad('delete did not persist — n=' + nFinal);
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
