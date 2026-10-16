#!/usr/bin/env node
// scripts/load-test.js — multi-tenant concurrency load test for StayChat OS.
//
// Proves the system stays up, responsive and tenant-isolated with hundreds to
// ~1000 concurrent staff users spread across multiple tenants. Each virtual
// user (VU) holds a real WebSocket connection (like the SPA does) and runs a
// realistic request loop: page-navigation bursts, single interactions, and —
// for a subset — writes that fan out over the WebSocket layer.
//
// Phases:
//   setup    Seed an ISOLATED database (default ./data/loadtest) with T
//            tenants, U users, rooms, bookings, orders, maintenance items and
//            a manifest the run phase reads.
//   run      Start U VUs across T tenants (HTTP + WS), hold for --duration,
//            report latency percentiles, errors, server RSS/heap, WS
//            rejections and any cross-tenant broadcast leakage.
//   logins   Concurrent login burst (bcrypt path) while a canary probe
//            measures API responsiveness during the burst (event-loop freeze
//            detector).
//   cleanup  Delete the seeded load-test tenants from the isolated DB.
//
// Typical sequence (server MUST run against the isolated DB):
//   node scripts/load-test.js setup --tenants 200 --users 1000   # platform scale
//   (… --tenants 5 for the small-hotel profile)
//   DATA_DIR=./data/loadtest PORT=3100 node server/index.js   # in another shell
//   node scripts/load-test.js run     --users 1000 --duration 60
//   node scripts/load-test.js logins  --users 300
//   node scripts/load-test.js cleanup
//
// The run/logins phases talk to http://127.0.0.1:3100 by default (--base to
// override). Every VU sends its own X-Forwarded-For address so the per-IP
// rate limiters bucket each virtual user separately — exactly like real
// staff on real networks (the server sets `trust proxy 1`).
//
// Exit code 0 = PASS (no 5xx, no server crash, no WS rejections, no
// cross-tenant leakage, p95 under budget). Anything else = FAIL.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const CMD = args._[0] || 'run';

const DATA_DIR = args.datadir || process.env.LOADTEST_DATA_DIR || './data/loadtest';
const MANIFEST_PATH = path.join(DATA_DIR, 'loadtest-manifest.json');
const BASE = args.base || process.env.LOADTEST_BASE || 'http://127.0.0.1:3100';
const WS_BASE = BASE.replace(/^http/, 'ws') + '/ws';

const N_TENANTS = Number(args.tenants || 10);
const N_USERS = Number(args.users || 500);
const DURATION_S = Number(args.duration || 45);
const RAMP_MS = Number(args.ramp || 4000);
const THINK_MS = Number(args.think || 1400);       // avg gap between interactions
const NAV_EVERY_MS = Number(args['nav-every'] || 25000); // page navigation burst
const P95_BUDGET_MS = Number(args['p95-budget'] || 1500);

// Rate limiters key on req.ip (= rightmost X-Forwarded-For hop, since the app
// runs `trust proxy 1`). Give every VU its own synthetic address from the
// benchmarking range 198.18.0.0/15.
function fakeIp(n) {
  const v = (n + 1) % 65534 + 1;
  return `198.18.${(v >> 8) & 255}.${v & 255}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function jitter(base, frac = 0.5) { return base * (1 - frac + Math.random() * frac * 2); }

// Load-generator self-check: if THIS process's event loop stalls, recorded
// latencies include the stall and say nothing about the server. A 100ms
// ticker's drift exposes generator saturation directly.
const genLag = { max: 0, samples: 0, over100ms: 0 };
function startGenLagMonitor() {
  let expected = Date.now() + 100;
  const t = setInterval(() => {
    const now = Date.now();
    const lag = Math.abs(now - expected);
    expected = now + 100;
    genLag.samples++;
    if (lag > genLag.max) genLag.max = lag;
    if (lag > 100) genLag.over100ms++;
  }, 100);
  t.unref && t.unref();
  return t;
}

// ── Stats ────────────────────────────────────────────────────────────────────
function newStats(label) {
  return {
    label,
    startedAt: 0,
    endedAt: 0,
    buckets: new Map(),          // "METHOD /route" -> number[] latencies
    status: {},                  // status code -> count
    connErrors: 0,
    bytesIn: 0,
    timeouts: 0,
    ws: { ok: 0, failed: 0, closedDuringTest: 0, closeCodes: {}, closeCodesAfterOpen: {}, msgs: 0, byType: {}, leaks: 0, leakSamples: [] },
    markers: new Map(),          // probe marker -> { tenantId, receivers:Set<vuIndex> }
    windows: [],                 // per-5s: { t, count, p95, serverCpuPct }
    health: [],                  // { t, rss, heap, ms }
    healthStall: 0,
    serverDown: false,
    finishing: false,
  };
}
function record(stats, method, route, status, ms, bytes) {
  const key = method + ' ' + route;
  if (!stats.buckets.has(key)) stats.buckets.set(key, []);
  stats.buckets.get(key).push(ms);
  stats.status[status] = (stats.status[status] || 0) + 1;
  stats.bytesIn += bytes || 0;
  // 5s window series for the report (was the load steady or herded?)
  const win = Math.floor(Date.now() / 5000);
  if (!stats.windowsRaw) stats.windowsRaw = new Map();
  if (!stats.windowsRaw.has(win)) stats.windowsRaw.set(win, []);
  stats.windowsRaw.get(win).push(ms);
}
function normalizeRoute(p) {
  return p.replace(/\?[^?]*/, '')
    .replace(/\/api\/maintenance\/[^/]+/, '/api/maintenance/:id')
    .replace(/\/api\/auth\/[a-z-]+\/[^/]+/, '/api/auth/:x/:id');
}
function pct(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}
function allLatencies(stats) {
  const all = [];
  for (const arr of stats.buckets.values()) for (let i = 0; i < arr.length; i++) all.push(arr[i]);
  all.sort((a, b) => a - b);
  return all;
}
const fmt = (n, d = 1) => Number(n).toFixed(d);
const kb = (n) => (n / 1024).toFixed(0) + 'KB';

// ── HTTP helper ──────────────────────────────────────────────────────────────
// maxSockets must NOT queue behind the load: a page-navigation herd (1000 VUs
// × 6 endpoints) is exactly what a real browser fleet produces, and queueing
// it inside the generator would measure the generator instead of the server.
const agent = new http.Agent({ keepAlive: true, maxSockets: 16384, maxFreeSockets: 4096, timeout: 20000 });
function api(method, p, opts = {}) {
  const { token, ip, body, timeout = 20000, json = false } = opts;
  return new Promise((resolve) => {
    let u;
    try { u = new URL(p, BASE); } catch (e) { return resolve({ status: 0, ms: 0, bytes: 0, err: 'bad-url' }); }
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const headers = { 'X-Forwarded-For': ip || '198.18.99.1', 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const t0 = process.hrtime.bigint();
    let done = false;
    const finish = (obj) => { if (!done) { done = true; resolve(obj); } };
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent, headers,
    }, (res) => {
      let bytes = 0;
      const chunks = [];
      res.on('data', (c) => { bytes += c.length; if (json && bytes < 256 * 1024) chunks.push(c); });
      res.on('end', () => {
        const out = {
          status: res.statusCode, bytes,
          ms: Number(process.hrtime.bigint() - t0) / 1e6,
        };
        if (json && chunks.length) {
          try { out.json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* ignore */ }
        }
        finish(out);
      });
    });
    req.on('error', (e) => finish({ status: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes: 0, err: e.code || e.message }));
    req.setTimeout(timeout, () => { req.destroy(); finish({ status: 0, ms: Number(process.hrtime.bigint() - t0) / 1e6, bytes: 0, err: 'timeout' }); });
    if (payload) req.write(payload);
    req.end();
  });
}

// ── setup: seed isolated multi-tenant dataset ────────────────────────────────
async function cmdSetup() {
  process.env.DATA_DIR = DATA_DIR;           // BEFORE any db module loads
  require('dotenv').config();                 // .env wins for secrets only (dotenv never overrides)
  process.env.DATA_DIR = DATA_DIR;
  require('../server/db/migrate');
  const db = require('../server/db/connection');
  const { nanoid } = require('nanoid');
  const bcrypt = require('bcryptjs');

  console.log(`→ Setting up isolated load-test DB in ${DATA_DIR}`);
  console.log(`  tenants=${N_TENANTS} users=${N_USERS}`);

  // Idempotent: remove any previous load-test tenants (cascades users, rooms,
  // bookings, maintenance, …) plus their audit rows.
  const wipe = db.transaction(() => {
    db.prepare("DELETE FROM audit_log WHERE tenant_id LIKE 'lt\\_tenant\\_%' ESCAPE '\\'").run();
    db.prepare("DELETE FROM tenants WHERE id LIKE 'lt\\_tenant\\_%' ESCAPE '\\'").run();
  });
  wipe();

  const password = process.env.DEMO_PASSWORD || 'Demo@123456';
  const passwordHash = bcrypt.hashSync(password, 12); // computed ONCE, reused for all test users
  const roles = ['receptionist', 'staff', 'hotel_admin'];

  const insTenant = db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status, email)
                                VALUES (?, ?, ?, 'enterprise', 'active', ?)`);
  const insUser = db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, department, avatar, active)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);
  const insRoom = db.prepare(`INSERT INTO rooms (id, tenant_id, number, type, view, floor, rate, capacity, status, amenities)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insBooking = db.prepare(`INSERT INTO bookings (id, tenant_id, room_id, reference, check_in, check_out, status, total_amount, paid_amount, guest_name, notes)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insBookingRoom = db.prepare(`INSERT INTO booking_rooms (id, tenant_id, booking_id, room_id, room_number, rate, occupant_name)
                                     VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insMaint = db.prepare(`INSERT INTO maintenance_requests (id, tenant_id, room_number, issue, priority, status)
                               VALUES (?, ?, ?, ?, ?, ?)`);
  const insOrder = db.prepare(`INSERT INTO orders (id, tenant_id, room_number, guest_name, items, total, status, note, paid)
                               VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0)`);

  const manifest = { createdAt: new Date().toISOString(), password, tenants: [], users: [], maintenance: {} };
  const statuses = ['available', 'occupied', 'dirty', 'cleaning'];
  const maintStatuses = ['pending', 'in-progress', 'completed'];
  const prio = ['high', 'medium', 'low'];

  const seedAll = db.transaction(() => {
    let u = 0;
    for (let t = 0; t < N_TENANTS; t++) {
      const tenantId = `lt_tenant_${t}`;
      const sub = `loadtest-hotel-${t}`;
      insTenant.run(tenantId, `LoadTest Hotel ${t}`, sub, `ops+lt${t}@loadtest.local`);
      manifest.tenants.push({ id: tenantId, subdomain: sub });

      const usersPerTenant = Math.ceil(N_USERS / N_TENANTS);
      for (let k = 0; k < usersPerTenant && u < N_USERS; k++, u++) {
        const userId = `lt_user_${u}`;
        const role = roles[u % roles.length];
        const email = `ltu${u}@loadtest.local`;
        insUser.run(userId, tenantId, `Load User ${u}`, email, passwordHash, role, 'Front Desk', `U${u % 99}`);
        manifest.users.push({ id: userId, tenant_id: tenantId, name: `Load User ${u}`, email, role, permissions: '[]', permissions_customized: 0 });
      }

      const roomIds = [];
      for (let r = 0; r < 50; r++) {
        const rid = `lt_room_${t}_${r}`;
        roomIds.push({ id: rid, number: String(101 + r) });
        insRoom.run(rid, tenantId, String(101 + r), r % 7 === 0 ? 'Suite' : 'Standard', 'Courtyard',
          Math.floor(r / 25) + 1, 50 + (r % 5) * 25, 2, statuses[r % statuses.length], '["AC","WiFi","TV"]');
      }

      for (let b = 0; b < 100; b++) {
        const bid = `lt_book_${t}_${b}`;
        const room = roomIds[b % roomIds.length];
        const dayIn = (b % 30) - 10;
        const st = ['confirmed', 'checked_in', 'checked_out', 'pending_payment', 'cancelled'][b % 5];
        const guest = `Guest ${t}-${b}`;
        const d = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
        insBooking.run(bid, tenantId, room.id, `LT-${t}-${b}-${nanoid(4).toUpperCase()}`,
          d(dayIn), d(dayIn + 3), st, 100 + (b % 9) * 50,
          st === 'checked_out' || st === 'checked_in' ? 100 : 0, guest, null);
        insBookingRoom.run(`lt_br_${t}_${b}`, tenantId, bid, room.id, room.number, 60, guest);
      }

      manifest.maintenance[tenantId] = [];
      for (let m = 0; m < 20; m++) {
        const mid = `lt_maint_${t}_${m}`;
        manifest.maintenance[tenantId].push(mid);
        insMaint.run(mid, tenantId, String(101 + (m % 50)), `Load-test issue ${m}`, prio[m % 3], maintStatuses[m % 3]);
      }
      for (let o = 0; o < 40; o++) {
        insOrder.run(`lt_order_${t}_${o}`, tenantId, String(101 + (o % 50)), `Guest ${o}`,
          JSON.stringify([{ name: 'Jollof Rice', price: 12, qty: 1 }]), 12, `loadtest order ${o}`);
      }
    }
  });
  seedAll();

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`✓ Seeded ${manifest.tenants.length} tenants, ${manifest.users.length} users, ` +
    `${N_TENANTS * 50} rooms, ${N_TENANTS * 100} bookings, ${N_TENANTS * 40} orders → ${MANIFEST_PATH}`);
  console.log('  Start the server against it:');
  console.log(`  DATA_DIR=${DATA_DIR} PORT=3100 node server/index.js`);
  process.exit(0);
}

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`✗ No manifest at ${MANIFEST_PATH} — run \`node scripts/load-test.js setup\` first.`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

// Mint a real access token with the server's own JWT secret (same as a
// session-restore would hand out) so the run phase tests steady-state usage,
// not the bcrypt login path (that is measured separately by `logins`).
function mintToken(user) {
  const { signAccessToken } = require('../server/utils/tokens');
  return signAccessToken(user);
}

// ── run: N virtual users (HTTP loop + WebSocket) ─────────────────────────────
async function cmdRun(label) {
  require('dotenv').config();
  const manifest = loadManifest();
  const { WebSocket } = require('ws');
  const stats = newStats(label || `run-${N_USERS}`);
  const n = N_USERS;
  const VUS = [];

  // --only-tenant <id>: pin every VU to one hotel (proves a single tenant can
  // hold 500–1000 concurrent staff + WS connections on its own).
  let users = manifest.users;
  if (args['only-tenant']) {
    users = users.filter(u => u.tenant_id === args['only-tenant']);
    if (!users.length) { console.error('no manifest users for tenant ' + args['only-tenant']); process.exit(2); }
  }

  for (let i = 0; i < n; i++) {
    // Spread VUs across ALL manifest users (and therefore all tenants) even
    // when running fewer VUs than there are seeded users.
    const user = users[Math.floor((i / n) * users.length)];
    VUS.push({
      i, user, tenantId: user.tenant_id, token: mintToken(user), ip: fakeIp(i),
      navAt: 0, ws: null, wsOpen: false, alive: true,
      maintIds: manifest.maintenance[user.tenant_id] || [],
    });
  }
  const tenants = new Set(VUS.map(v => v.tenantId));

  // ── WebSocket connect with staggered ramp (avoids SYN-flood rejections) ──
  function connectWS(vu) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
      let sock;
      try { sock = new WebSocket(`${WS_BASE}?token=${encodeURIComponent(vu.token)}`); }
      catch (e) { stats.ws.failed++; return done(false); }
      vu.ws = sock;
      const timer = setTimeout(() => { if (!vu.wsOpen) { try { sock.terminate(); } catch (e) {} done(false); } }, 10000);
      sock.on('open', () => {
        vu.wsOpen = true; stats.ws.ok++; clearTimeout(timer); done(true);
      });
      sock.on('message', (data) => {
        stats.ws.msgs++;
        let msg; try { msg = JSON.parse(data.toString()); } catch (e) { return; }
        stats.ws.byType[msg.type] = (stats.ws.byType[msg.type] || 0) + 1;
        // Tenant-isolation audit: every tenant-scoped payload must belong to
        // the receiving VU's tenant. maintenance.updated carries tenant_id and
        // a probe marker in `issue`, letting us verify fan-out precisely.
        const p = msg.payload;
        if (msg.type === 'maintenance.updated' && p && typeof p === 'object') {
          if (p.tenant_id && p.tenant_id !== vu.tenantId) {
            stats.ws.leaks++;
            if (stats.ws.leakSamples.length < 5) stats.ws.leakSamples.push({ type: msg.type, payloadTenant: p.tenant_id, vuTenant: vu.tenantId });
          }
          if (typeof p.issue === 'string' && p.issue.startsWith('probe-')) {
            if (!stats.markers.has(p.issue)) stats.markers.set(p.issue, { tenantId: p.tenant_id, receivers: new Set() });
            stats.markers.get(p.issue).receivers.add(vu.i);
          }
        }
      });
      sock.on('close', (code) => {
        if (vu.wsOpen) {
          if (!stats.finishing) {
            stats.ws.closedDuringTest++;
            stats.ws.closeCodesAfterOpen[code] = (stats.ws.closeCodesAfterOpen[code] || 0) + 1;
          }
        } else {
          stats.ws.failed++; stats.ws.closeCodes[code] = (stats.ws.closeCodes[code] || 0) + 1;
        }
        vu.wsOpen = false;
      });
      sock.on('error', () => { /* close handler records the failure */ });
    });
  }

  // ── request actions ───────────────────────────────────────────────────────
  const READS = [
    ['GET', '/api/rooms', 0.24],
    ['GET', '/api/bookings', 0.20],
    ['GET', '/api/analytics/summary', 0.16],
    ['GET', '/api/auth/me', 0.10],
    ['GET', '/api/maintenance', 0.10],
    ['GET', '/api/orders', 0.10],
    ['GET', '/api/guests', 0.10],
  ];
  function pickRead() {
    let r = Math.random(), acc = 0;
    for (const [m, p, w] of READS) { acc += w; if (r <= acc) return [m, p]; }
    return ['GET', '/api/rooms'];
  }
  async function doOne(vu) {
    const [method, p] = pickRead();
    const res = await api(method, p, { token: vu.token, ip: vu.ip });
    record(stats, method, normalizeRoute(p), res.status, res.ms, res.bytes);
    if (res.status === 0) { stats.connErrors++; if (res.err === 'timeout') stats.timeouts++; }
  }
  async function navBurst(vu) {
    // A page navigation in the SPA fires its screen's endpoints back-to-back.
    const paths = ['/api/rooms', '/api/bookings', '/api/analytics/summary', '/api/auth/me', '/api/maintenance', '/api/orders'];
    await Promise.all(paths.map(async (p) => {
      const res = await api('GET', p, { token: vu.token, ip: vu.ip });
      record(stats, 'GET', normalizeRoute(p), res.status, res.ms, res.bytes);
      if (res.status === 0) { stats.connErrors++; if (res.err === 'timeout') stats.timeouts++; }
    }));
  }
  let probeSeq = 0;
  async function writeProbe(vu) {
    // Maintenance update → tenant broadcast (exercises the WS fan-out path).
    if (!vu.maintIds.length) return;
    const id = vu.maintIds[probeSeq % vu.maintIds.length];
    const marker = `probe-${vu.tenantId}-${vu.i}-${probeSeq++}`;
    const status = ['pending', 'in-progress', 'completed'][probeSeq % 3];
    const res = await api('PATCH', `/api/maintenance/${id}`, {
      token: vu.token, ip: vu.ip, body: { status, issue: marker },
    });
    record(stats, 'PATCH', '/api/maintenance/:id', res.status, res.ms, res.bytes);
    if (res.status === 0) { stats.connErrors++; if (res.err === 'timeout') stats.timeouts++; }
  }

  // ── health monitor (server liveness + memory + CPU) ─────────────────────
  let monitorOn = true;
  const monitorIp = fakeIp(60000);
  let prevCpu = null;
  (async () => {
    let stall = 0;
    while (monitorOn) {
      const res = await api('GET', '/api/health/detailed', { ip: monitorIp, timeout: 10000, json: true });
      if (res.status === 0) {
        stall++; stats.healthStall = stall;
        if (stall >= 3) stats.serverDown = true;
      } else {
        stall = 0;
        const now = Date.now();
        let cpuPct = null;
        if (res.json && res.json.cpu) {
          const c = res.json.cpu;
          if (prevCpu) {
            const dUs = (c.user - prevCpu.user) + (c.system - prevCpu.system);
            const dtUs = (now - prevCpu.t) * 1000;
            cpuPct = Math.round((dUs / dtUs) * 1000) / 10;
          }
          prevCpu = { user: c.user, system: c.system, t: now };
        }
        stats.health.push({
          t: now,
          rss: res.json ? res.json.memory.rss : undefined,
          heap: res.json ? res.json.memory.heapUsed : undefined,
          cpuPct,
          ms: Math.round(res.ms),
        });
      }
      await sleep(2500);
    }
  })().catch(() => {});

  console.log(`▶ RUN "${stats.label}": ${n} VUs across ${tenants.size} tenants, ${DURATION_S}s, ramp ${RAMP_MS}ms, think ${THINK_MS}ms, nav every ${NAV_EVERY_MS}ms`);
  stats.startedAt = Date.now();
  const endAt = stats.startedAt + DURATION_S * 1000;
  startGenLagMonitor();

  // stagger WS connects across the ramp window
  const connectPromises = VUS.map((vu, idx) =>
    sleep(Math.floor((idx / n) * RAMP_MS)).then(() => connectWS(vu))
  );

  // ── VU main loops ─────────────────────────────────────────────────────────
  const vuLoops = VUS.map(async (vu) => {
    await sleep(Math.floor((vu.i / n) * RAMP_MS) + 200);
    // Spread first page-loads across the nav window — real users don't all
    // hit the app in the same millisecond (a synchronized herd would be a
    // measurement artifact, not a workload property).
    vu.navAt = stats.startedAt + Math.random() * NAV_EVERY_MS;
    const isWriter = vu.i % 10 === 0;
    let nextWrite = Date.now() + jitter(6000, 0.5);
    while (Date.now() < endAt && !stats.serverDown) {
      const now = Date.now();
      if (now >= vu.navAt) {
        vu.navAt = now + jitter(NAV_EVERY_MS, 0.4);
        await navBurst(vu);
      } else if (isWriter && now >= nextWrite) {
        nextWrite = now + jitter(6000, 0.5);
        await writeProbe(vu);
      } else {
        await doOne(vu);
      }
      await sleep(jitter(THINK_MS, 0.5));
    }
    vu.alive = false;
  });

  await Promise.all([...connectPromises, ...vuLoops]);
  // let in-flight broadcasts land
  await sleep(600);
  stats.endedAt = Date.now();
  stats.finishing = true;
  monitorOn = false;
  for (const vu of VUS) { try { vu.ws && vu.ws.close(); } catch (e) {} }
  await sleep(300);

  return report(stats, { vus: n, tenants: tenants.size });
}

// ── logins: bcrypt burst + canary responsiveness probe ───────────────────────
async function cmdLogins() {
  require('dotenv').config();
  const manifest = loadManifest();
  const n = N_USERS;
  const stats = newStats(`logins-${n}`);
  const canary = [];
  let canaryOn = true;

  console.log(`▶ LOGIN BURST: ${n} concurrent POST /api/auth/login + canary probe`);
  stats.startedAt = Date.now();

  // Canary: trivial endpoint on its own rotating IPs — measures how much the
  // bcrypt work stalls the event loop for everybody ELSE while logins run.
  // Records the START time so a request that queued behind a frozen event
  // loop (and completed long after) still counts toward the stall metric.
  (async () => {
    let c = 0;
    while (canaryOn) {
      const startedAt = Date.now();
      const res = await api('GET', '/api/health', { ip: fakeIp(50000 + (c++ % 500)), timeout: 30000 });
      canary.push({ startedAt, ms: res.ms, status: res.status });
      await sleep(Math.max(0, 50 - (Date.now() - startedAt)));
    }
  })().catch(() => {});

  const canaryBefore = canary.filter(c => c.startedAt < burstStart - 200).map(c => c.ms);
  const burstStart = Date.now();
  const results = await Promise.all(Array.from({ length: n }, (_, i) => {
    const u = manifest.users[i % manifest.users.length];
    return sleep(Math.floor((i / n) * 2000)).then(() =>
      api('POST', '/api/auth/login', {
        ip: fakeIp(10000 + i), timeout: 120000,
        body: { email: u.email, password: manifest.password },
      })
    );
  }));
  const burstEnd = Date.now();
  canaryOn = false;
  // Give in-flight canary probes (queued behind a frozen event loop) time to
  // drain so the stall metric reflects what OTHER users would have felt.
  await sleep(3000);

  const lat = results.map(r => r.ms).sort((a, b) => a - b);
  const statuses = {};
  results.forEach(r => { statuses[r.status] = (statuses[r.status] || 0) + 1; });
  const duringBurst = canary.filter(c => c.startedAt >= burstStart - 200 && c.startedAt <= burstEnd)
    .map(c => c.ms).sort((a, b) => a - b);

  stats.endedAt = Date.now();
  const out = {
    label: stats.label,
    logins: {
      total: n, wallMs: burstEnd - burstStart,
      statuses,
      p50: fmt(pct(lat, 50)), p95: fmt(pct(lat, 95)), p99: fmt(pct(lat, 99)), max: fmt(lat[lat.length - 1] || 0),
    },
    canaryDuringBurst: {
      count: duringBurst.length,
      p50: fmt(pct(duringBurst, 50)), p95: fmt(pct(duringBurst, 95)), p99: fmt(pct(duringBurst, 99)),
      max: fmt(duringBurst[duringBurst.length - 1] || 0),
    },
    canaryBeforeBurst: { count: canaryBefore.length, p95: fmt(pct(canaryBefore.slice().sort((a, b) => a - b), 95)) },
  };

  const ok = results.filter(r => r.status === 200).length;
  const eventLoopFrozen = out.canaryDuringBurst.p95 > 1000;
  const pass = ok === n && !eventLoopFrozen;
  out.pass = pass; // machine-readable verdict, same shape as the run phase
  out.failReasons = [];
  if (ok !== n) out.failReasons.push(`${n - ok} of ${n} logins failed (${JSON.stringify(statuses)})`);
  if (eventLoopFrozen) out.failReasons.push(`canary p95 ${out.canaryDuringBurst.p95}ms during burst — event loop frozen for other users`);

  console.log('──────────────────────────────────────────────');
  console.log(` logins: ${ok}/${n} OK  wall=${out.logins.wallMs}ms  p50=${out.logins.p50}ms p95=${out.logins.p95}ms max=${out.logins.max}ms`);
  console.log(` statuses: ${JSON.stringify(statuses)}`);
  console.log(` canary (/api/health) during burst: p50=${out.canaryDuringBurst.p50}ms p95=${out.canaryDuringBurst.p95}ms max=${out.canaryDuringBurst.max}ms (before: p95=${out.canaryBeforeBurst.p95}ms)`);
  console.log(eventLoopFrozen
    ? ` ✗ FAIL — canary p95 ${out.canaryDuringBurst.p95}ms during burst ⇒ event loop frozen for other users`
    : ` ✓ event loop stayed responsive during the login burst`);
  console.log('──────────────────────────────────────────────');

  saveReport(stats, out);
  process.exit(pass ? 0 : 1);
}

// ── report ───────────────────────────────────────────────────────────────────
function report(stats, meta) {
  const all = allLatencies(stats);
  const wallS = (stats.endedAt - stats.startedAt) / 1000;
  const total = all.length;
  const okCount = Object.entries(stats.status).filter(([s]) => s.startsWith('2')).reduce((a, [, c]) => a + c, 0);
  const err4 = Object.entries(stats.status).filter(([s]) => s.startsWith('4')).reduce((a, [, c]) => a + c, 0);
  const err5 = Object.entries(stats.status).filter(([s]) => s.startsWith('5')).reduce((a, [, c]) => a + c, 0);

  const rssStart = stats.health[0] && stats.health[0].rss;
  const rssPeak = stats.health.reduce((m, h) => Math.max(m, parseInt(h.rss) || 0), 0);
  const rssEnd = stats.health.length && stats.health[stats.health.length - 1].rss;
  const heapPeak = stats.health.reduce((m, h) => Math.max(m, parseInt(h.heap) || 0), 0);

  const healthMs = stats.health.map(h => h.ms).sort((a, b) => a - b);
  const cpuSamples = stats.health.map(h => h.cpuPct).filter(c => typeof c === 'number');
  const cpuPeak = cpuSamples.length ? Math.max(...cpuSamples) : null;
  const cpuAvg = cpuSamples.length ? cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length : null;

  const markerSummary = [...stats.markers.entries()].slice(0, 3).map(([m, v]) => ({
    marker: m, tenant: v.tenantId, receivers: v.receivers.size,
  }));
  const markerReceivers = [...stats.markers.values()].map(v => v.receivers.size).sort((a, b) => a - b);

  // per-5s windows: was latency steady or did herds/GC cause the tail?
  const windows = stats.windowsRaw ? [...stats.windowsRaw.entries()]
    .map(([win, arr]) => {
      const s = arr.slice().sort((a, b) => a - b);
      const h = stats.health.filter(x => Math.floor(x.t / 5000) === win);
      const c = h.map(x => x.cpuPct).filter(x => typeof x === 'number');
      return { sec: (win * 5000 - stats.startedAt) / 1000, n: arr.length, p95: fmt(pct(s, 95)), max: fmt(s[s.length - 1]), cpu: c.length ? fmt(Math.max(...c)) : null };
    }).sort((a, b) => a.sec - b.sec) : [];

  const perEndpoint = [...stats.buckets.entries()].map(([k, arr]) => {
    const sorted = arr.slice().sort((a, b) => a - b);
    return { endpoint: k, count: arr.length, p50: fmt(pct(sorted, 50)), p95: fmt(pct(sorted, 95)), p99: fmt(pct(sorted, 99)), max: fmt(sorted[sorted.length - 1]) };
  }).sort((a, b) => b.count - a.count);

  const out = {
    label: stats.label,
    meta: { vus: meta.vus, tenants: meta.tenants, durationS: DURATION_S, thinkMs: THINK_MS, base: BASE },
    wallS: fmt(wallS),
    requests: { total, ok: okCount, err4xx: err4, err5xx: err5, connErrors: stats.connErrors, timeouts: stats.timeouts, rps: fmt(total / wallS), bytesIn: stats.bytesIn, bytesInHuman: kb(stats.bytesIn) },
    statuses: stats.status,
    latencyMs: { p50: fmt(pct(all, 50)), p90: fmt(pct(all, 90)), p95: fmt(pct(all, 95)), p99: fmt(pct(all, 99)), max: fmt(all[all.length - 1] || 0) },
    serverMemory: { rssStart, rssPeak, rssEnd, heapPeak },
    serverCpuPct: { avg: cpuAvg !== null ? fmt(cpuAvg) : null, peak: cpuPeak !== null ? fmt(cpuPeak) : null, samples: cpuSamples.length },
    healthProbeMs: { p50: fmt(pct(healthMs, 50)), p95: fmt(pct(healthMs, 95)), max: fmt(healthMs[healthMs.length - 1] || 0), samples: healthMs.length },
    windows,
    generatorLag: { maxMs: genLag.max, stallsOver100ms: genLag.over100ms, samples: genLag.samples },
    broadcastReach: markerReceivers.length ? { markers: markerReceivers.length, minReceivers: markerReceivers[0], maxReceivers: markerReceivers[markerReceivers.length - 1] } : null,
    ws: { ...stats.ws, markers: markerSummary },
    crossTenantLeaks: stats.ws.leaks,
    serverDown: stats.serverDown,
    perEndpoint,
    passCriteria: { p95BudgetMs: P95_BUDGET_MS },
  };

  const p95 = out.latencyMs.p95;
  const pass = !stats.serverDown && err5 === 0 && stats.connErrors === 0 &&
    stats.ws.failed === 0 && stats.ws.closedDuringTest === 0 && stats.ws.leaks === 0 &&
    p95 <= P95_BUDGET_MS;
  out.pass = pass;
  out.failReasons = [];
  if (stats.serverDown) out.failReasons.push('server became unreachable (crash?)');
  if (err5 > 0) out.failReasons.push(`${err5} 5xx responses`);
  if (stats.connErrors > 0) out.failReasons.push(`${stats.connErrors} connection errors/timeouts`);
  if (stats.ws.failed > 0) out.failReasons.push(`${stats.ws.failed} WS connections rejected/failed`);
  if (stats.ws.closedDuringTest > 0) out.failReasons.push(`${stats.ws.closedDuringTest} WS connections dropped by server mid-test ${JSON.stringify(stats.ws.closeCodesAfterOpen)}`);
  if (stats.ws.leaks > 0) out.failReasons.push(`${stats.ws.leaks} cross-tenant WS messages`);
  if (p95 > P95_BUDGET_MS) out.failReasons.push(`p95 ${p95}ms > budget ${P95_BUDGET_MS}ms`);

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(` ${stats.label} — ${pass ? '✓ PASS' : '✗ FAIL'}`);
  console.log('════════════════════════════════════════════════════════════');
  console.log(` VUs: ${meta.vus} across ${meta.tenants} tenants | duration ${out.wallS}s | think ${THINK_MS}ms`);
  console.log(` Requests: ${total} total, ${fmt(total / wallS)} req/s | 2xx ${okCount} | 4xx ${err4} | 5xx ${err5} | conn-err ${stats.connErrors} | timeouts ${stats.timeouts}`);
  console.log(` Payload in: ${kb(stats.bytesIn)} total`);
  console.log(` Latency: p50=${out.latencyMs.p50}ms p90=${out.latencyMs.p90}ms p95=${out.latencyMs.p95}ms p99=${out.latencyMs.p99}ms max=${out.latencyMs.max}ms`);
  console.log(` Server RSS: start=${rssStart} peak=${rssPeak}MB end=${rssEnd} | heap peak=${heapPeak}MB`);
  if (cpuAvg !== null) console.log(` Server CPU: avg=${fmt(cpuAvg)}% peak=${fmt(cpuPeak)}% (single core = 100%)`);
  console.log(` Generator lag: max=${genLag.max}ms stalls>100ms=${genLag.over100ms}/${genLag.samples}` + (genLag.max > 250 ? '  ⚠️ generator saturated — latencies unreliable' : ''));
  console.log(` Health-probe latency: p50=${out.healthProbeMs.p50}ms p95=${out.healthProbeMs.p95}ms max=${out.healthProbeMs.max}ms`);
  if (windows.length) {
    console.log(' 5s windows (sec | n | p95 | max | serverCPU%):');
    console.log('   ' + windows.map(w => `${Math.round(w.sec)}s:${w.n}/${w.p95}ms/${w.cpu || '-'}%`).join('  '));
  }
  console.log(` WS: connected ${stats.ws.ok}/${meta.vus} failed=${stats.ws.failed} closedDuring=${stats.ws.closedDuringTest} msgs=${stats.ws.msgs}`);
  console.log(` WS by type: ${JSON.stringify(stats.ws.byType)}`);
  console.log(` WS cross-tenant leaks: ${stats.ws.leaks}`);
  if (Object.keys(stats.ws.closeCodes).length) console.log(` WS close codes (pre-open): ${JSON.stringify(stats.ws.closeCodes)}`);
  if (Object.keys(stats.ws.closeCodesAfterOpen).length) console.log(` WS close codes (post-open): ${JSON.stringify(stats.ws.closeCodesAfterOpen)}`);
  if (out.broadcastReach) console.log(` Broadcast reach per probe: markers=${out.broadcastReach.markers} receivers min=${out.broadcastReach.minReceivers} max=${out.broadcastReach.maxReceivers}`);
  console.log(' Per endpoint:');
  for (const e of perEndpoint) console.log(`   ${e.endpoint.padEnd(28)} n=${String(e.count).padStart(6)} p50=${e.p50}ms p95=${e.p95}ms p99=${e.p99}ms max=${e.max}ms`);
  console.log(` Statuses: ${JSON.stringify(stats.status)}`);
  if (out.failReasons.length) console.log(' Failures: ' + out.failReasons.join('; '));
  console.log('════════════════════════════════════════════════════════════\n');

  return saveReport(stats, out);
}

function saveReport(stats, out) {
  const file = path.join('/tmp', `staychat-loadtest-${out.label}-${Date.now()}.json`);
  try { fs.writeFileSync(file, JSON.stringify(out, null, 2)); console.log(' report → ' + file); } catch (e) {}
  return out;
}

// ── cleanup ──────────────────────────────────────────────────────────────────
async function cmdCleanup() {
  process.env.DATA_DIR = DATA_DIR;
  require('dotenv').config();
  process.env.DATA_DIR = DATA_DIR;
  require('../server/db/migrate');
  const db = require('../server/db/connection');
  const n = db.prepare("SELECT COUNT(*) c FROM tenants WHERE id LIKE 'lt\\_tenant\\_%' ESCAPE '\\'").get().c;
  const wipe = db.transaction(() => {
    db.prepare("DELETE FROM audit_log WHERE tenant_id LIKE 'lt\\_tenant\\_%' ESCAPE '\\'").run();
    db.prepare("DELETE FROM tenants WHERE id LIKE 'lt\\_tenant\\_%' ESCAPE '\\'").run();
  });
  wipe();
  if (fs.existsSync(MANIFEST_PATH)) fs.unlinkSync(MANIFEST_PATH);
  console.log(`✓ removed ${n} load-test tenants from ${DATA_DIR}`);
  process.exit(0);
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  try {
    if (CMD === 'setup') await cmdSetup();
    else if (CMD === 'run') { const out = await cmdRun(args.label || `run-${N_USERS}`); process.exit(out.pass ? 0 : 1); }
    else if (CMD === 'logins') await cmdLogins();
    else if (CMD === 'cleanup') await cmdCleanup();
    else { console.error('unknown command: ' + CMD + ' (setup|run|logins|cleanup)'); process.exit(2); }
  } catch (e) {
    console.error('load-test error:', e);
    process.exit(1);
  }
})();
