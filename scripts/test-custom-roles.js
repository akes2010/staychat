#!/usr/bin/env node
// scripts/test-custom-roles.js — Waiter/Server floor roles + admin-defined
// custom roles & departments, end to end against a live server.
//
//   • BUILT-IN: waiter (bar) and server (restaurant) are assignable roles with
//     their own permission defaults; each is outlet-locked on the POS and
//     EOD-scoped to their own department, exactly like barman/cashier.
//   • CUSTOM ROLES: the admin creates a role with a permission list, assigns it
//     to a new user, and that user's effective permissions are enforced
//     (allowed endpoint 200, forbidden 403). Reserved/built-in keys are
//     refused; deleting a role with active holders is refused.
//   • CUSTOM DEPARTMENTS: created by the admin, offered to user forms, and
//     deleting one never orphans an existing account (department is free text).
//   • REGRESSION: the built-in role defaults (cashier/barman) are unchanged.
//
// Usage:  node scripts/test-custom-roles.js             (spawns its own server)
//         PORT=3000 node scripts/test-custom-roles.js   (test a running server)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 4428; // 4427 is test-korapay's port — never share
const BASE = 'http://localhost:' + PORT;
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

// ALWAYS kill the scratch server and drop its temp DB, on every exit path: a
// leaked server keeps answering this port, so the NEXT suite's health probe
// passes against the WRONG database (that is exactly how test-korapay got a
// bogus 401 when this suite ran before it in the battery).
function cleanup() {
  if (srv) { try { srv.kill('SIGTERM'); } catch (e) { /* already gone */ } srv = null; }
  if (dataDir) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) { /* best effort */ } dataDir = null; }
}

async function call(method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: r.status, data };
}

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stamp = Date.now();

(async () => {
  if (!process.env.PORT) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-roles.'));
    srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production' }),
      stdio: 'ignore',
    });
    await waitForHealth();
  }

  console.log('── Fresh tenant ──');
  // plan: 'enterprise' — fresh tenants default to starter, and EOD closings
  // are a plan-gated feature (402). Same trick as test-partial-reset-export.
  const reg = await call('POST', '/api/auth/register', null, {
    hotelName: 'Roles Test Hotel', name: 'Roles Admin', email: 'roles_' + stamp + '@example.test', password: 'Str0ng!Pass9x', plan: 'enterprise',
  });
  check('register → 200/201 (' + reg.status + ')', reg.status === 200 || reg.status === 201, JSON.stringify(reg.data).slice(0, 140));
  const admin = reg.data && reg.data.accessToken;
  check('admin accessToken issued', !!admin);

  async function makeUser(name, role, password, department) {
    const email = name.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '_' + stamp + '@example.test';
    const created = await call('POST', '/api/users', admin, { name, email, password, role, department });
    if (created.status >= 300) return { email, error: created };
    const login = await call('POST', '/api/auth/login', null, { email, password });
    return { email, token: login.data && login.data.accessToken, created };
  }

  console.log('── Built-in roles: waiter (bar) + server (restaurant) ──');
  const caps = await call('GET', '/api/users/capabilities', admin);
  check('waiter default permissions', deepEq(caps.data.roleDefaults.waiter, ['pos.use', 'orders.manage', 'attendance.use', 'eod.use']), JSON.stringify(caps.data.roleDefaults.waiter));
  check('server default permissions', deepEq(caps.data.roleDefaults.server, ['pos.use', 'orders.manage', 'attendance.use', 'eod.use']), JSON.stringify(caps.data.roleDefaults.server));
  check('REGRESSION: cashier defaults untouched', deepEq(caps.data.roleDefaults.cashier, ['pos.use', 'eod.use']), JSON.stringify(caps.data.roleDefaults.cashier));
  check('REGRESSION: barman defaults untouched', deepEq(caps.data.roleDefaults.barman, ['pos.use', 'eod.use']), JSON.stringify(caps.data.roleDefaults.barman));
  check('assignableRoles now include waiter + server',
    Array.isArray(caps.data.assignableRoles) && caps.data.assignableRoles.includes('waiter') && caps.data.assignableRoles.includes('server'));

  const waiter = await makeUser('Wanda Waiter', 'waiter', 'Waiter!Pass123');
  check('create user with role=waiter → 201 (' + (waiter.created ? waiter.created.status : 'ERR') + ')', waiter.created && waiter.created.status === 201, JSON.stringify(waiter.created && waiter.created.data).slice(0, 140));
  check('waiter signs in', !!waiter.token);
  const server2 = await makeUser('Sam Server', 'server', 'Server!Pass123');
  check('create user with role=server → 201 (' + (server2.created ? server2.created.status : 'ERR') + ')', server2.created && server2.created.status === 201, JSON.stringify(server2.created && server2.created.data).slice(0, 140));
  check('server signs in', !!server2.token);

  console.log('── Waiter: POS pinned to the bar, EOD = bar ──');
  const wBarTicket = await call('POST', '/api/pos/tickets', waiter.token, { outlet: 'bar', guestName: 'Walk-in' });
  check('waiter may open a BAR ticket', wBarTicket.status < 300, wBarTicket.status + ' ' + JSON.stringify(wBarTicket.data).slice(0, 120));
  const wRestTicket = await call('POST', '/api/pos/tickets', waiter.token, { outlet: 'restaurant', guestName: 'Walk-in' });
  check('waiter REFUSED on the restaurant till (403)', wRestTicket.status === 403, wRestTicket.status + ' ' + JSON.stringify(wRestTicket.data).slice(0, 120));
  const wTickets = await call('GET', '/api/pos/tickets', waiter.token);
  check('waiter ticket list reads 200 (pos.use)', wTickets.status === 200, String(wTickets.status));

  const EOD_DATE = '2099-02-20';
  const wCloseBar = await call('POST', '/api/eod/close', waiter.token, { department: 'bar', date: EOD_DATE });
  check('waiter closes BAR ' + EOD_DATE + ' → 201', wCloseBar.status === 201, wCloseBar.status + ' ' + JSON.stringify(wCloseBar.data).slice(0, 120));
  const wCloseRest = await call('POST', '/api/eod/close', waiter.token, { department: 'restaurant', date: EOD_DATE });
  check('waiter REFUSED to close Restaurant (403)', wCloseRest.status === 403, String(wCloseRest.status));
  const wMine = await call('GET', '/api/eod/mine?date=' + EOD_DATE, waiter.token);
  check('waiter /mine reports department = bar', !!(wMine.data && wMine.data.department === 'bar'), JSON.stringify(wMine.data && wMine.data.department));
  check('waiter REFUSED on Users & Permissions (403)', (await call('GET', '/api/users', waiter.token)).status === 403);
  check('waiter REFUSED on /api/eod/overview (403)', (await call('GET', '/api/eod/overview?date=' + EOD_DATE, waiter.token)).status === 403);

  console.log('── Server: POS pinned to the restaurant, EOD = restaurant ──');
  const sRestTicket = await call('POST', '/api/pos/tickets', server2.token, { outlet: 'restaurant', guestName: 'Walk-in' });
  check('server may open a RESTAURANT ticket', sRestTicket.status < 300, sRestTicket.status + ' ' + JSON.stringify(sRestTicket.data).slice(0, 120));
  const sBarTicket = await call('POST', '/api/pos/tickets', server2.token, { outlet: 'bar', guestName: 'Walk-in' });
  check('server REFUSED on the bar till (403)', sBarTicket.status === 403, String(sBarTicket.status));
  const sClose = await call('POST', '/api/eod/close', server2.token, { department: 'restaurant', date: '2099-02-21' });
  check('server closes Restaurant → 201', sClose.status === 201, String(sClose.status));
  const sCloseBar = await call('POST', '/api/eod/close', server2.token, { department: 'bar', date: '2099-02-21' });
  check('server REFUSED to close Bar (403)', sCloseBar.status === 403, String(sCloseBar.status));

  console.log('── Custom departments (admin-defined) ──');
  const dept = await call('POST', '/api/users/departments', admin, { name: 'Spa & Wellness', icon: '💆' });
  check('create custom department → 201 (' + dept.status + ')', dept.status === 201, JSON.stringify(dept.data).slice(0, 140));
  check('department key slugified', !!(dept.data && dept.data.key === 'spa_wellness'), JSON.stringify(dept.data && dept.data.key));
  // Same NAME → same slugified key → 409. ("Spa and Wellness" would slug to a
  // DIFFERENT key and is legitimately allowed — keys, not labels, are unique.)
  const deptDup = await call('POST', '/api/users/departments', admin, { name: 'Spa & Wellness' });
  check('same-name department refused (409)', deptDup.status === 409, String(deptDup.status));
  const deptList = await call('GET', '/api/users/departments', admin);
  check('custom department listed', Array.isArray(deptList.data) && deptList.data.some(d => d.name === 'Spa & Wellness'));

  console.log('── Custom roles (admin-defined) ──');
  const role = await call('POST', '/api/users/roles', admin, { name: 'Spa Attendant', department: 'Spa & Wellness', permissions: ['eod.use', 'attendance.use'] });
  check('create custom role → 201 (' + role.status + ')', role.status === 201, JSON.stringify(role.data).slice(0, 140));
  check('custom role key slugified', !!(role.data && role.data.key === 'spa_attendant'), JSON.stringify(role.data && role.data.key));
  const reserved = await call('POST', '/api/users/roles', admin, { name: 'Barman', permissions: ['pos.use'] });
  check('reserved key (built-in shadow) refused (400)', reserved.status === 400, String(reserved.status));
  const badPerm = await call('POST', '/api/users/roles', admin, { name: 'Weird Perms', permissions: ['not.a.capability'] });
  check('non-catalogue permission refused (400)', badPerm.status === 400, String(badPerm.status));

  const caps2 = await call('GET', '/api/users/capabilities', admin);
  check('capabilities carries the custom role defaults', !!(caps2.data && caps2.data.roleDefaults && Array.isArray(caps2.data.roleDefaults.spa_attendant) && caps2.data.roleDefaults.spa_attendant.includes('eod.use')));
  check('custom key appears in assignableRoles', !!(caps2.data && caps2.data.assignableRoles && caps2.data.assignableRoles.includes('spa_attendant')));

  const spa = await makeUser('Sade Spa', 'spa_attendant', 'SpaAtt!Pass123', 'Spa & Wellness');
  check('create user with CUSTOM role → 201 (' + (spa.created ? spa.created.status : 'ERR') + ')', spa.created && spa.created.status === 201, JSON.stringify(spa.created && spa.created.data).slice(0, 140));
  check('custom-role user signs in', !!spa.token);
  const spaMine = await call('GET', '/api/eod/mine?date=2099-03-01', spa.token);
  check('custom role ENFORCED — eod.use allowed (200)', spaMine.status === 200, String(spaMine.status));
  check('custom role ENFORCED — users.manage refused (403)', (await call('GET', '/api/users', spa.token)).status === 403);

  console.log('── Editing a custom role re-issues its holders\' sessions ──');
  const permId = role.data && role.data.id;
  const patched = await call('PATCH', '/api/users/roles/' + permId, admin, { permissions: ['eod.use', 'attendance.use', 'payments.use'] });
  check('patch role permissions → 200', patched.status === 200, String(patched.status));
  const spaReLogin = await call('POST', '/api/auth/login', null, { email: spa.email, password: 'SpaAtt!Pass123' });
  const spaTok2 = spaReLogin.data && spaReLogin.data.accessToken;
  check('re-login picks up payments.use (200)', (await call('GET', '/api/payments/transactions', spaTok2)).status === 200);

  console.log('── Guard rails ──');
  const staff = await makeUser('Stella Staff', 'staff', 'Staff!Pass123');
  check('staff cannot manage roles (403)', (await call('POST', '/api/users/roles', staff.token, { name: 'Sneaky' })).status === 403);
  check('staff cannot manage departments (403)', (await call('POST', '/api/users/departments', staff.token, { name: 'Sneaky Dept' })).status === 403);
  check('unauthenticated role create (401)', (await call('POST', '/api/users/roles', null, { name: 'Nope' })).status === 401);

  const delBlocked = await call('DELETE', '/api/users/roles/' + permId, admin);
  check('deleting a role with an ACTIVE holder refused (409)', delBlocked.status === 409, String(delBlocked.status));
  const spaUser = (await call('GET', '/api/users', admin)).data.find(u => u.email === spa.email);
  const off = await call('PATCH', '/api/users/' + spaUser.id, admin, { active: false });
  check('deactivate the holder → 200', off.status === 200, String(off.status));
  const delOk = await call('DELETE', '/api/users/roles/' + permId, admin);
  check('deleting the role now succeeds (200)', delOk.status === 200, String(delOk.status));

  const delDept = await call('DELETE', '/api/users/departments/' + (dept.data && dept.data.id), admin);
  check('delete custom department → 200', delDept.status === 200, String(delDept.status));
  const spaAfter = (await call('GET', '/api/users', admin)).data.find(u => u.email === spa.email);
  check('existing account keeps its department label after delete', !!(spaAfter && spaAfter.department === 'Spa & Wellness'), JSON.stringify(spaAfter && spaAfter.department));

  console.log('\n' + (failed === 0 ? '═══ CUSTOM ROLES: ' + passed + ' passed, 0 failed ═══' : '═══ CUSTOM ROLES: ' + failed + ' FAILED ═══'));
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('✗', e && e.stack || e); cleanup(); process.exit(1); });
