#!/usr/bin/env node
// scripts/run-tests.js — run the whole regression battery in one command.
//
//   npm test                everything (incl. the headless-Chromium suites)
//   npm run test:fast       API/server suites only (no browser needed)
//   node scripts/run-tests.js --only browser-test-settle-modal
//
// Suites run SEQUENTIALLY on purpose: each boots its own throwaway server on
// its own port, but running Chromium suites concurrently caused timing flakes.
// ORDER MATTERS: browser-test-logout.js must run after every suite that signs
// in (BTS-049 — a session teardown racing a live sign-in). The order is
// guarded by scripts/verify-battery-order.js.
// Exit code 0 only when every selected suite passes — safe to gate deploys on.
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const FAST = [
  'test-role-gates.js',
  'test-idempotency.js',
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
  'verify-battery-order.js',
];
const BROWSER = [
  'browser-test-platform-billing.js',
  'browser-test-settle-modal.js',
  'browser-test-checkout-flow.js',
  'browser-test-changepw.js',
  'browser-test-offline-sync.js',
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
console.log('════════════════════════════════════════════════');
console.log(' StayChat OS — regression battery (' + suites.length + ' suite' + (suites.length === 1 ? '' : 's') + ')');
console.log('════════════════════════════════════════════════');

(async () => {
  for (const suite of suites) {
    const file = path.join(__dirname, suite);
    const cmd = suite.endsWith('.sh') ? 'bash' : 'node';
    const t0 = Date.now();
    process.stdout.write('\n▶ ' + suite + '\n');
    const code = await new Promise((resolve) => {
      const p = spawn(cmd, [file], { stdio: 'inherit' });
      p.on('exit', resolve);
      p.on('error', () => resolve(1));
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    results.push({ suite, code: code === 0, secs });
    console.log((code === 0 ? '✓ ' : '✗ ') + suite + ' — ' + secs + 's');
  }

  const failed = results.filter(r => !r.code);
  console.log('\n════════════════════════════════════════════════');
  for (const r of results) console.log(' ' + (r.code ? '✓' : '✗') + ' ' + r.suite);
  const total = results.reduce((s, r) => s + Number(r.secs), 0).toFixed(1);
  console.log('════════════════════════════════════════════════');
  console.log(failed.length === 0
    ? ' ✓ ALL ' + results.length + ' SUITES PASSED (' + total + 's)'
    : ' ✗ ' + failed.length + ' of ' + results.length + ' suites FAILED: ' + failed.map(f => f.suite).join(', '));
  console.log('════════════════════════════════════════════════');
  process.exit(failed.length === 0 ? 0 : 1);
})();
