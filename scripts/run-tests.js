#!/usr/bin/env node
// scripts/run-tests.js — run the whole regression battery in one command.
//
//   npm test                everything (incl. the headless-Chromium suites)
//   npm run test:fast       API/server suites only (no browser needed)
//   node scripts/run-tests.js --only browser-test-settle-modal
//   node scripts/run-tests.js --jobs 1     one suite at a time (old behaviour)
//
// API/server suites run sequentially (they are short and some share fixed
// ports). The headless-Chromium suites run two at a time: after d0a30cf each
// suite owns its own server port, OS-assigned DevTools port and Chromium
// profile, so they no longer collide — CPU contention only slows them, and
// every suite waits on conditions rather than the clock.
//
// ORDER MATTERS: browser-test-logout.js must run after every suite that signs
// in (BTS-049 — a session teardown racing a live sign-in). It is therefore a
// barrier: the suites declared before it all finish before it starts, and the
// walk-throughs after it start only once it has exited. The declared order is
// guarded by scripts/verify-battery-order.js.
// Exit code 0 only when every selected suite passes — safe to gate deploys on.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// One machine hammers ONE throwaway server for the whole battery (plus the
// offline-data warm, which now pulls ~100 datasets per sign-in). The
// production per-IP limiter (200/min, server/index.js) would throttle suites
// that mix heavy CRUD with that warm. Suites inherit this unless a caller
// already set it — the production default of 200 is untouched.
process.env.RATE_LIMIT_GLOBAL_MAX = process.env.RATE_LIMIT_GLOBAL_MAX || '5000';

const FAST = [
  'test-onboarding-pack.js',
  'test-role-gates.js',
  'test-idempotency.js',
  'test-partial-reset-export.js',
  'test-custom-roles.js',
  'test-ws-auth.js',
  'test-ota-flow.sh',
  'verify-booking-payment.js',
  'test-reports-csv.js',
  'test-whatsapp-webhook-e2e.js',
  'test-security-probes.js',
  'test-korapay.js',
  'verify-menu-categories-http.js',
  'verify-fitness-http.js',
  'verify-gym-http.js',
  'verify-shifts-http.js',
  'verify-tables-http.js',
  'verify-tenant-settings-http.js',
  'verify-pos-tables-http.js',
  'verify-pos-hall-account-http.js',
  'verify-battery-order.js',
];
const BROWSER = [
  'browser-test-platform-billing.js',
  'browser-test-settle-modal.js',
  'browser-test-checkout-flow.js',
  'browser-test-changepw.js',
  'browser-test-onboarding-modal.js',
  'browser-test-offline-sync.js',
  'browser-test-print-style.js',
  // BTS-049: logout LAST among the signing-in suites — a session teardown
  // racing a live sign-in poisoned later suites. Only walk-throughs follow.
  'browser-test-logout.js',
  'browser-test-ota.js',
  'browser-test-gym.js',
  'browser-test-fitness.js',
  'browser-test-shifts.js',
  'browser-test-menu-categories.js',
  'browser-test-tables.js',
  'browser-test-tenant-branding.js',
  'browser-test-pos-tables.js',
  'browser-test-pos-visual.js',
];

const args = process.argv.slice(2);
const jobsIdx = args.indexOf('--jobs');
const JOBS = jobsIdx >= 0 ? Math.max(1, parseInt(args[jobsIdx + 1], 10) || 1) : 2;
const onlyIdx = args.indexOf('--only');
let suites;
if (onlyIdx >= 0 && args[onlyIdx + 1]) {
  const needle = args[onlyIdx + 1];
  suites = [...FAST, ...BROWSER].filter(s => s.includes(needle));
  if (!suites.length) { console.error('no suite matches --only ' + needle); process.exit(2); }
} else if (args.includes('--fast')) {
  suites = FAST;
} else {
  suites = [...FAST, ...BROWSER];
}

// --list prints the selected suites in declared order and exits; used by
// scripts/verify-battery-order.js to guard the BTS-049 ordering.
if (args.includes('--list')) {
  for (const s of suites) console.log(s);
  process.exit(0);
}

const results = [];
const wallStart = Date.now();

function runSuite(suite, capture) {
  const file = path.join(__dirname, suite);
  const cmd = suite.endsWith('.sh') ? 'bash' : 'node';
  const t0 = Date.now();
  // Captured runs buffer their output so two suites never interleave their
  // lines; the block is printed whole when the suite exits.
  const log = capture ? path.join(os.tmpdir(), 'staychat-suite-' + process.pid + '-' + suite + '.log') : null;
  const out = capture ? fs.openSync(log, 'w') : null;
  return new Promise((resolve) => {
    const done = (code) => {
      if (out !== null) {
        try { fs.closeSync(out); } catch (e) {}
        let text = '';
        try { text = fs.readFileSync(log, 'utf8'); } catch (e) {}
        try { fs.unlinkSync(log); } catch (e) {}
        process.stdout.write('\n▶ ' + suite + '\n' + text);
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      results.push({ suite, code: code === 0, secs });
      console.log((code === 0 ? '✓ ' : '✗ ') + suite + ' — ' + secs + 's');
      resolve(code);
    };
    if (!capture) process.stdout.write('\n▶ ' + suite + '\n');
    const p = spawn(cmd, [file], { stdio: capture ? ['ignore', out, out] : 'inherit' });
    p.on('exit', (code, signal) => done(signal ? 1 : code));
    p.on('error', () => done(1));
  });
}

// Run a list with at most `size` suites in flight; results keep declared order.
async function runPool(list, size) {
  const queue = list.slice();
  const workers = Array.from({ length: Math.max(1, Math.min(size, queue.length)) }, async () => {
    while (queue.length) {
      const suite = queue.shift();
      await runSuite(suite, size > 1);
    }
  });
  await Promise.all(workers);
}

async function runBrowser(list, size) {
  if (size <= 1) return runPool(list, 1);
  // BTS-049 barrier: nothing after logout may overlap it or anything before it.
  const barrier = list.indexOf('browser-test-logout.js');
  if (barrier === -1) return runPool(list, size);
  await runPool(list.slice(0, barrier), size);
  await runPool(list.slice(barrier, barrier + 1), 1);
  await runPool(list.slice(barrier + 1), size);
}

(async () => {
  console.log('════════════════════════════════════════════════');
  console.log(' StayChat OS — regression battery (' + suites.length + ' suite' + (suites.length === 1 ? '' : 's') + ', ' + JOBS + ' browser lane' + (JOBS === 1 ? '' : 's') + ')');
  console.log('════════════════════════════════════════════════');

  const fast = suites.filter(s => FAST.includes(s));
  const browser = suites.filter(s => BROWSER.includes(s));
  await runPool(fast, 1);
  await runBrowser(browser, JOBS);

  // Summary in declared order, whatever order the suites happened to finish.
  const ordered = suites.map(s => results.find(r => r.suite === s)).filter(Boolean);
  const failed = ordered.filter(r => !r.code);
  const summed = ordered.reduce((s, r) => s + Number(r.secs), 0).toFixed(1);
  const wall = ((Date.now() - wallStart) / 1000).toFixed(1);
  console.log('\n════════════════════════════════════════════════');
  for (const r of ordered) console.log(' ' + (r.code ? '✓' : '✗') + ' ' + r.suite);
  console.log('════════════════════════════════════════════════');
  console.log(failed.length === 0
    ? ' ✓ ALL ' + ordered.length + ' SUITES PASSED (wall ' + wall + 's, suite time ' + summed + 's)'
    : ' ✗ ' + failed.length + ' of ' + ordered.length + ' suites FAILED: ' + failed.map(f => f.suite).join(', ') + ' (wall ' + wall + 's)');
  console.log('════════════════════════════════════════════════');
  process.exit(failed.length === 0 ? 0 : 1);
})();
