#!/usr/bin/env node
// scripts/browser-test-checkout-flow.js — end-to-end desk checkout, in a real browser.
//
// Exercises the EXACT front-desk journey with real keystrokes:
//   Rooms → Check Out → "Outstanding Balance" modal → Go to Pay
//   → Payments page auto-opens the Settle Balance modal
//   → select Cash → TYPE the exact amount collected
//   → Confirm Settlement → receipt preview + print dialog AUTO-POPS
//   → the room is checked out automatically behind the receipt.
//
// Also proves a receptionist is refused by the POS API (front desk ≠ restaurant till).
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { freePort } = require('./lib/free-port');
const { normalizeRoomsInCopy } = require('./lib/normalize-rooms');

const ROOT = path.join(__dirname, '..');
const PORT = 4313;
const BASE = 'http://localhost:' + PORT;
const PROFILE = '/tmp/staychat-checkout-flow-profile';
let CDP = null; // our chromium's free DevTools base URL (set in withBrowser)

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Poll an expression until it equals `want` — fixed sleeps race a loaded
// machine, so timing-sensitive assertions wait on a CONDITION instead.
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
  // A free OS-assigned DevTools port per run (9231 was also menu-categories'
  // fixed port, and this suite had no stale-port pre-check at all) — only
  // our chromium can answer on it.
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
    const type = async (text) => {
      for (const ch of text) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, windowsVirtualKeyCode: ch.charCodeAt(0) });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: ch.charCodeAt(0) });
        await sleep(30);
      }
    };
    return await fn({ send, evl, type });
  } finally { try { chrome.kill(); } catch (e) {} }
}

(async () => {
  const dataDir = fs.mkdtempSync('/tmp/staychat-coflow.');
  fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db'), path.join(dataDir, 'staychat.db'));
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(path.join(ROOT, 'data', 'staychat.db' + ext))) fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db' + ext), path.join(dataDir, 'staychat.db' + ext));
  }
  normalizeRoomsInCopy(dataDir); // bookable-inventory precondition (see helper)
  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production' }),
    stdio: 'ignore',
  });
  try {
    await waitHealthy();
    console.log('── Receptionist signs in; a guest is checked into room with a balance');

    await withBrowser(async ({ send, evl, type }) => {
      await evl(`location.href = '${BASE}/app'`).catch(() => {});
      // Wait for the shell's JS to be wired — a fixed sleep races the cold
      // page load and tryRestoreSession()/API silently no-op (the same race
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
      const login = await evl(`fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reception@hospitally.com', password: 'Demo@123456' }) }).then(r => r.status)`);
      if (login !== 200) return bad('receptionist login failed (HTTP ' + login + ')');
      ok('receptionist signed in inside the browser');
      await evl(`tryRestoreSession()`);
      const who = await waitFor(evl, `App.user && App.user.email`, 'reception@hospitally.com', 15000);
      if (who !== 'reception@hospitally.com') return bad('session did not restore as receptionist');

      // Create + check in a booking; remember the room.
      // The dev DB this suite copies keeps CONFIRMED reservations on rooms
      // that are still 'available' (a future hold doesn't flip the status),
      // so creating on the first available room can 409 with "already booked
      // for those dates". Walk the available rooms until one actually takes
      // the booking, and surface any setup failure honestly — a rejected
      // promise evaluates to an Error object whose {status} field otherwise
      // leaks into later assertions as if it were room state.
      const setup = await evl(`(async () => {
        const iso = d => d.toISOString().slice(0, 10);
        const rooms = (await API.get('/api/rooms')).filter(r => r.status === 'available');
        let b = null, usedRoom = null, lastErr = null;
        for (const room of rooms) {
          try {
            b = await API.post('/api/bookings', { surname: 'Walkin', firstName: 'Checkout', checkIn: iso(new Date()), checkOut: iso(new Date(Date.now() + 864e5)), roomIds: [room.id], adults: 1, children: 0 });
            usedRoom = room;
            break;
          } catch (e) { lastErr = e; }
        }
        if (!b) return { __setupError: 'no available room accepts a booking: ' + (lastErr ? ((lastErr.message || '') + ' (HTTP ' + lastErr.status + ')') : 'no available rooms') };
        try { await API.post('/api/bookings/' + b.id + '/checkin', {}); }
        catch (e) { return { __setupError: 'check-in failed: ' + ((e.message || '') + ' (HTTP ' + e.status + ')') }; }
        const after = await API.get('/api/rooms');
        const now = after.find(r => r.id === usedRoom.id);
        return { roomId: usedRoom.id, roomNumber: usedRoom.number, bookingId: b.id, status: now && now.status };
      })()`);
      if (!setup) return bad('could not check a guest in');
      if (setup.__setupError) return bad('setup failed: ' + setup.__setupError);
      if (setup.status !== 'occupied') return bad('room not occupied after check-in: ' + setup.status);
      ok('guest checked into room ' + setup.roomNumber + ' (occupied)');

      console.log('── POS is off-limits to the front desk');
      const posCode = await evl(`fetch('/api/pos/tickets', { credentials: 'include' }).then(r => r.status)`);
      if (posCode === 403) ok('receptionist: GET /api/pos/tickets → 403 (no restaurant till for the desk)');
      else bad('receptionist POS access returned ' + posCode + ' (expected 403)');
      const posNav = await evl(`(function(){ try { navigate('pos'); return 'navigated'; } catch(e) { return 'error'; } })()`);
      const posTitle = await evl(`document.getElementById('topbar-title').textContent`);
      if (posNav === 'navigated' && posTitle !== 'Point of Sale') ok('POS page refused for receptionist (stayed on: ' + posTitle + ')');
      else if (posTitle === 'Point of Sale') bad('receptionist could open the POS page');
      await evl(`navigate('rooms')`); await sleep(800);

      console.log('── Rooms → Check Out → Go to Pay (the real desk journey)');
      await evl(`window.__checkOutRoom('${setup.roomId}')`);
      await waitFor(evl, `((document.querySelector('.modal-title') || {}).textContent || '').includes('Outstanding Balance')`, true);
      const balTitle = await evl(`(document.querySelector('.modal-title') || {}).textContent || ''`);
      if (balTitle.includes('Outstanding Balance')) ok('checkout blocked with "Outstanding Balance" modal');
      else return bad('expected Outstanding Balance modal, got: "' + balTitle + '"');
      const balText = await evl(`document.getElementById('modal').textContent`);
      if (/unpaid balance of/.test(balText)) ok('balance modal names the amount: ' + (balText.match(/unpaid balance of \$[\d.]+/) || [''])[0]);
      else bad('balance modal did not show the unpaid amount');

      // The "Go to Pay" button (same code path as clicking it).
      await evl(`window.__goSettleRoom('${setup.roomId}')`);
      // payments page load + auto-open of the settle modal — poll, don't guess
      await waitFor(evl, `((document.querySelector('.modal-title') || {}).textContent || '').includes('Settle Balance')`, true, 10000);
      const settleTitle = await evl(`(document.querySelector('.modal-title') || {}).textContent || ''`);
      if (settleTitle.includes('Settle Balance')) ok('Payments page auto-opened the Settle Balance modal: "' + settleTitle.trim() + '"');
      else return bad('settle modal did not auto-open (top modal: "' + settleTitle + '")');
      const totalDue = await evl(`(document.querySelector('.pos-cart-totals-row.grand span:last-child') || {}).textContent || ''`);
      ok('Total Due on screen: ' + totalDue);

      console.log('── Type the exact amount collected, in cash');
      await evl(`window.__settleSelectMethod('cash')`);
      const hasInput = await waitFor(evl, `!!document.getElementById('sb-cash')`, true);
      if (!hasInput) return bad('cash input did not appear');
      await evl(`document.getElementById('sb-cash').focus()`);
      await sleep(150);
      const due = parseFloat(String(totalDue).replace(/[^0-9.]/g, '')) || 0;
      const seq = [];
      for (let i = 1; i <= String(due).length; i++) {
        await type(String(due)[i - 1]);
        const v = await waitFor(evl, `document.getElementById('sb-cash').value`, String(due).slice(0, i));
        seq.push(v);
      }
      const grew = seq.length === String(due).length && seq.every((v, i) => v === String(due).slice(0, i + 1));
      if (grew && seq[seq.length - 1] === String(due)) ok(`typed the exact amount ${due} digit-by-digit — ${JSON.stringify(seq)}, focus kept`);
      else return bad('typing failed: ' + JSON.stringify(seq) + ' (wanted ' + due + ')');
      const exactMsg = await evl(`(document.getElementById('sb-change') || {}).textContent || ''`);
      if (/Exact amount/.test(exactMsg)) ok('UI confirms exact amount: "' + exactMsg.trim() + '"');
      else ok('amount box shows: "' + exactMsg.trim() + '"');

      console.log('── Process it: receipt pops + auto-print + auto-checkout');
      const before = await fetch(CDP + '/json').then(r => r.json());
      const beforeIds = new Set(before.map(t => t.id));
      await evl(`window.__confirmSettle()`);
      // settle → receipt → 400ms → auto-print: poll for the receipt instead
      // of guessing the total latency with a fixed sleep.
      await waitFor(evl, `((document.querySelector('.modal-title') || {}).textContent || '').includes('SETTLEMENT RECEIPT')`, true, 10000);
      const receiptTitle = await evl(`(document.querySelector('.modal-title') || {}).textContent || ''`);
      if (receiptTitle.includes('SETTLEMENT RECEIPT')) ok('settlement receipt popped up: "' + receiptTitle.trim() + '"');
      else bad('no receipt popup (top modal: "' + receiptTitle + '")');
      let popup = null;
      for (let i = 0; i < 40 && !popup; i++) {
        const after = await fetch(CDP + '/json').then(r => r.json());
        popup = after.find(t => t.type === 'page' && !beforeIds.has(t.id));
        if (!popup) await sleep(150);
      }
      if (popup) ok('print dialog opened BY ITSELF (window: "' + (popup.title || 'print') + '")');
      else bad('print dialog did not auto-pop');

      const roomStatus = await evl(`API.get('/api/rooms').then(rs => rs.find(r => r.id === '${setup.roomId}').status)`);
      if (roomStatus === 'dirty') ok('room ' + setup.roomNumber + ' automatically checked out behind the receipt (status: dirty → housekeeping)');
      else bad('room not checked out after settle (status: ' + roomStatus + ')');
      const bkStatus = await evl(`API.get('/api/bookings?status=checked_out').then(bs => bs.some(b => b.id === '${setup.bookingId}'))`);
      if (bkStatus) ok('booking is now checked_out');
      const due0 = await evl(`API.get('/api/payments/balance?bookingId=${setup.bookingId}').then(b => b.grandTotal)`);
      if (due0 === 0) ok('balance fully settled (grandTotal=0) — collected ' + due);
      else bad('balance left over: ' + due0);

      await send('Page.captureScreenshot', { format: 'png' }).then(r => {
        const out = path.join(ROOT, 'deploy', 'browser-shots', '09-checkout-cash-flow.png');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (r && r.data) fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
      });
      console.log('  screenshot: deploy/browser-shots/09-checkout-cash-flow.png');
    });

    console.log('\n' + (fail === 0 ? '═══ CHECKOUT FLOW: ' + pass + ' passed, 0 failed ═══' : '═══ CHECKOUT FLOW: ' + fail + ' FAILED ═══'));
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    try { srv.kill(); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('✗', e.message); process.exit(1); });
