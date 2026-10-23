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
//   • after a full page reload the categories are still there,
//   • the Export/Import header buttons (menu-export-import.js) round-trip
//     products INCLUDING images, and importing is create-only: duplicates are
//     skipped, invalid rows are reported, and existing products (price,
//     image) are never modified — re-importing the same file is a no-op.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { freePort } = require('./lib/free-port');

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
  // A free OS-assigned DevTools port per run: the old fixed 9231 (also
  // checkout-flow's port) relied on a busy-wait that gave up silently after
  // 5s — this suite could then attach to the PREVIOUS browser and assert
  // against the wrong page. Only our chromium can answer here.
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
      // Condition, not the clock: the reload re-fetches ~40 scripts, so a
      // fixed sleep raced tryRestoreSession() (still undefined → silent
      // no-op). Wait for the shell, then restore with the throttled retry
      // the boot path uses.
      const shellBack = await waitFor(evl, `typeof tryRestoreSession === 'function'`, true, 20000);
      if (shellBack !== true) return bad('app shell did not come back after reload');
      await evl(`tryRestoreSession()`);
      const restored = await waitFor(evl, `(() => {
        if (window.App && App.user) return true;
        const now = Date.now();
        if (!window.__mcLastRestore || now - window.__mcLastRestore > 700) {
          window.__mcLastRestore = now;
          try { Promise.resolve(tryRestoreSession()).catch(() => {}); } catch (e) {}
        }
        return false;
      })()`, true, 20000);
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
      await evl(`closeModal()`); await sleep(300);

      // ── 9. Export/Import buttons injected in the header ─────────────────
      const ioBtns = await waitFor(evl, `(() => {
        const hdr = document.querySelector('#content .page-header');
        if (!hdr) return null;
        const t = Array.from(hdr.querySelectorAll('button')).map(b => b.textContent.trim());
        return { exp: t.includes('⬇ Export'), imp: t.includes('⬆ Import'), input: !!hdr.querySelector('input[type="file"][accept*="json"]') };
      })()`, { exp: true, imp: true, input: true });
      if (ioBtns && ioBtns.exp && ioBtns.imp && ioBtns.input) ok('header carries Export + Import buttons and the hidden JSON file input');
      else bad('export/import header controls missing — ' + JSON.stringify(ioBtns));

      // ── 10. Export snapshot includes the product image (data-URL) ───────
      const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      await evl(`API.get('/api/menu').then(m => API.patch('/api/menu/' + m[0].id, { imageUrl: ${JSON.stringify(TINY_PNG)} }))`);
      const expText = await evl(`window.__mexiExportText()`);
      let exp = null; try { exp = JSON.parse(expText); } catch (e) {}
      if (exp && exp.format === 'staychat-menu-export' && exp.products.length === 1 &&
          exp.products[0].name === 'Mint Mojito' && (exp.products[0].imageUrl || '').indexOf('data:image/png') === 0) {
        ok('export snapshot carries the product WITH its image');
      } else bad('export snapshot wrong — ' + String(expText).slice(0, 160));

      // Clicking the real Export button downloads + toasts
      await evl(`(() => { const b = Array.from(document.querySelectorAll('#content .page-header button')).find(x => x.textContent.trim() === '⬇ Export'); b.click(); })()`);
      const expToast = await waitFor(evl, `(() => { const t = document.querySelector('.toast .toast-msg'); return t ? t.textContent : ''; })()`, 'Exported 1 product (images included)');
      if (expToast === 'Exported 1 product (images included)') ok('Export button toasts the exported count');
      else bad('export button toast wrong — "' + expToast + '"');

      // ── 11. Import: create-only round-trip (dup skipped, bad row reported)
      const importFile = JSON.stringify({ products: [
        { name: 'Mint Mojito', category: 'Happy Hour', outlet: 'both', price: 999 }, // dupe — must NOT be updated
        { name: 'Sunset Cocktail', category: 'Cocktails', outlet: 'bar', price: 9, costPrice: 2.5, imageUrl: TINY_PNG },
        { price: 5 }, // invalid — no name
      ] });
      const rep1 = await evl(`window.__mexiImport(${JSON.stringify(importFile)})`);
      if (rep1 && rep1.total === 3 && rep1.created === 1 && rep1.skipped === 1 && rep1.failed.length === 1) {
        ok('import reports created=1, skipped=1 (duplicate), failed=1 (no name)');
      } else bad('import report wrong — ' + JSON.stringify(rep1));
      const after1 = await evl(`API.get('/api/menu').then(m => ({
        n: m.length,
        price: (m.find(x => x.name === 'Mint Mojito') || {}).price,
        img: ((m.find(x => x.name === 'Mint Mojito') || {}).image_url || '').slice(0, 14),
        bar: (() => { const s = m.find(x => x.name === 'Sunset Cocktail'); return s ? { outlet: s.outlet, img: (s.image_url || '').slice(0, 14) } : null; })(),
      }))`);
      if (after1 && after1.n === 2 && after1.price === 7 && after1.img === 'data:image/png' &&
          after1.bar && after1.bar.outlet === 'bar' && after1.bar.img === 'data:image/png') {
        ok('import created the bar product WITH its image and left the duplicate untouched (price 7, image intact)');
      } else bad('post-import state wrong — ' + JSON.stringify(after1));

      // ── 12. Re-import is a no-op (system untouched) ─────────────────────
      const rep2 = await evl(`window.__mexiImport(${JSON.stringify(importFile)})`);
      if (rep2 && rep2.created === 0 && rep2.skipped === 2 && rep2.failed.length === 1) {
        ok('re-importing the same file creates nothing (both products now skipped)');
      } else bad('re-import report wrong — ' + JSON.stringify(rep2));
      const finalN = await evl(`API.get('/api/menu').then(m => m.length)`);
      if (finalN === 2) ok('product count unchanged after re-import');
      else bad('product count moved after re-import — ' + finalN);
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
