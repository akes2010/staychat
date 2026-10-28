#!/usr/bin/env node
// scripts/browser-test-print-style.js — printed output must be DARK and legible.
//
// The desk prints from every screen: slips and reports go through the app's
// window.print(), receipts through printReceiptWindow(). Staff reported the
// printouts as faint and hard to read. This suite drives the real app in
// Chromium, emulates the 'print' media (what Ctrl+P actually renders) and
// asserts:
//   • @media print (app.css): text forced to pure black on white, regardless
//     of screen theme; sidebar/topbar/toasts/buttons dropped from the page;
//     with a modal open, ONLY the modal prints (the dashboard behind it is
//     hidden) — and nothing shows once the modal closes again.
//   • printReceiptWindow (ui.js): thermal receipts render at font-weight 700,
//     A4 at 600 — heavy black ink instead of thin grey.
//   • Transactions view: the desk sees ALL transactions (page fetches the
//     widened ?limit=2000 window), every row offers Reprint, and selecting a
//     transaction reprints exactly THAT record (auto print + preview popup).
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { freePort } = require('./lib/free-port');

const ROOT = path.join(__dirname, '..');
const PORT = 4331;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-print-style-profile';
let CDP = null;

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
  CDP = 'http://localhost:' + port;
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-popup-blocking',
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch(CDP + '/json/version'); break; } catch (e) { await sleep(250); } }
    const list = await fetch(CDP + '/json').then(r => r.json());
    const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map();
    ws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evl = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.value; };
    return await fn({ send, evl });
  } finally { try { chrome.kill(); } catch (e) {} }
}

(async () => {
  const dataDir = fs.mkdtempSync('/tmp/staychat-printstyle.');
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
      console.log('── Sign in as reception and land on the dashboard ──');
      await evl(`location.href = '${BASE}/app'`).catch(() => {});
      const ready = await waitFor(evl, `typeof tryRestoreSession === 'function' && typeof API !== 'undefined'`, true, 20000);
      if (ready !== true) return bad('app shell never became ready');
      const login = await evl(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reception@hospitally.com', password: 'Demo@123456' }) }).then(r => r.status)`);
      if (login !== 200) return bad('receptionist login failed (HTTP ' + login + ')');
      await evl(`tryRestoreSession()`);
      const who = await waitFor(evl, `App.user && App.user.email`, 'reception@hospitally.com', 15000);
      if (who !== 'reception@hospitally.com') return bad('session did not restore as receptionist');
      const rendered = await waitFor(evl, `!!document.querySelector('#content h1')`, true, 15000);
      if (rendered !== true) return bad('dashboard never rendered an h1');
      ok('reception signed in, dashboard rendered');

      console.log('── Transactions: view ALL, select one, reprint it ──');
      await evl(`navigate('payments')`);
      const rowsReady = await waitFor(evl, `!!document.querySelector('#content tbody tr')`, true, 15000);
      if (rowsReady !== true) return bad('payments page never listed a transaction row');
      const listing = await evl(`(async () => {
        const txns = await API.get('/api/payments/transactions?limit=2000');
        const rows = document.querySelectorAll('#content tbody tr').length;
        const title = (document.querySelector('#content span[style*="font-weight:700"]') || {}).textContent || 'none';
        return JSON.stringify({ apiCount: txns.length, rows, title, firstId: txns.length ? txns[0].id : null });
      })()`);
      let lst = {}; try { lst = JSON.parse(listing); } catch (e) {}
      lst.apiCount > 0 ? ok('transaction list loaded (' + lst.apiCount + ' records)') : bad('no transactions to select from');
      lst.rows === lst.apiCount ? ok('the page shows EVERY transaction (' + lst.rows + '/' + lst.apiCount + ' rows)') : bad('page shows ' + lst.rows + ' of ' + lst.apiCount + ' transactions');
      lst.title === 'All Transactions' ? ok('section titled "All Transactions"') : bad('section titled "' + lst.title + '"');
      const reprintBtns = await evl(`document.querySelectorAll('[onclick*="__reprintTransaction"]').length`);
      reprintBtns >= (lst.rows || 0) ? ok('every row offers a Reprint button (' + reprintBtns + ')') : bad('only ' + reprintBtns + ' Reprint buttons for ' + lst.rows + ' rows');

      // Capture the print window instead of opening a real one, so we can
      // assert WHICH record was reprinted and that paper really came out.
      await evl(`window.__printed = []; window.__origPrintReceiptWindow = window.__origPrintReceiptWindow || window.printReceiptWindow; window.printReceiptWindow = (r, p) => window.__printed.push({ title: r.title, paper: p });`);
      if (lst.firstId) {
        await evl(`window.__reprintTransaction(${JSON.stringify(lst.firstId)})`);
        const got = await waitFor(evl, `(window.__printed || []).length >= 1`, true, 8000);
        got === true ? ok('reprinting a selected transaction sends it to the printer') : bad('no print window opened for the selected transaction');
        const modalUp = await waitFor(evl, `((document.querySelector('.modal-title') || {}).textContent || '').indexOf('PAYMENT RECEIPT') !== -1`, true, 8000);
        modalUp === true ? ok('receipt preview popup opens for that transaction') : bad('no receipt preview appeared');
        const detail = await evl(`(async () => {
          const t = await API.get('/api/payments/transactions/' + ${JSON.stringify(lst.firstId)});
          const r = window.__pendingReceipt || {};
          const p = (window.__printed || [])[0] || {};
          return JSON.stringify({
            line: (r.lines && r.lines[0] && r.lines[0][2]) || '', want: formatMoney(t.amount),
            ref: (r.meta && r.meta[2] && r.meta[2][1]) || '', wantRef: (t.gateway_ref || t.id),
            paper: p.paper,
          });
        })()`);
        let d = {}; try { d = JSON.parse(detail); } catch (e) {}
        d.line === d.want ? ok('reprint shows the selected transaction\'s exact amount (' + d.line + ')') : bad('reprint amount "' + d.line + '" ≠ ' + d.want);
        d.ref === d.wantRef ? ok('reprint carries the original reference (' + d.ref + ')') : bad('reference "' + d.ref + '" ≠ ' + d.wantRef);
        d.paper === '210mm' ? ok('reprint defaults to A4 paper (210mm)') : bad('reprint paper: ' + d.paper);
        await evl(`closeModal()`);

        // The row-level button (list → select → reprint) must work too.
        await evl(`window.__printed = []; document.querySelector('#content [onclick*="__reprintTransaction"]').click()`);
        const rowPrint = await waitFor(evl, `(window.__printed || []).length >= 1`, true, 8000);
        rowPrint === true ? ok('clicking a row\'s Reprint button prints that transaction too') : bad('row Reprint button did not print');
        await evl(`closeModal()`);
      }

      console.log('── Emulate the PRINT media (what Ctrl+P renders) ──');
      await send('Emulation.setEmulatedMedia', { media: 'print' });
      await sleep(200);

      const sidebarHidden = await evl(`getComputedStyle(document.getElementById('sidebar')).display`);
      sidebarHidden === 'none' ? ok('sidebar dropped from the printed page') : bad('sidebar still prints (display: ' + sidebarHidden + ')');
      const topbarHidden = await evl(`getComputedStyle(document.querySelector('.topbar')).display`);
      topbarHidden === 'none' ? ok('topbar dropped from the printed page') : bad('topbar still prints (display: ' + topbarHidden + ')');
      const htmlBg = await evl(`getComputedStyle(document.documentElement).backgroundColor`);
      htmlBg === 'rgb(255, 255, 255)' ? ok('paper background forced to white (' + htmlBg + ')') : bad('page background on paper: ' + htmlBg);

      const h1Color = await evl(`getComputedStyle(document.querySelector('#content h1')).color`);
      h1Color === 'rgb(0, 0, 0)' ? ok('page heading prints pure black (' + h1Color + ')') : bad('heading prints in theme color: ' + h1Color);
      const subColor = await evl(`(() => { const el = document.querySelector('#content .page-header p'); return el ? getComputedStyle(el).color : 'no-sub'; })()`);
      subColor === 'rgb(0, 0, 0)' ? ok('the muted subtitle line prints pure black too (' + subColor + ')')
        : subColor === 'no-sub' ? ok('no subtitle element on dashboard (heading already verified)')
        : bad('muted grey still printed: ' + subColor);
      const h1Weight = await evl(`getComputedStyle(document.querySelector('#content h1')).fontWeight`);
      Number(h1Weight) >= 800 ? ok('headings print heavy (font-weight ' + h1Weight + ')') : bad('heading weight on paper: ' + h1Weight);

      console.log('── A modal (slip) open: print ONLY the modal ──');
      await evl(`openModal('Print Slip Test', '<div id="slip-body">Room 101 — Wi-Fi voucher ABCD-EFGH</div>', '<button class="btn primary" onclick="closeModal()">Close</button>')`);
      await sleep(150);
      const appHidden = await evl(`getComputedStyle(document.getElementById('app')).display`);
      appHidden === 'none' ? ok('dashboard behind the modal disappears when printing') : bad('app still prints behind the modal (display: ' + appHidden + ')');
      const modalShown = await evl(`getComputedStyle(document.getElementById('modal')).display`);
      modalShown !== 'none' ? ok('the modal itself prints (display: ' + modalShown + ')') : bad('modal does not print (display: ' + modalShown + ')');
      const titleColor = await evl(`getComputedStyle(document.querySelector('.modal-title')).color`);
      titleColor === 'rgb(0, 0, 0)' ? ok('modal title prints pure black') : bad('modal title color on paper: ' + titleColor);
      const footerBtn = await evl(`(() => { const b = document.querySelector('.modal-footer button'); return b ? getComputedStyle(b).display : 'none'; })()`);
      footerBtn === 'none' ? ok('modal buttons are dropped from paper') : bad('modal button still prints: ' + footerBtn);
      await evl(`closeModal()`);
      await sleep(150);
      const appBack = await evl(`getComputedStyle(document.getElementById('app')).display`);
      appBack !== 'none' ? ok('closing the modal restores the normal print (app visible again)') : bad('app stays hidden after closeModal (display: ' + appBack + ')');

      console.log('── Receipts print heavy black ink ──');
      const receiptWeights = await evl(`(() => {
        // The transactions section stubbed the printer — put the real one back.
        if (window.__origPrintReceiptWindow) window.printReceiptWindow = window.__origPrintReceiptWindow;
        const orig = window.open;
        let html = '';
        window.open = () => ({ document: { write: h => { html += h; }, close() {} }, focus() {}, print() {} });
        try {
          printReceiptWindow({ title: 'Receipt', lines: [['Item', '1', '$1.00']] }, '80mm');
          printReceiptWindow({ title: 'Receipt', lines: [['Item', '1', '$1.00']] }, '210mm');
        } finally { window.open = orig; }
        return JSON.stringify({ thermal: html.indexOf('font-weight: 700') !== -1, a4: html.indexOf('font-weight: 600') !== -1, black: html.indexOf('color: #000') !== -1 });
      })()`);
      let rec = {};
      try { rec = JSON.parse(receiptWeights || '{}'); } catch (e) { rec = {}; }
      rec.thermal === true ? ok('thermal receipt body prints at font-weight 700 (dark ink)') : bad('thermal receipt not bolded: ' + receiptWeights);
      rec.a4 === true ? ok('A4 receipt body prints at font-weight 600') : bad('A4 receipt not bolded: ' + receiptWeights);
      rec.black === true ? ok('receipt text is pure #000 black') : bad('receipt color missing: ' + receiptWeights);

      await send('Emulation.setEmulatedMedia', { media: 'screen' });
    });

    console.log('\n════════════════════════════════════════════════');
    console.log(fail === 0 ? ' ✓ ALL ' + pass + ' PRINT-STYLE CHECKS PASSED' : ' ✗ ' + fail + ' of ' + (pass + fail) + ' CHECKS FAILED');
    console.log('════════════════════════════════════════════════');
    process.exit(fail === 0 ? 0 : 1);
  } finally {
    try { srv.kill(); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('✗', e.message); process.exit(1); });
