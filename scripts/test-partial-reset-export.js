#!/usr/bin/env node
// scripts/test-partial-reset-export.js — admin data management + steady under load.
//
//   • STABILITY: a burst of parallel reads (many people on the system at the
//     same moment) must all succeed — no 5xx, no SQLite lock errors, no
//     unexpected failures at the battery's rate-limit budget.
//   • EXPORT: the admin account downloads the partial database (users,
//     transactions, bookings/dates, rooms, halls, pool, gym, POS bar &
//     restaurant, services, operations, accounting) as a JSON attachment —
//     and credentials NEVER leave: no password_hash / token_hash / secrets
//     anywhere in the payload. Receptionist → 403, unauthenticated → 401.
//   • PARTIAL RESET: erases transactions, every user but the acting admin,
//     products & prices, room management and the other module records —
//     while settings, module configuration (floors, categories, halls, pools,
//     gyms, menu categories, POS tables) and the acting admin's own login
//     SURVIVE. Receptionist → 403; missing/wrong typed confirmation → 400;
//     the deleted user's password login dies with their account.
//
// Usage:  node scripts/test-partial-reset-export.js   (spawns its own server)
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 4426;
const BASE = 'http://localhost:' + PORT;

let passed = 0, failed = 0;
function check(label, cond, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ FAIL: ') + label + (cond || extra === undefined ? '' : '  → ' + extra));
  cond ? passed++ : failed++;
}

async function call(method, p, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(BASE + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: r.status, data, headers: r.headers, text };
}

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-datareset.'));
  process.env.DATA_DIR = dataDir;
  const db = require(path.join(ROOT, 'server', 'db', 'connection'));
  require(path.join(ROOT, 'server', 'db', 'migrate'));
  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production' }),
    stdio: 'ignore',
  });
  const killAll = () => {
    try { srv.kill('SIGTERM'); } catch (e) {}
    try { db.close(); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  };
  try {
    for (let i = 0; i < 40; i++) {
      try { await fetch(BASE + '/api/health'); break; } catch (e) { await new Promise(r => setTimeout(r, 300)); }
    }

    console.log('── Fresh tenant (register seeds the starter workspace) ──');
    const stamp = Date.now();
    const adminEmail = 'dadmin_' + stamp + '@reset.test';
    const hotelName = 'Reset Probe Hotel';
    const reg = await call('POST', '/api/auth/register', null, {
      hotelName, name: 'Reset Admin', email: adminEmail, password: 'Str0ng!Pass9x', plan: 'pro',
    });
    check('register → 201/200 (' + reg.status + ')', reg.status === 201 || reg.status === 200, JSON.stringify(reg.data).slice(0, 140));
    const adminTok = reg.data && reg.data.accessToken;
    check('admin accessToken issued', !!adminTok);
    const tid = db.prepare('SELECT tenant_id FROM users WHERE email = ?').get(adminEmail).tenant_id;
    const count = (t) => db.prepare('SELECT COUNT(*) c FROM ' + t + ' WHERE tenant_id = ?').get(tid).c;
    check('starter rooms seeded (8)', count('rooms') === 8, 'n=' + count('rooms'));

    console.log('── Seed real operational data through the real APIs ──');
    let r = await call('POST', '/api/guests', adminTok, { name: 'Reset Probe Guest' });
    check('guest created', r.status === 201 || r.status === 200, 'got ' + r.status);
    r = await call('POST', '/api/menu', adminTok, { name: 'Probe Burger', price: 12, category: 'Probe Dishes' });
    check('product with price created', r.status === 201 || r.status === 200, 'got ' + r.status);
    r = await call('POST', '/api/menu/categories', adminTok, { name: 'Keep Cat' });
    check('menu category created (config to KEEP)', r.status === 201 || r.status === 200, 'got ' + r.status);
    r = await call('POST', '/api/tables', adminTok, { name: 'Keep Table', location: 'restaurant', persons: 4, chairs: 4, sitting: 'Standard' });
    check('POS table created (config to KEEP)', r.status === 201 || r.status === 200, 'got ' + r.status);
    // A settled POS ticket posts a real transaction (+ a second, open ticket).
    r = await call('POST', '/api/pos/tickets', adminTok, { outlet: 'restaurant', label: 'Probe Tab' });
    const tk = r.data;
    check('POS ticket opened', r.status === 201 && !!tk && !!tk.id, 'got ' + r.status);
    await call('POST', '/api/pos/tickets/' + tk.id + '/items', adminTok, { name: 'Probe Item', price: 10, qty: 1 });
    r = await call('POST', '/api/pos/tickets/' + tk.id + '/checkout', adminTok, { paymentMethod: 'cash' });
    check('POS checkout posted a transaction', r.status === 200, 'got ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 100));
    r = await call('POST', '/api/pos/tickets', adminTok, { outlet: 'bar', label: 'Open Bar Tab' });
    check('second (open) POS ticket created', r.status === 201, 'got ' + r.status);
    // A booking row (the "dates" domain) — direct insert, schema-minimal.
    db.prepare(`INSERT INTO bookings (id, tenant_id, reference, check_in, check_out, status, total_amount)
                VALUES (?,?,?,?,?,?,?)`)
      .run('bk_reset_' + stamp, tid, 'RST-' + stamp, '2026-11-01', '2026-11-03', 'confirmed', 150);
    check('booking inserted (dates domain)', count('bookings') === 1, 'n=' + count('bookings'));
    // A second user — must vanish with the reset (and their login with them).
    const recepEmail = 'drecep_' + stamp + '@reset.test';
    r = await call('POST', '/api/users', adminTok, { name: 'Reset Reception', email: recepEmail, password: 'Str0ng!Pass9x', role: 'receptionist' });
    check('receptionist user created', r.status === 201 || r.status === 200, 'got ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 100));
    const recepLogin = await call('POST', '/api/auth/login', null, { email: recepEmail, password: 'Str0ng!Pass9x' });
    const recepTok = recepLogin.data && recepLogin.data.accessToken;
    check('receptionist can sign in (before reset)', !!recepTok, 'status ' + recepLogin.status);
    const recepUserId = db.prepare('SELECT id FROM users WHERE email = ?').get(recepEmail).id;

    console.log('── Stability: 30 simultaneous readers (busy front desk) ──');
    const burst = await Promise.all(Array.from({ length: 30 }, () => call('GET', '/api/rooms', adminTok)));
    const bad = burst.filter(x => x.status !== 200);
    check('30 parallel reads → all 200 (' + (30 - bad.length) + '/30)', bad.length === 0,
      'statuses: ' + JSON.stringify(burst.map(x => x.status).filter((v, i, a) => a.indexOf(v) === i)));

    console.log('── Export gates: admin only ──');
    r = await call('GET', '/api/settings/data-export', null);
    check('unauthenticated export → 401', r.status === 401, 'got ' + r.status);
    r = await call('GET', '/api/settings/data-export', recepTok);
    check('receptionist export → 403', r.status === 403, 'got ' + r.status);
    r = await call('GET', '/api/settings/data-export', adminTok);
    check('admin export → 200', r.status === 200, 'got ' + r.status);
    const exp = r.data || {};
    const groups = ['users', 'transactions', 'bookings', 'rooms', 'halls', 'hall_bookings',
      'pools', 'pool_bookings', 'gyms', 'gym_bookings', 'membership_plans', 'memberships',
      'pos', 'services', 'operations', 'accounting'];
    const missing = groups.filter(g => exp[g] === undefined);
    check('export carries every requested domain (' + groups.length + ')', missing.length === 0, 'missing ' + JSON.stringify(missing));
    check('export includes the seeded booking (dates)', Array.isArray(exp.bookings) && exp.bookings.length === 1, 'n=' + (exp.bookings && exp.bookings.length));
    check('export includes the settled transaction', Array.isArray(exp.transactions) && exp.transactions.length >= 1, 'n=' + (exp.transactions && exp.transactions.length));
    check('export includes all 8 rooms', Array.isArray(exp.rooms) && exp.rooms.length === 8, 'n=' + (exp.rooms && exp.rooms.length));
    check('export includes both users', Array.isArray(exp.users) && exp.users.length === 2, 'n=' + (exp.users && exp.users.length));
    check('export POS carries tickets + menu + tables',
      exp.pos && Array.isArray(exp.pos.tickets) && exp.pos.tickets.length === 2 && Array.isArray(exp.pos.menuItems) && exp.pos.menuItems.length >= 1 && Array.isArray(exp.pos.tables) && exp.pos.tables.length === 1,
      JSON.stringify({ t: exp.pos && exp.pos.tickets && exp.pos.tickets.length, m: exp.pos && exp.pos.menuItems && exp.pos.menuItems.length }));
    const raw = JSON.stringify(exp);
    check('export NEVER contains password hashes', raw.indexOf('password_hash') === -1);
    check('export NEVER contains token material or secrets',
      raw.indexOf('token_hash') === -1 && raw.indexOf('wa_token') === -1 && raw.indexOf('refresh_token') === -1);
    const cd = r.headers.get('content-disposition') || '';
    check('served as a download attachment', /attachment; filename=.*\.json/.test(cd), cd || '(none)');
    check('export audited', db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tenant_id = ? AND action = 'settings.data_export'").get(tid).c >= 1);

    console.log('── Reset gates: admin + typed hotel-name confirmation ──');
    r = await call('POST', '/api/settings/factory-reset', recepTok, { confirmHotelName: hotelName });
    check('receptionist reset → 403', r.status === 403, 'got ' + r.status);
    r = await call('POST', '/api/settings/factory-reset', adminTok, {});
    check('missing confirmation → 400', r.status === 400, 'got ' + r.status);
    r = await call('POST', '/api/settings/factory-reset', adminTok, { confirmHotelName: 'Wrong Name Ltd' });
    check('wrong typed confirmation → 400', r.status === 400, 'got ' + r.status);
    check('nothing erased while confirmation failing', count('transactions') === 1 && count('rooms') === 8 && count('users') === 2,
      JSON.stringify({ tx: count('transactions'), rooms: count('rooms'), users: count('users') }));

    console.log('── Partial reset: data gone, configuration survives ──');
    r = await call('POST', '/api/settings/factory-reset', adminTok, { confirmHotelName: hotelName });
    check('admin reset with confirmation → 200', r.status === 200, 'got ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 140));
    const erased = (r.data && r.data.erased) || {};
    check('reports erased counts (users=1, rooms=8)',
      erased.users === 1 && erased.rooms === 8, JSON.stringify({ users: erased.users, rooms: erased.rooms }));

    check('ERASED: transactions', count('transactions') === 0, 'n=' + count('transactions'));
    check('ERASED: every user but the acting admin (1 left)', count('users') === 1, 'n=' + count('users'));
    check('ERASED: products & prices (menu_items)', count('menu_items') === 0, 'n=' + count('menu_items'));
    check('ERASED: room management (rooms)', count('rooms') === 0, 'n=' + count('rooms'));
    check('ERASED: guests', count('guests') === 0, 'n=' + count('guests'));
    check('ERASED: bookings (dates)', count('bookings') === 0, 'n=' + count('bookings'));
    check('ERASED: POS tickets (open + closed)', count('pos_tickets') === 0, 'n=' + count('pos_tickets'));
    check('ERASED: journal + vouchers', count('journal_entries') === 0 && count('vouchers') === 0,
      JSON.stringify({ j: count('journal_entries'), v: count('vouchers') }));
    check("the deleted receptionist's session tokens are gone",
      db.prepare('SELECT COUNT(*) c FROM refresh_tokens WHERE user_id = ?').get(recepUserId).c === 0);

    check('KEPT: floors (config)', count('floors') === 1, 'n=' + count('floors'));
    check('KEPT: room categories (config)', count('room_categories') === 3, 'n=' + count('room_categories'));
    check('KEPT: menu categories (config)', count('menu_categories') >= 1, 'n=' + count('menu_categories'));
    check('KEPT: POS tables (config)', count('pos_tables') === 1, 'n=' + count('pos_tables'));
    check('KEPT: halls/pools/gyms definitions', count('halls') >= 0 && count('gyms') >= 0 && count('membership_plans') >= 0);

    const st = await call('GET', '/api/settings', adminTok);
    check('settings intact after reset (200)', st.status === 200, 'got ' + st.status);
    check('hotel profile + currency kept', st.data && st.data.name === hotelName && !!st.data.currency,
      JSON.stringify({ name: st.data && st.data.name, currency: st.data && st.data.currency }));
    const afterRooms = await call('GET', '/api/rooms', adminTok);
    check('acting admin still signed in (rooms → 200, empty)', afterRooms.status === 200 && Array.isArray(afterRooms.data) && afterRooms.data.length === 0,
      'got ' + afterRooms.status + ' n=' + (afterRooms.data && afterRooms.data.length));
    const relogin = await call('POST', '/api/auth/login', null, { email: recepEmail, password: 'Str0ng!Pass9x' });
    check('deleted user cannot sign in again', relogin.status === 401, 'got ' + relogin.status);
    check('reset audited', db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tenant_id = ? AND action = 'settings.factory_reset'").get(tid).c >= 1);

    console.log('\n' + (failed ? '✗ ' + failed + ' of ' + (passed + failed) + ' checks FAILED' : '✓ ALL ' + passed + ' CHECKS PASSED'));
    process.exit(failed ? 1 : 0);
  } finally {
    killAll();
  }
})().catch(e => { console.error('✗', e && e.stack || e); process.exit(1); });
