#!/usr/bin/env node
// scripts/test-reports-csv.js — the CSV export must always answer.
//
// Regression: GET /api/reports/:type/csv wraps the shared runReport() engine
// with a fake response and relies on its `done` callback to send the real
// reply — but the engine's `default:` branch did `return res.status(404)`
// against the FAKE response, never calling done(). The request hung forever
// (curl exit 28, HTTP 000) instead of returning the 404 the JSON endpoint
// gives. This suite pins the contract for BOTH endpoints:
//
//   • unknown type → JSON endpoint 404s (unchanged behaviour)
//   • unknown type → CSV endpoint 404s WITHIN A DEADLINE (no hang)
//   • known type   → CSV endpoint streams a real text/csv download
//
// Self-contained: registers its own tenant, so it passes on wiped/demo-less
// databases too. Usage:
//   node scripts/test-reports-csv.js             (spawns its own server)
//   PORT=3000 node scripts/test-reports-csv.js  (test a running server)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 4425;
const BASE = 'http://localhost:' + PORT;
const DEADLINE_MS = 5000; // a healthy server answers in <200ms; the bug = never
let srv = null;
let dataDir = null;

async function waitForHealth() {
  for (let i = 0; i < 30; i++) {
    try { await fetch(BASE + '/api/health'); return; } catch (e) { await new Promise(r => setTimeout(r, 400)); }
  }
  throw new Error('server never became healthy');
}

let passed = 0, failed = 0;
function check(label, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ FAIL: ') + label + (cond || extra === undefined ? '' : '  → ' + extra));
  cond ? passed++ : failed++;
}

async function get(p, token) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + p, { headers, signal: AbortSignal.timeout(DEADLINE_MS) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: r.status, type: r.headers.get('content-type') || '', data, text };
}

(async () => {
  if (!process.env.PORT) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-reports-csv.'));
    srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production' }),
      stdio: 'ignore',
    });
    await waitForHealth();
  }

  console.log('── Fresh tenant (owner role has analytics.view) ──');
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hotelName: 'CSV Export Test Hotel', name: 'CSV Admin', email: 'csv_' + Date.now() + '@example.test', password: 'Str0ng!Pass9x' }),
  });
  const regBody = await reg.json().catch(() => null);
  check('register → 200/201 (' + reg.status + ')', reg.status === 200 || reg.status === 201);
  const token = regBody && regBody.accessToken;
  check('accessToken issued', !!token);

  console.log('── Report types catalogue ──');
  const types = await get('/api/reports/types', token);
  check('GET /api/reports/types → 200 (' + types.status + ')', types.status === 200);
  check('catalogue lists "transactions"', Array.isArray(types.data) && types.data.some(t => t.id === 'transactions'));

  console.log('── Known type: CSV download works ──');
  const csv = await get('/api/reports/transactions/csv', token);
  check('GET /api/reports/transactions/csv → 200 (' + csv.status + ')', csv.status === 200, String(csv.data).slice(0, 120));
  check('served as text/csv attachment', csv.type.includes('text/csv'));
  check('body is non-empty CSV', typeof csv.text === 'string' && csv.text.length > 0, JSON.stringify(csv.text).slice(0, 80));

  console.log('── Unknown type: must 404, never hang (the regression) ──');
  let bad404, badCsv;
  try {
    bad404 = await get('/api/reports/not-a-real-type', token);
    check('JSON endpoint → 404 with error (' + bad404.status + ')', bad404.status === 404 && /Unknown report type/.test(String(bad404.data && bad404.data.error)), JSON.stringify(bad404.data).slice(0, 120));
  } catch (e) {
    check('JSON endpoint answers within ' + DEADLINE_MS + 'ms', false, e.name === 'TimeoutError' ? 'REQUEST HUNG' : e.message);
  }
  try {
    badCsv = await get('/api/reports/not-a-real-type/csv', token);
    check('CSV endpoint → 404 with error (' + badCsv.status + ')', badCsv.status === 404 && /Unknown report type/.test(String(badCsv.data && badCsv.data.error)), JSON.stringify(badCsv.data).slice(0, 120));
  } catch (e) {
    check('CSV endpoint answers within ' + DEADLINE_MS + 'ms (was: hung forever)', false, e.name === 'TimeoutError' ? 'REQUEST HUNG — done() never called after default: return' : e.message);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})().finally(() => {
  if (srv) { try { srv.kill('SIGTERM'); } catch (e) {} }
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {} }
});
