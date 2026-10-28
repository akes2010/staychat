// server/db/check.js
// Verifies the database actually contains what `npm run seed` promises.
//
// Why this exists: a database can hold tenants/rooms while its demo USERS are
// missing (partial wipe, interrupted seed, restored backup), which leaves the
// documented demo logins dead with only a confusing 401 as the symptom. Run
// this after seeding — `npm run check` — and you get a clear pass/fail instead.
//
// Read-only: this script never inserts, updates, or deletes anything.
//
// CHECK_DEMO_USERS=false skips the demo-tenant/user verification — for hardened
// production deployments where demo accounts were deliberately removed or their
// passwords rotated. In that mode it still verifies the core schema exists and
// is readable, so a broken/unmigrated database still fails the deploy. Default
// is 'true' because this project's documented deploy flow seeds demo data on
// every start (see Dockerfile CMD and the README's Render instructions).
'use strict';

require('dotenv').config();
require('./migrate');
const db = require('./connection');
const bcrypt = require('bcryptjs');

const CHECK_DEMO_USERS = process.env.CHECK_DEMO_USERS !== 'false';

// Must resolve the demo password the SAME way seed.js does, so a seed done
// with a custom DEMO_PASSWORD doesn't produce a false failure here.
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'Demo@123456';

const EXPECTED_TENANTS = ['hospitally', 'azure-beach', 'savanna'];

// [email, role, tenantSubdomain|null] — mirrors seed.js exactly.
// null tenantSubdomain = platform-level account (superadmin).
const EXPECTED_USERS = [
  ['superadmin@staychat.io', 'superadmin', null],
  ['admin@hospitally.com', 'hotel_admin', 'hospitally'],
  ['reception@hospitally.com', 'receptionist', 'hospitally'],
  ['felix@hospitally.com', 'staff', 'hospitally'],
  ['cashier@hospitally.com', 'cashier', 'hospitally'],
  ['barman@hospitally.com', 'barman', 'hospitally'],
  ['waiter@hospitally.com', 'waiter', 'hospitally'],
  ['server@hospitally.com', 'server', 'hospitally'],
  ['accountant@hospitally.com', 'accountant', 'hospitally'],
  ['auditor@hospitally.com', 'auditor', 'hospitally'],
];

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const pass = (msg) => console.log('  ✓ ' + msg);

console.log('→ Checking database: ' + db.name);

// ── 1. Core schema (always checked) ────────────────────────────────────────
const CORE_TABLES = ['tenants', 'users', 'rooms', 'bookings', 'transactions', 'audit_log'];
let coreOk = true;
for (const t of CORE_TABLES) {
  try { db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get(); pass('core table readable: ' + t); }
  catch (e) { fail('core table missing/unreadable: ' + t + ' — run `npm run migrate`'); coreOk = false; }
}
if (!coreOk) process.exit(1);

// ── 2. Demo data (skippable via CHECK_DEMO_USERS=false) ────────────────────
let tenantsChecked = 0;
let usableLogins = 0;

if (!CHECK_DEMO_USERS) {
  console.log('→ CHECK_DEMO_USERS=false — skipping demo tenant/user checks');
} else {
  const tenantCount = db.prepare('SELECT COUNT(*) c FROM tenants').get().c;
  if (tenantCount === 0) {
    console.error('\n✗ FAIL — database is empty (no tenants).');
    console.error('  Run `npm run seed` to create the schema and load demo data, then re-run `npm run check`.');
    process.exit(1);
  }

  const tenants = db.prepare('SELECT id, subdomain FROM tenants').all();
  tenantsChecked = tenants.length;
  const tenantBySubdomain = Object.fromEntries(tenants.map(t => [t.subdomain, t.id]));
  const missingTenants = EXPECTED_TENANTS.filter(s => !tenantBySubdomain[s]);
  if (missingTenants.length === 0) {
    pass(tenants.length + ' tenants present (all ' + EXPECTED_TENANTS.length + ' demo tenants found)');
  } else {
    fail('missing demo tenant(s): ' + missingTenants.join(', ') + ' — run `npm run seed` (it skips when tenants exist; use FORCE_SEED=1 to rebuild, which WIPES existing data)');
  }

  // ── 3. Demo users ────────────────────────────────────────────────────────
  for (const [email, role, subdomain] of EXPECTED_USERS) {
    const user = db.prepare('SELECT id, active, password_hash, tenant_id FROM users WHERE email = ?').get(email);

    if (!user) {
      fail('missing user: ' + email + ' (' + role + ')');
      continue;
    }
    if (!user.active) {
      fail('user exists but is INACTIVE: ' + email + ' — reactivate it in Users & Permissions');
      continue;
    }

    // Password check: catches seeds done with a different DEMO_PASSWORD than the
    // one this run resolves, and orphaned rows whose hash nobody knows.
    if (!bcrypt.compareSync(DEMO_PASSWORD, user.password_hash)) {
      fail('password mismatch for ' + email + ' — it does not match DEMO_PASSWORD. Reset it in the app or re-seed.');
      continue;
    }

    // Tenant linkage must be exact: a superadmin with a tenant_id (or a hotel
    // user without one) logs in but lands in the wrong scope or is rejected by
    // requireTenant with "Account is not linked to a hotel".
    const expectedTenantId = subdomain ? tenantBySubdomain[subdomain] : null;
    if (user.tenant_id !== expectedTenantId) {
      fail('wrong tenant link for ' + email + ' — expected ' + (subdomain || 'null (platform)') + ', found ' + (user.tenant_id || 'null'));
      continue;
    }

    usableLogins++;
    pass(email + ' (' + role + ') — active, password OK, tenant link OK');
  }
}

// ── 4. Summary ─────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error('✗ FAIL — ' + failures + ' problem(s) found' + (CHECK_DEMO_USERS ? ' (' + usableLogins + '/' + EXPECTED_USERS.length + ' demo logins usable)' : '') + '.');
  if (CHECK_DEMO_USERS) {
    console.error('  Fix: re-run `npm run seed` (no-op when tenants exist) or FORCE_SEED=1 npm run seed to rebuild from scratch.');
  } else {
    console.error('  Fix: run `npm run migrate` and inspect the database at ' + db.name);
  }
  process.exit(1);
}
if (CHECK_DEMO_USERS) {
  console.log('✓ PASS — ' + usableLogins + '/' + EXPECTED_USERS.length + ' demo logins verified against ' + tenantsChecked + ' tenant(s).');
  console.log('  Log in at http://localhost:3000 with password: ' + DEMO_PASSWORD);
} else {
  console.log('✓ PASS — core schema verified (demo-user checks skipped via CHECK_DEMO_USERS=false).');
}
