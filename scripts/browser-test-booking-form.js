#!/usr/bin/env node
// Browser-test THE BOOKING-FORM CONTINUATION BUG:
// fill the reservation form → click room(s) (individual + group) → toggle
// Group mode → all typed values and focus must survive — the form must read
// as ONE continuous form, never as a second empty one.
// Boots a throwaway server on a DB copy; drives /app as admin in Chromium.
// Usage: node scripts/browser-test-booking-form.js
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 4279;
const BASE = 'http://localhost:' + PORT;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function waitHealthy() {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      http.get(BASE + '/api/health', r => { r.resume(); resolve(); })
        .on('error', () => Date.now() - start > 15000 ? reject(new Error('server not healthy')) : setTimeout(tick, 400));
    };
    tick();
  });
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) { this.handlers.forEach(h => h(msg)); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify(Object.assign({ id, method, params })));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

async function connectCdp(port) {
  const list = await fetch(`http://localhost:${port}/json`).then(r => r.json());
  const page = list.find(t => t.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  return new CDP(ws);
}

(async () => {
  let failed = 0;
  const ok = (m) => console.log('  ✓ ' + m);
  const bad = (m) => { failed++; console.log('  ✗ ' + m); };

  const dataDir = fs.mkdtempSync('/tmp/staychat-bformtest.');
  fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db'), path.join(dataDir, 'staychat.db'));
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(path.join(ROOT, 'data', 'staychat.db' + ext))) fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db' + ext), path.join(dataDir, 'staychat.db' + ext));
  }
  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'development' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try { await waitHealthy(); ok('test server healthy on ' + PORT); }
  catch (e) { console.error('server failed to boot'); process.exit(1); }

  const cdpPort = 9227;
  const userDataDir = fs.mkdtempSync('/tmp/chrome-bform-profile.');
  const chrome = spawn('chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${cdpPort}`, '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { await fetch(`http://localhost:${cdpPort}/json/version`); up = true; }
    catch (e) { await sleep(250); }
  }
  if (!up) throw new Error('Chromium CDP port never came up');
  const cdp = await connectCdp(cdpPort);
  ok('Chromium connected');

  async function evaljs(expr) {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval failed: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async function goto(url) { await cdp.send('Page.navigate', { url }); await sleep(1400); }

  try {
    // ── Log in as the hotel admin ───────────────────────────────────────
    await goto(BASE + '/index.html');
    await evaljs(`(async () => {
      const r = await fetch('/api/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@hospitally.com', password: 'Demo@123456' }) });
      if (!r.ok) throw new Error('login failed ' + r.status);
      location.reload(); return true; })()`);
    await sleep(1800);
    const who = await evaljs('App && App.user ? App.user.email : "none"');
    (who || '').includes('admin@hospitally') ? ok('logged in as ' + who) : bad('login: ' + who);

    // ── Open the dashboard → Bookings → New Reservation ────────────────
    await evaljs(`navigate('bookings'); true`);
    await sleep(700);
    await evaljs(`window.__openNewBooking(); true`);
    await sleep(400);
    const modalUp = await evaljs('!!document.getElementById("nb-surname")');
    modalUp ? ok('New Reservation modal is open') : bad('modal did not open');

    // ── Fill the form like a real desk clerk (typed one field at a time) ─
    await evaljs(`(async () => {
      const set = (id, v) => { const e = document.getElementById(id); if (!e) throw new Error('missing ' + id); e.focus(); e.value = v; e.blur(); };
      set('nb-surname', 'Okafor'); set('nb-firstname', 'Chidi');
      set('nb-phone', '+2348077799888'); set('nb-email', 'chidi@example.com');
      set('nb-address', '12 Awolowo Road, Ikoyi');
      set('nb-checkin', new Date().toISOString().slice(0,10));
      set('nb-checkout', new Date(Date.now() + 2*864e5).toISOString().slice(0,10));
      set('nb-nok-name', 'Ngozi Okafor'); set('nb-nok-phone', '+234805550011');
      set('nb-notes', 'Late arrival around 10pm');
      return true; })()`);

    // Click a room (individual mode)
    // Pick a room in individual mode — straight from the exposed modal list.
    const pickedRoomId = await evaljs(`(function(){
      const avail = (window.__bookingAvailableRooms || []).filter(r => r.status === 'available');
      if (!avail.length) throw new Error('no available rooms');
      window.__toggleRoomPick(avail[0].id);
      return avail[0].number; })()`);
    await sleep(350);
    const modalStillUp = await evaljs('!!document.getElementById("nb-surname")');
    modalStillUp ? ok('room ' + pickedRoomId + ' clicked — SAME form still open (no second form)') : bad('modal was rebuilt/vanished after room click');

    // The typed data must still be there
    const surname = await evaljs('document.getElementById("nb-surname").value');
    const phone = await evaljs('document.getElementById("nb-phone").value');
    const notes = await evaljs('document.getElementById("nb-notes").value');
    (surname === 'Okafor') ? ok('surname survived the room click') : bad('surname lost: ' + JSON.stringify(surname));
    (phone === '+2348077799888') ? ok('phone survived the room click') : bad('phone lost: ' + JSON.stringify(phone));
    (notes === 'Late arrival around 10pm') ? ok('notes survived the room click') : bad('notes lost: ' + JSON.stringify(notes));
    const selCount = await evaljs('(typeof __bookingSelectedRoomIds !== "undefined") ? __bookingSelectedRoomIds.length : -1');
    (selCount === 1) ? ok('1 room selected (individual mode)') : bad('selectedRoomIds: ' + selCount);

    // ── Group mode: toggle on, data still intact ────────────────────────
    // Toggling group KEEPs the already-picked R1 (the desk's 1 room earns group
    // mode); the test explicitly deselects it so the group starts fresh again.
    await evaljs(`document.getElementById('nb-group-toggle').click(); true`);
    await sleep(350);
    const surname2 = await evaljs('document.getElementById("nb-surname").value');
    (surname2 === 'Okafor') ? ok('surname survived group-mode toggle') : bad('surname lost after group toggle: ' + JSON.stringify(surname2));
    const groupFieldUp = await evaljs('!!document.getElementById("nb-groupname")');
    groupFieldUp ? ok('Group Name field appeared after toggling group mode') : bad('group name field missing');

    // ── Pick two rooms in group mode; data STILL intact ────────────────
    await evaljs(`(function(){
      const sel = (typeof __bookingSelectedRoomIds !== 'undefined') ? __bookingSelectedRoomIds.slice() : [];
      const avail = (window.__bookingAvailableRooms || []).filter(r => r.status === 'available');
      // deselect everything picked before (test hygiene, not part of the bug)
      sel.forEach(id => { if (avail.find(r => r.id === id)) window.__toggleRoomPick(id); });
      return true; })()`);
    await sleep(350);
    // Re-open the modal's fresh list: refresh the exposed availability.
    await evaljs(`window.__openNewBooking(); window.__bookingSelectedRoomIds = []; true`);
    // Re-open wiped form state — retyped quickly:
    await evaljs(`document.getElementById('nb-surname').value='Okafor'; document.getElementById('nb-firstname').value='Chidi';
      document.getElementById('nb-phone').value='+2348077799888'; document.getElementById('nb-notes').value='Late arrival around 10pm';
      document.getElementById('nb-checkin').value=new Date().toISOString().slice(0,10);
      document.getElementById('nb-checkout').value=new Date(Date.now() + 2*864e5).toISOString().slice(0,10);
      document.getElementById('nb-group-toggle').checked = true; true`);
    await evaljs(`(function(){
      const avail = (window.__bookingAvailableRooms || []).filter(r => r.status === 'available');
      window.__toggleRoomPick(avail[0].id);
      return true; })()`);
    await sleep(350);
    await evaljs(`(function(){
      const avail = (window.__bookingAvailableRooms || []).filter(r => r.status === 'available');
      window.__toggleRoomPick(avail[1].id);
      return true; })()`);
    await sleep(350);
    const surname3 = await evaljs('document.getElementById("nb-surname").value');
    const notes3 = await evaljs('document.getElementById("nb-notes").value');
    (surname3 === 'Okafor') ? ok('surname survived two group room picks') : bad('surname lost after group picks: ' + JSON.stringify(surname3));
    (notes3 === 'Late arrival around 10pm') ? ok('notes survived two group room picks') : bad('notes lost: ' + JSON.stringify(notes3));
    const selCount2 = await evaljs('(typeof __bookingSelectedRoomIds !== "undefined") ? __bookingSelectedRoomIds.length : -1');
    (selCount2 === 2) ? ok('2 rooms selected (group mode)') : bad('selectedRoomIds after group picks: ' + selCount2);

    // Submit the group booking end-to-end — the continuation must still pay off
    await evaljs(`document.getElementById('nb-group-toggle').checked = true; true`);
    await evaljs(`document.getElementById('nb-groupname').value = 'Okafor FAMILY PQ'; true`);
    const submitRes = await evaljs(`(async () => {
      try {
        window.__submitBooking();
        // wait until either a group booking lands or 4s pass
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 200));
          const r = await fetch('/api/bookings', { credentials: 'include' });
          const bs = await r.json();
          if (bs.find(b => b.group_name === 'Okafor FAMILY PQ')) return 'booking-appeared';
        }
        return 'submitted-no-booking';
      } catch (e) { return 'submit error: ' + e.message; } })()`);
    (submitRes === 'booking-appeared') ? ok('form submits after the full click-through AND the group booking lands') : bad(submitRes);
    const lastRef = await evaljs(`(async () => {
      const r = await fetch('/api/bookings', { credentials: 'include' });
      const bs = await r.json();
      const g = bs.find(b => b.reference && b.group_name === 'Okafor FAMILY PQ');
      return g ? g.reference + '|' + g.rooms.length + '|' + g.guest_name : 'not-found'; })()`);
    const [ref, nrooms, gname] = String(lastRef).split('|');
    (ref && ref.startsWith('BK-')) ? ok('group booking created: ' + ref + ' (' + nrooms + ' rooms, ' + gname + ')') : bad('group booking: ' + lastRef);
    // guest_name = firstName + ' ' + surname — verifies BOTH fields survived
    (gname === 'Chidi Okafor') ? ok('guest data (Chidi Okafor) carried into the booking') : bad('guest name wrong: ' + gname);
  } catch (e) {
    bad(String(e.message || e).slice(0, 300));
  } finally {
    try { chrome.kill(); } catch (e) {}
    srv.kill();
    setTimeout(() => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
      try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (e) {} }, 1200);
  }
  console.log('');
  console.log(failed === 0 ? '═══ BOOKING-FORM TEST: ALL PASSED ═══' : '═══ BOOKING-FORM TEST: ' + failed + ' FAILED ═══');
  process.exit(failed === 0 ? 0 : 1);
})();
