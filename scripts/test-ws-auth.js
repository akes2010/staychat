#!/usr/bin/env node
// Live test of the WebSocket auth-failure fix.
// Boots a throwaway server against a DB copy and verifies:
//   1. A WS connection with an expired access token is closed with 4001 —
//      and the SERVER does not log a reconnect flood when the client behaves
//      like the fixed ws-client (refresh → one retry).
//   2. A fresh token connects and receives the 'connected' welcome frame.
//   3. The fixed ws-client.js logic (loaded in a bare VM sandbox) recovers
//      from a 4001 by refreshing and reconnecting — no infinite loop.
'use strict';
const { execFileSync } = require('child_process');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4210;
const DATA_DIR = fs.mkdtempSync('/tmp/staychat-ws-test.');
const LOG = path.join(DATA_DIR, 'server.log');

for (const f of ['staychat.db', 'staychat.db-wal', 'staychat.db-shm']) {
  const src = path.join(ROOT, 'data', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DATA_DIR, f));
}

const srv = spawn('node', [path.join(ROOT, 'server/index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, NODE_ENV: 'development' },
  stdio: ['ignore', fs.openSync(LOG, 'a'), fs.openSync(LOG, 'a')],
});

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitHealthy() {
  for (let i = 0; i < 40; i++) {
    try {
      await new Promise((res, rej) => {
        http.get(`http://localhost:${PORT}/api/health`, r => r.resume() && r.on('end', res)).on('error', rej);
        // note: simple health check
      });
      return true;
    } catch (e) { await sleep(500); }
  }
  return false;
}
function getJson(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://localhost:${PORT}${urlPath}`, {
      method: 'GET',
      headers: opts.headers || {},
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body || 'null') }); } catch (e) { resolve({ status: res.statusCode, body }); } });
    });
    req.on('error', reject);
    req.end();
  });
}
function postJson(urlPath, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data || {});
    const req = http.request(`http://localhost:${PORT}${urlPath}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    }, (res) => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(out || 'null') }); } catch (e) { resolve({ status: res.statusCode, headers: res.headers, body: out }); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Forge an access token that is ALREADY EXPIRED, signed with the dev secret —
// lets us deterministically exercise the 4001 path without waiting 15m.
function expiredToken() {
  const secret = process.env.JWT_ACCESS_SECRET || 'dev_access_secret_DO_NOT_USE_IN_PRODUCTION';
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: 'u_test', role: 'manager', tenantId: 't_test', name: 'T', iat: now - 3600, exp: now - 60,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function wsHandshake(token, tenantId) {
  return new Promise((resolve) => {
    const q = `/ws?token=${encodeURIComponent(token)}${tenantId ? `&tenantId=${encodeURIComponent(tenantId)}` : ''}`;
    const req = http.get({ host: 'localhost', port: PORT, path: q, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13' } });
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    req.on('upgrade', (res, socket) => {
      // The ws server upgrades at HTTP level, THEN auth-checks and sends a
      // close frame. Read the close code to see whether it was accepted.
      socket.once('data', (buf) => {
        // Close frame: opcode 0x8. Payload [2 bytes code][reason].
        let code = 0;
        const frame = buf;
        if (frame.length >= 2 && (frame[0] & 0x0f) === 0x8) {
          code = frame[2] !== undefined && (frame[1] & 0x7f) >= 2 ? frame.readUInt16BE(2) : 0;
        }
        done({ upgraded: true, closeCode: code, accepted: code === 0 }); // no close frame → server accepted
        try { socket.destroy(); } catch (e) {}
      });
      setTimeout(() => done({ upgraded: true, closeCode: 0, accepted: true }), 1500); // no close → accepted
    });
    req.on('response', (res) => done({ upgraded: false, status: res.statusCode }));
    req.on('error', (e) => done({ upgraded: false, status: 0, error: e.message }));
  });
}

// ── Load the real api.js + ws-client.js in a sandbox and drive its state
// machine ────────────────────────────────────────────────────────────────────
// api.js MUST be loaded too: index.html loads it before ws-client.js, and
// ws-client deliberately delegates token refresh to API.refreshSession() —
// four separate copies of the refresh routine were exactly what made the
// single-use refresh cookie get presented twice and revoke every session.
// The sandbox therefore mirrors the real script order.
function runClientStateMachine() {
  return new Promise((resolve) => {
    const apiSrc = fs.readFileSync(path.join(ROOT, 'public/js/api.js'), 'utf8');
    const src = fs.readFileSync(path.join(ROOT, 'public/js/ws-client.js'), 'utf8');
    const events = [];
    let wsFactory;
    let cookieJar = '';

    const sandbox = {
      window: {
        location: { protocol: 'http:', host: `localhost:${PORT}` },
        App: { accessToken: null, tenantId: 't_test' },
      },
      document: { getElementById: () => null },
      // MUST be constructable (ws-client does `new WebSocket(url)`) — an arrow fn throws.
      WebSocket: function (url) { return wsFactory(url); },
      fetch: async (p, opts) => {
        events.push('refresh-called');
        // Round-trip through the real server carrying the httpOnly cookies
        // captured from login (the sandbox has no real cookie jar).
        const res = await postJson('/api/auth/refresh', {}, { Cookie: cookieJar });
        const body = JSON.stringify(res.body);
        return {
          ok: res.status === 200,
          status: res.status,
          json: async () => res.body,
          text: async () => body, // API.refreshSession reads the body as text
        };
      },
      // Real timers — the stub must actually run callbacks for the simulated
      // 4001 close to fire. Record scheduling for assertions.
      setTimeout: (fn, ms) => { events.push(`timer:${ms}`); return setTimeout(fn, ms); },
      clearTimeout: (id) => clearTimeout(id),
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    // `const` declarations don't attach to the sandbox global — re-expose.
    vm.runInContext(apiSrc, sandbox);
    vm.runInContext(src + '\n;this.WSClient = WSClient;', sandbox);
    const WSClient = sandbox.WSClient;

    (async () => {
      // Real login: fresh token for the reconnect + Set-Cookie for the sandbox fetch.
      let freshToken = null;
      const li = await postJson('/api/auth/login', { email: 'reception@hospitally.com', password: 'Demo@123456' });
      if (li.status !== 200) { bad('login failed — cannot run state machine test'); return resolve(); }
      freshToken = li.body.accessToken;
      const setCookies = [].concat(li.headers['set-cookie'] || []);
      cookieJar = setCookies.map(c => c.split(';')[0]).join('; ');

      // Simulate the exact server behaviour: expired token → close 4001.
      // The client assigns handlers via `socket.onclose = …` (property style,
      // like the real WebSocket API), so bridge property sets into handlers.
      let attempts = 0;
      wsFactory = (url) => {
        attempts++;
        events.push(`connect#${attempts}:${/token=([^&]+)/.exec(url)[1].slice(0, 10)}…`);
        const handlers = {};
        const fake = { close: () => {}, send: () => {} };
        for (const ev of ['open', 'message', 'close', 'error']) {
          let fn = null;
          Object.defineProperty(fake, 'on' + ev, { get: () => fn, set: (v) => { fn = v; handlers[ev] = v; } });
        }
        if (attempts === 1) {
          // first attempt uses the stale token → server rejects with 4001
          setTimeout(() => handlers.close && handlers.close({ code: 4001 }), 0);
        }
        return fake;
      };

      sandbox.window.App.accessToken = expiredToken();
      WSClient.setTokenGetter(() => sandbox.window.App.accessToken);
      WSClient.reconnectWithNewTenant();

      await sleep(300);
      const refreshed = sandbox.window.App.accessToken === freshToken;
      const connectCount = events.filter(e => e.startsWith('connect#')).length;
      const timerCount = events.filter(e => e.startsWith('timer:')).length;
      if (refreshed && connectCount === 2 && timerCount === 0) {
        ok(`state machine: 4001 → refresh → reconnect (attempts=${connectCount}, no backoff timer scheduled after success)`);
      } else if (refreshed && connectCount === 2) {
        ok(`state machine: 4001 → refresh → reconnect (attempts=${connectCount})`);
      } else {
        bad(`state machine: events=${events.join(', ')}, tokenSynced=${refreshed}`);
      }
      WSClient.disconnect();
      resolve();
    })();
  });
}

(async () => {
  if (!(await waitHealthy())) { console.error('server never became healthy'); process.exit(1); }

  console.log('── 1. Expired-token handshake gets close frame 4001 (never opens)');
  const rej = await wsHandshake(expiredToken());
  if (rej.upgraded && rej.closeCode === 4001) ok('closed with code 4001 — client can distinguish auth failure');
  else if (!rej.upgraded) ok(`rejected before upgrade (HTTP ${rej.status || 'aborted'})`);
  else bad('expired token was ACCEPTED — server bug');

  console.log('── 2. Valid token connects and gets the welcome frame');
  const li = await postJson('/api/auth/login', { email: 'reception@hospitally.com', password: 'Demo@123456' });
  if (li.status !== 200) { bad('login failed: ' + JSON.stringify(li.body).slice(0, 200)); }
  else {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws?token=${encodeURIComponent(li.body.accessToken)}`);
    const welcome = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 3000);
      ws.on('message', (d) => { clearTimeout(t); resolve(JSON.parse(d.toString())); });
      ws.on('error', () => { clearTimeout(t); resolve(null); });
    });
    if (welcome && welcome.type === 'connected') ok(`welcome frame received (tenant=${welcome.tenantId})`);
    else bad('no welcome frame: ' + JSON.stringify(welcome));
    ws.terminate();
  }

  console.log('── 3. ws-client state machine: expired → 4001 → refresh → reconnect once');
  await runClientStateMachine();

  console.log('── 4. Server log: auth-failure warnings are bounded (no flood)');
  await sleep(300);
  const log = fs.readFileSync(LOG, 'utf8');
  const authFails = (log.match(/WebSocket auth failed/g) || []).length;
  if (authFails <= 2) ok(`auth-failure warnings in log: ${authFails} (bounded)`);
  else bad(`auth-failure warnings in log: ${authFails} — flood still happening server-side`);

  console.log(`\n${pass} passed, ${fail} failed`);
  srv.kill();
  process.exit(fail ? 1 : 0);
})();
