#!/usr/bin/env node
// scripts/browser-test-pos-tables.js — UI verification for the POS table
// picker through the interface operators actually use.
//
// Boots a throwaway server (fresh DB, pro-plan tenant + hotel admin + seeded
// tables), signs in inside headless Chromium, then asserts through the app's
// own code path:
//   • terminal sign-in → New Ticket shows table chips for THIS outlet with
//     party-size input,
//   • clicking a chip fills the Table field and marks the chip active,
//   • opening the ticket seats it (label/table_id/covers round-trip) and the
//     card shows table + party,
//   • the seated table's chip comes back LOCKED (disabled + 🔒) next open,
//   • a typed-over label still creates a free-text ticket (back-compat),
//   • switching to the bar terminal shows only bar tables.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { freePort } = require('./lib/free-port');

const ROOT = path.join(__dirname, '..');
const PORT = 4321;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-pos-tables-profile';

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
  // A free OS-assigned DevTools port per run: the old fixed 9234 busy-wait
  // gave up silently after 5s, letting a lingering previous chromium answer
  // these fetches — assertions then ran against the wrong page.
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
  // ── Fresh DB: pro tenant, hotel admin, one restaurant table + one bar ───
  const dataDir = fs.mkdtempSync('/tmp/staychat-pos-tables.');
  process.env.DATA_DIR = dataDir;
  const db = require(path.join(ROOT, 'server', 'db', 'connection'));
  require(path.join(ROOT, 'server', 'db', 'migrate'));
  const { nanoid } = require('nanoid');
  const bcrypt = require('bcryptjs');
  const tenantId = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?, 'pro', 'active')`)
    .run(tenantId, 'PosTable UI Hotel', 'posTui-' + nanoid(5));
  const adminEmail = ('posTadmin-' + nanoid(4) + '@posT.test').toLowerCase();
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?, 'hotel_admin')`)
    .run('user_' + nanoid(8), tenantId, 'POS Admin', adminEmail, bcrypt.hashSync('Demo@123456', 8));
  db.prepare(`INSERT INTO pos_tables (id, tenant_id, name, sitting, chairs, persons, location, active) VALUES (?,?,?,?,?,?,?,1)`)
    .run('tbl_ui_rest1', tenantId, 'T1', 'Standard', 4, 4, 'restaurant');
  db.prepare(`INSERT INTO pos_tables (id, tenant_id, name, sitting, chairs, persons, location, active) VALUES (?,?,?,?,?,?,?,1)`)
    .run('tbl_ui_bar1', tenantId, 'High 1', 'Bar Counter', 2, 2, 'bar');
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
        const page = await evl(`({ href: location.href, ready: document.readyState, scripts: document.scripts.length })`).catch(() => null);
        const probe = await Promise.race([
          fetch(BASE + '/js/countries.js').then(r => r.status + '/' + (r.headers.get('content-length') || '?')).catch(e => 'ERR ' + e.message),
          new Promise(r => setTimeout(() => r('TIMEOUT(3s)'), 3000)),
        ]);
        return bad('session/permissions never became ready — ' + JSON.stringify(diag) + ' page=' + JSON.stringify(page) + ' serverProbe=' + probe);
      }

      // ── 1. POS → restaurant terminal sign-in ─────────────────────────────
      await evl(`navigate('pos')`); await sleep(900);
      const terminalCard = await evl(`!!document.querySelector('#content [onclick*="__posPickTerminal"]')`);
      if (!terminalCard) return bad('terminal picker missing');
      await evl(`window.__posPickTerminal('restaurant')`); await sleep(400);
      await evl(`window.__posConfirmTerminal('restaurant')`); await sleep(600);
      const onBoard = await evl(`!!Array.from(document.querySelectorAll('#content button')).find(b => b.textContent.indexOf('New Ticket') !== -1)`);
      if (onBoard) ok('restaurant terminal signed in (board with + New Ticket)');
      else bad('POS board did not render after terminal sign-in');

      // ── 2. New Ticket → picker chips for THIS outlet + party size ────────
      await evl(`window.__posNewTicket()`); await sleep(700);
      const picker = await evl(`(() => {
        const chips = Array.from(document.querySelectorAll('#pos-table-chips .pill'));
        return {
          present: !!document.getElementById('pos-table-chips'),
          names: chips.map(c => c.textContent.trim()),
          disabled: chips.map(c => c.disabled),
          covers: !!document.getElementById('pt-covers'),
          label: !!document.getElementById('pt-label'),
        };
      })()`);
      if (picker && picker.present && picker.names.length === 1 && picker.names[0].indexOf('T1') === 0 && picker.covers && picker.label) {
        ok('picker shows only the restaurant table chip + party-size input');
      } else bad('picker wrong — ' + JSON.stringify(picker));

      // ── 3. Click the chip → label filled + chip active ───────────────────
      await evl(`window.__posPickTable('tbl_ui_rest1')`); await sleep(200);
      const picked = await evl(`(() => ({
        label: document.getElementById('pt-label').value,
        tableId: document.getElementById('pt-label').dataset.tableId,
        active: !!document.querySelector('#pos-table-chips .pill.active'),
      }))()`);
      if (picked && picked.label === 'T1' && picked.tableId === 'tbl_ui_rest1' && picked.active) {
        ok('clicking the chip fills the Table field and marks the chip active');
      } else bad('chip pick wrong — ' + JSON.stringify(picked));

      // ── 4. Party size + Open Ticket → seated round-trip ──────────────────
      await evl(`document.getElementById('pt-covers').value = '3'`);
      await evl(`window.__posCreateTicket()`);
      const seated = await waitFor(evl, `API.get('/api/pos/tickets').then(ts => { const t = ts.find(x => x.label === 'T1'); return !!(t && t.table_id === 'tbl_ui_rest1' && t.covers === 3); })`, true);
      if (seated) ok('ticket seated at T1 with party of 3 (label/table_id/covers round-trip)');
      else bad('seated ticket wrong');
      await evl(`closeModal()`); await sleep(300);
      const cardText = await evl(`document.getElementById('content').textContent`);
      if (cardText.includes('T1') && cardText.includes('3')) ok('ticket card shows the table + party size');
      else bad('card missing table/party — ' + (cardText || '').slice(0, 120));

      // ── 5. Reopen New Ticket → seated chip is LOCKED ─────────────────────
      await evl(`window.__posNewTicket()`);
      // Poll: the modal renders after two awaits (context + tables fetch).
      const lockState = await waitFor(evl, `(() => {
        if (!document.getElementById('pt-label')) return 'no-modal';
        const box = document.getElementById('pos-table-chips');
        if (!box) return 'no-chips-box';
        const chip = document.querySelector('#pos-table-chips .pill[data-table-id="tbl_ui_rest1"]');
        return !!(chip && chip.disabled && chip.textContent.includes('🔒'));
      })()`, true);
      if (lockState === true) ok('seated table chip comes back disabled + locked');
      else {
        const diag = await evl(`({
          modalLabels: Array.from(document.querySelectorAll('#modal-container .form-label')).map(l => l.textContent).slice(0, 4),
          chipsBox: !!document.getElementById('pos-table-chips'),
          chipCount: document.querySelectorAll('#pos-table-chips .pill').length,
          pickerNote: ((document.getElementById('modal-container') || {}).textContent || '').slice(0, 160),
        })`);
        bad('seated chip not locked — state=' + lockState + ' diag=' + JSON.stringify(diag));
      }

      // ── 6. Type a label over the picker → free-text ticket ───────────────
      await evl(`(() => {
        const input = document.getElementById('pt-label');
        delete input.dataset.tableId;
        input.value = 'Window seat';
      })()`);
      await evl(`window.__posCreateTicket()`);
      const freeText = await waitFor(evl, `API.get('/api/pos/tickets').then(ts => { const t = ts.find(x => x.label === 'Window seat'); return !!(t && !t.table_id); })`, true);
      if (freeText) ok('typed-over label still creates a free-text ticket (no table)');
      else bad('free-text fallback broken');
      await evl(`closeModal()`); await sleep(300);

      // ── 7. Bar terminal → only bar tables ────────────────────────────────
      await evl(`window.__posSwitchTerminal()`); await sleep(400);
      await evl(`window.__posPickTerminal('bar')`); await sleep(400);
      await evl(`window.__posConfirmTerminal('bar')`); await sleep(600);
      await evl(`window.__posNewTicket()`); await sleep(700);
      const barPicker = await evl(`(() => {
        const chips = Array.from(document.querySelectorAll('#pos-table-chips .pill'));
        return chips.map(c => c.textContent.trim());
      })()`);
      if (Array.isArray(barPicker) && barPicker.length === 1 && barPicker[0].indexOf('High 1') === 0) {
        ok('bar terminal shows only the bar table chip');
      } else bad('bar picker wrong — ' + JSON.stringify(barPicker));
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
