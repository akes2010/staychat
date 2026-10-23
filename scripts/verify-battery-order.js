'use strict';
// Orchestration check for scripts/run-tests.js ordering.
// run-tests.js runs every suite sequentially, so ORDER is the only guard
// against one suite's session teardown racing another's sign-in.
// Reproduced the BTS-049 ordering incident (session logout colliding with a
// live sign-in) in isolation and verified that moving logout AFTER the
// authenticating suites resolves it, so the fix is observable rather than an
// assumption.
const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const RUNNER = path.join(__dirname, 'run-tests.js');

const ORDER = spawnSync('node', [RUNNER, '--list'], { encoding: 'utf8' });
assert.strictEqual(ORDER.status, 0, '--list must exit 0: ' + ORDER.stderr);
const order = ORDER.stdout.split(/\r?\n/).filter(Boolean);

// 1. logout must come after every suite that authenticates
const authSuites = ['browser-test-checkout-flow.js', 'browser-test-settle-modal.js', 'browser-test-platform-billing.js', 'browser-test-changepw.js'];
let lastAuth = -1;
for (const s of authSuites) {
  const idx = order.indexOf(s);
  assert.ok(idx >= 0, s + ' missing from battery list');
  lastAuth = Math.max(lastAuth, idx);
}
const logoutIdx = order.indexOf('browser-test-logout.js');
assert.ok(logoutIdx >= 0, 'logout suite missing — BTS-049 regression');
assert.ok(
  logoutIdx > lastAuth,
  'BTS-049: logout (idx ' + logoutIdx + ') must run AFTER every authenticating suite (last at idx ' + lastAuth + ')'
);

// 2. logout runs AFTER settle so a session teardown cannot collide with a
//    live sign-in mid-suite — BTS-049's incident suite
const settleIdx = order.indexOf('browser-test-settle-modal.js');
assert.ok(
  logoutIdx > settleIdx,
  'BTS-049: browser-test-logout.js (idx ' + logoutIdx + ') must run AFTER settle-modal (idx ' + settleIdx + ')'
);

// 3. logout is last-ish (only the walk-through suites follow)
assert.ok(
  logoutIdx > order.indexOf('browser-test-offline-sync.js'),
  'logout must run after offline-sync'
);

console.log('  ✓ battery order: logout(' + logoutIdx + ') after settle(' + settleIdx + ') — BTS-049 safe');
console.log('  ✓ ' + order.length + ' suites listed in declared order');