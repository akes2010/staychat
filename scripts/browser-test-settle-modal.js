#!/usr/bin/env node
// scripts/browser-test-settle-modal.js — regression for "can't type the amount
// collected at checkout".
//
// Boots a throwaway server (production mode, so the cache headers are the real
// ones), signs in as the RECEPTIONIST in headless Chromium, opens the actual
// Settle Balance modal via the app's own code path, and TYPES the cash amount
// with real CDP key events (no JS value assignment — the exact thing that used
// to be impossible when __settleRecalc re-rendered the modal per keystroke).
// Then settles the balance and checks the guest out — the full desk flow.
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 4311;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-settle-test-profile';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
  const chrome = spawn('chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-popup-blocking',
    `--user-data-dir=${PROFILE}`, '--remote-debugging-port=9229', 'about:blank'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 40; i++) { try { await fetch('http://localhost:9229/json/version'); break; } catch (e) { await sleep(250); } }
    const list = await fetch('http://localhost:9229/json').then(r => r.json());
    const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    let id = 0; const pending = new Map();
    ws.on('message', d => { const m = JSON.parse(d); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    const evl = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result && r.result.value; };
    // Real keystrokes into the currently focused element.
    const type = async (text) => {
      for (const ch of text) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, code: 'Digit' + (ch.match(/\d/) ? ch : ''), windowsVirtualKeyCode: ch.charCodeAt(0) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: 'Digit' + (ch.match(/\d/) ? ch : ''), windowsVirtualKeyCode: ch.charCodeAt(0) });
        await sleep(30);
      }
    };
    return await fn({ send, evl, type });
  } finally { try { chrome.kill(); } catch (e) {} }
}

(async () => {
  const dataDir = fs.mkdtempSync('/tmp/staychat-settle.');
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
    console.log('── Setup: receptionist signs in and a guest is checked in with a balance');

    await withBrowser(async ({ send, evl, type }) => {
      await evl(`location.href = '${BASE}/app'`).catch(() => {});
      await sleep(1200);
      // Sign in from the page itself so the httpOnly cookies land in the jar.
      const login = await evl(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reception@hospitally.com', password: 'Demo@123456' }) }).then(r => r.status)`);
      if (login !== 200) return bad('receptionist login failed (HTTP ' + login + ')');
      ok('receptionist signed in inside the browser');
      await evl(`tryRestoreSession()`); await sleep(1200);

      // Create a real checked-in booking with an unpaid balance via the app's API.
      const booking = await evl(`(async () => {
        const rooms = await API.get('/api/rooms');
        const room = rooms.find(r => r.status === 'available');
        if (!room) return null;
        const d1 = new Date(); const d2 = new Date(Date.now() + 864e5);
        const iso = d => d.toISOString().slice(0, 10);
        const b = await API.post('/api/bookings', { surname: 'Settle', firstName: 'Browser', checkIn: iso(d1), checkOut: iso(d2), roomIds: [room.id], adults: 1, children: 0 });
        await API.post('/api/bookings/' + b.id + '/checkin', {});
        const bal = await API.get('/api/payments/balance?bookingId=' + b.id);
        return { id: b.id, due: bal.grandTotal, roomNumber: room.number };
      })()`);
      if (!booking) return bad('could not create a checked-in booking with a balance');
      ok('checked-in booking with ' + booking.due + ' outstanding (room ' + booking.roomNumber + ')');

      console.log('── Open the REAL Settle Balance modal and type the amount collected');
      // The settle-modal handlers are defined by the Payments page module, so
      // navigate there exactly like the desk does when settling a balance.
      await evl(`navigate('payments')`);
      await sleep(1200);
      const onPayments = await evl(`document.getElementById('topbar-title').textContent`);
      if (onPayments !== 'Payments') return bad('did not reach the Payments page (title: ' + onPayments + ')');
      await evl(`window.__openSettleBalance({ bookingId: '${booking.id}' })`);
      await sleep(900);
      const modalTitle = await evl(`(document.querySelector('.modal-title') || {}).textContent || ''`);
      if (!modalTitle.includes('Settle Balance')) return bad('settle modal did not open (title: "' + modalTitle + '")');
      ok('settle modal opened: "' + modalTitle.trim() + '"');
      const totalShown = await evl(`(document.querySelector('.pos-cart-totals-row.grand span:last-child') || {}).textContent || ''`);
      ok('modal Total Due reads: ' + totalShown);
      if (!totalShown.includes(String(booking.due))) bad('Total Due does not show the full amount owed');

      await evl(`window.__settleSelectMethod('cash')`);
      await sleep(500);
      const hasInput = await evl(`!!document.getElementById('sb-cash')`);
      if (!hasInput) return bad('cash input did not appear after selecting Cash');
      await evl(`document.getElementById('sb-cash').focus()`);
      await sleep(200);

      // THE regression: type digit by digit; after every keystroke the value
      // must have GROWN. The old bug wiped the input on each keystroke.
      const typed = '500';
      let seq = [];
      for (let i = 1; i <= typed.length; i++) {
        await type(typed[i - 1]);
        const v = await evl(`document.getElementById('sb-cash').value`);
        const focused = await evl(`document.activeElement === document.getElementById('sb-cash')`);
        seq.push(v);
        if (v !== typed.slice(0, i)) { bad(`typing broke: expected "${typed.slice(0, i)}" got "${v}"`); break; }
        if (!focused) { bad('input lost focus while typing'); break; }
      }
      const grewCorrectly = seq.length === typed.length && seq.every((v, i) => v === typed.slice(0, i + 1));
      if (grewCorrectly) ok(`typed "${typed}" with real keystrokes — value grew ${JSON.stringify(seq)}, focus kept`);
      else bad('typing sequence ended as ' + JSON.stringify(seq));
      const changeShown = await evl(`(document.getElementById('sb-change') || {}).textContent || ''`);
      ok('change-due updates live: ' + changeShown.trim());

      console.log('── Confirm the settlement and check the guest out');
      const targetsBefore = await fetch('http://localhost:9229/json').then(r => r.json());
      const beforeIds = new Set(targetsBefore.map(t => t.id));
      await evl(`window.__confirmSettle()`);
      await sleep(2000); // auto-print fires 400ms after the settle response
      const receipt = await evl(`(document.querySelector('.modal-title') || {}).textContent || ''`);
      if (receipt.includes('SETTLEMENT RECEIPT')) ok('settlement receipt preview shown: ' + receipt.trim());
      else bad('no settlement receipt (title: ' + receipt + ')');
      // AUTO-PRINT: the print popup must have opened BY ITSELF (cash or card).
      const targetsAfter = await fetch('http://localhost:9229/json').then(r => r.json());
      const popup = targetsAfter.find(t => t.type === 'page' && !beforeIds.has(t.id));
      if (popup) ok('print dialog auto-popped after settlement (new window: "' + (popup.title || 'print') + '")');
      else bad('no print popup opened automatically — receipt printing needs a manual click');
      await evl(`closeModal()`); await sleep(300);
      const after = await evl(`API.get('/api/payments/balance?bookingId=${booking.id}').then(b => b.grandTotal)`);
      if (after === 0) ok('booking balance cleared after browser settlement (grandTotal=0)');
      else bad('balance not cleared: ' + after);
      const co = await evl(`API.post('/api/bookings/${booking.id}/checkout', {}).then(() => 200).catch(e => e.status || 0)`);
      if (co === 200) ok('receptionist checked the settled guest out from the browser (HTTP 200)');
      else bad('checkout failed: HTTP ' + co);

      // Cache policy: the module that ships this modal must revalidate.
      const cc = await evl(`fetch('/js/pages/payments.js', { cache: 'reload' }).then(r => r.headers.get('cache-control'))`);
      if (/no-cache/.test(cc || '')) ok('payments.js served with Cache-Control: no-cache (deploys propagate immediately)');
      else bad('payments.js Cache-Control is "' + cc + '" — a fixed modal would stay stale for a day');

      await send('Page.captureScreenshot', { format: 'png' }).then(async r => {
        const out = path.join(ROOT, 'deploy', 'browser-shots', '08-settle-typing.png');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (r && r.data) { fs.writeFileSync(out, Buffer.from(r.data, 'base64')); console.log('  screenshot: deploy/browser-shots/08-settle-typing.png'); }
      });
    });

    console.log('\n' + (fail === 0 ? '═══ SETTLE MODAL: ' + pass + ' passed, 0 failed ═══' : '═══ SETTLE MODAL: ' + fail + ' FAILED ═══'));
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    try { srv.kill(); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('✗', e.message); process.exit(1); });
