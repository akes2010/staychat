#!/usr/bin/env node
// scripts/browser-test-menu-categories.js — UI verification for the Menu
// Manager "+" feature (create a new product category when it isn't available)
// through the interface staff actually use.
//
// Boots a throwaway server (fresh DB, pro-plan tenant + hotel admin), signs in
// inside headless Chromium, then asserts through the app's own code path:
//   • the Menu Manager header shows the injected "+ New Category" button and
//     its modal creates a category (server persists it),
//   • the Add Product form's Category select carries a "＋ New Category…"
//     option plus a "+" button, and choosing it opens the INLINE name row
//     (the app has one modal container — no nested modal),
//   • creating from that row selects the new category and a product can be
//     saved under it,
//   • editing that product re-selects its custom category (the fixed-list
//     fallback would silently rewrite it on save),
//   • after a full page reload the categories are still there.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 4318;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-menu-cat-test-profile';

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
    try { await fetch('http://localhost:9231/json/version'); throw new Error('port 9231 busy'); }
    catch (e) { if (e instanceof TypeError) break; await sleep(250); }
  }
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-popup-blocking',
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=9231', 'about:blank'], { stdio: 'ignore' });
  try {
    let devtoolsUp = false;
    for (let i = 0; i < 40 && !devtoolsUp; i++) {
      try {
        const v = await fetch('http://localhost:9231/json/version').then(r => r.json());
        devtoolsUp = !!v.webSocketDebuggerUrl;
      } catch (e) { await sleep(250); }
    }
    if (!devtoolsUp) throw new Error('chromium DevTools endpoint never came up');
    const list = await fetch('http://localhost:9231/json').then(r => r.json());
    const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map();
    ws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evl = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.value; };
    // Real text insertion into the currently focused element (CDP).
    const type = async (text) => { await send('Input.insertText', { text }); };
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
  // ── Fresh DB with a pro-plan tenant + hotel admin (menu.manage) ─────────
  const dataDir = fs.mkdtempSync('/tmp/staychat-menu-cat.');
  process.env.DATA_DIR = dataDir;
  const db = require(path.join(ROOT, 'server', 'db', 'connection'));
  require(path.join(ROOT, 'server', 'db', 'migrate'));
  const { nanoid } = require('nanoid');
  const bcrypt = require('bcryptjs');
  const tenantId = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?, 'pro', 'active')`)
    .run(tenantId, 'MenuCat UI Hotel', 'mcatui-' + nanoid(5));
  const adminEmail = ('mcatadmin-' + nanoid(4) + '@mcat.test').toLowerCase();
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?, 'hotel_admin')`)
    .run('user_' + nanoid(8), tenantId, 'Menu Admin', adminEmail, bcrypt.hashSync('Demo@123456', 8));
  db.close();

  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'development' }),
    stdio: 'ignore',
  });
  try {
    await waitHealthy();

    await withBrowser(async ({ send, evl, type }) => {
      await evl(`location.href = '${BASE}/app'`).catch(() => {});
      const landed = await waitFor(evl, `location.href`, `${BASE}/app`);
      if (landed !== `${BASE}/app`) return bad('never reached the app — at ' + landed);
      await sleep(1200);

      const login = await evl(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: '${adminEmail}', password: 'Demo@123456' }) }).then(r => r.status)`).catch(() => 0);
      if (login !== 200) return bad('admin login failed (HTTP ' + login + ')');
      ok('hotel admin signed in inside the browser');
      await evl(`tryRestoreSession()`); await sleep(1500);

      // ── 1. Menu Manager page + injected header button ───────────────────
      await evl(`navigate('menu')`); await sleep(800);
      const h1 = await waitFor(evl, `(document.querySelector('#content .page-header h1') || {}).textContent || ''`, 'Menu Manager / Products');
      if (h1 === 'Menu Manager / Products') ok('Menu Manager page renders');
      else bad('menu page header missing — "' + h1 + '"');

      const hdrBtn = await waitFor(evl, `(() => {
        const b = Array.from(document.querySelectorAll('#content .page-header button')).find(x => x.textContent.trim() === '+ New Category');
        return b ? (b.offsetParent !== null) : false;
      })()`, true);
      if (hdrBtn) ok('injected "+ New Category" button visible in the page header');
      else bad('header "+ New Category" button missing');

      // ── 2. Page-header modal creates a category ─────────────────────────
      await evl(`(() => {
        const b = Array.from(document.querySelectorAll('#content .page-header button')).find(x => x.textContent.trim() === '+ New Category');
        b.click();
      })()`); await sleep(400);
      const modalUp = await evl(`!!document.getElementById('mc-name')`);
      if (modalUp) ok('header "+" opens the New Category modal');
      else bad('New Category modal did not open');
      const chips = await waitFor(evl, `document.getElementById('mc-chips') ? document.getElementById('mc-chips').textContent : ''`, 'No categories yet.');
      if (chips === 'No categories yet.') ok('modal shows the (empty) available-categories chips');
      else bad('chips box wrong — "' + chips + '"');

      await evl(`document.getElementById('mc-name').focus()`);
      await type('Shisha');
      await evl(`document.getElementById('mc-create').click()`);
      const cats1 = await waitFor(evl, `API.get('/api/menu/categories').then(a => a.length)`, 1);
      const modalClosed = await waitFor(evl, `!document.getElementById('mc-name')`, true);
      if (cats1 === 1 && modalClosed) ok('created "Shisha" from the header modal (server has 1 category, modal closed)');
      else bad('header create failed — cats=' + cats1 + ' modalOpen=' + !modalClosed);

      // ── 3. Add Product form: select gets "+" and "＋ New Category…" ──────
      await evl(`window.__openAddMenuItem()`); await sleep(400);
      const formUp = await evl(`!!document.getElementById('am-cat')`);
      if (formUp) ok('Add Product modal opens with the Category select');
      else bad('Add Product form did not open');

      const selInfo = await waitFor(evl, `(() => {
        const s = document.getElementById('am-cat');
        if (!s) return null;
        const opts = Array.from(s.options).map(o => o.value);
        const plus = !!s.parentElement.querySelector('button[title="New category"]');
        return { sentinelLast: opts[opts.length - 1] === '__mc_new__', hasShisha: opts.includes('Shisha'), plus };
      })()`, { sentinelLast: true, hasShisha: true, plus: true });
      if (selInfo && selInfo.sentinelLast && selInfo.hasShisha && selInfo.plus) {
        ok('select has [+] button, server category "Shisha" and "＋ New Category…" as last option');
      } else bad('select enhancement wrong — ' + JSON.stringify(selInfo));

      // ── 4. Choose the sentinel → inline row, select reverts ─────────────
      const revert = await evl(`(() => {
        const s = document.getElementById('am-cat');
        const before = s.value;
        s.value = '__mc_new__';
        s.dispatchEvent(new Event('change'));
        const row = s.parentElement.parentElement.querySelector('input[placeholder="New category name…"]');
        return { before, after: s.value, rowShown: !!row && row.parentElement.style.display === 'flex' };
      })()`);
      if (revert && revert.after === revert.before && revert.after !== '__mc_new__' && revert.rowShown) {
        ok('sentinel choice reverts the select and shows the INLINE name row');
      } else bad('sentinel flow wrong — ' + JSON.stringify(revert));

      // ── 5. Create from the inline row with real keystrokes ──────────────
      await evl(`document.querySelector('input[placeholder="New category name…"]').focus()`);
      await type('Happy Hour');
      await evl(`(() => {
        const row = document.querySelector('input[placeholder="New category name…"]').parentElement;
        Array.from(row.querySelectorAll('button')).find(b => b.textContent === 'Create').click();
      })()`);
      const picked = await waitFor(evl, `document.getElementById('am-cat') ? document.getElementById('am-cat').value : ''`, 'Happy Hour');
      if (picked === 'Happy Hour') ok('inline create selects the new category "Happy Hour" in the form');
      else bad('inline create did not select — value=' + picked);

      // ── 6. Save a product under the new category ────────────────────────
      await evl(`(() => {
        document.getElementById('am-name').value = 'Mint Mojito';
        document.getElementById('am-price').value = '7';
      })()`);
      await evl(`(() => {
        const f = document.querySelector('.modal-footer');
        Array.from(f.querySelectorAll('button')).find(b => b.textContent.indexOf('Add Product') !== -1).click();
      })()`);
      const items1 = await waitFor(evl, `API.get('/api/menu').then(m => m.length)`, 1);
      const itemCat = await evl(`API.get('/api/menu').then(m => m[0] ? m[0].category : null)`);
      if (items1 === 1 && itemCat === 'Happy Hour') ok('product saved under the newly created category (round-trip via UI)');
      else bad('product save wrong — n=' + items1 + ' cat=' + itemCat);
      const pageText = await evl(`document.getElementById('content').textContent`);
      if (pageText.includes('Happy Hour') && pageText.includes('Mint Mojito')) ok('page lists the product under its "Happy Hour" group');
      else bad('product/group missing from the page');

      // ── 7. Edit: custom category must be re-selected (no fallback) ──────
      await evl(`(() => {
        const b = Array.from(document.querySelectorAll('#content button')).find(x => x.textContent.trim() === 'Edit');
        b.click();
      })()`);
      const emCat = await waitFor(evl, `document.getElementById('em-cat') ? document.getElementById('em-cat').value : null`, 'Happy Hour');
      if (emCat === 'Happy Hour') ok('Edit re-selects the custom category (no silent fallback to the first option)');
      else bad('edit select fell back — value=' + emCat);

      await evl(`(() => {
        const f = document.querySelector('.modal-footer');
        Array.from(f.querySelectorAll('button')).find(b => b.textContent.indexOf('Save Changes') !== -1).click();
      })()`);
      const savedCat = await waitFor(evl, `API.get('/api/menu').then(m => m[0] ? m[0].category : null)`, 'Happy Hour');
      const modalAfterSave = await waitFor(evl, `!document.getElementById('em-cat')`, true);
      if (savedCat === 'Happy Hour' && modalAfterSave) ok('saving without touching Category leaves it unchanged');
      else bad('save clobbered the category — ' + savedCat);

      // ── 8. Full reload: categories persist server-side ──────────────────
      await evl(`location.reload()`).catch(() => {});
      await sleep(1800);
      await evl(`tryRestoreSession()`); await sleep(1500);
      const restored = await waitFor(evl, `!!(window.App && App.user)`, true, 10000);
      if (!restored) return bad('session did not survive the reload');
      await evl(`navigate('menu')`); await sleep(900);
      const hdrAgain = await evl(`!!Array.from(document.querySelectorAll('#content .page-header button')).find(x => x.textContent.trim() === '+ New Category')`);
      if (hdrAgain) ok('after reload the header "+" re-injects');
      else bad('header "+" gone after reload');

      await evl(`window.__openAddMenuItem()`); await sleep(400);
      const persisted = await waitFor(evl, `(() => {
        const s = document.getElementById('am-cat');
        if (!s) return null;
        const opts = Array.from(s.options).map(o => o.value);
        return opts.includes('Shisha') && opts.includes('Happy Hour') && opts[opts.length - 1] === '__mc_new__';
      })()`, true);
      if (persisted) ok('after reload both created categories are still selectable in the dropdown');
      else bad('created categories did not persist across reload');
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
