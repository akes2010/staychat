// scripts/verify-gym-http.js
// End-to-end HTTP check for the gym management & booking module: boots the
// REAL Express app on an ephemeral port (temp DATA_DIR) and drives /api/gym/*
// through the actual middleware stack (auth → resolveTenant → requireTenant →
// permission gate → entitlement gate). Covers:
//   gym CRUD (name/type/facilities/capacity/daily-monthly-yearly prices),
//   registration creation with calendar-correct period derivation,
//   per-gym capacity enforcement over overlapping periods + cancel frees a slot,
//   permission gates (gym.use / gym.manage),
//   plan entitlement gate (starter → 402).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-gym-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // ephemeral

const db = require('../server/db/connection');
require('../server/db/migrate');

const { nanoid } = require('nanoid');
const bcrypt = require('bcryptjs');
const { signAccessToken } = require('../server/utils/tokens');

// ── Seed tenants: one 'pro' (entitlement includes gym_bookings), one 'starter'
function makeTenant(plan) {
  const id = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?,?,'active')`)
    .run(id, 'Gym ' + plan + ' Hotel', 'gym-' + nanoid(5), plan);
  return id;
}
function makeUser(tenantId, role) {
  const id = 'user_' + nanoid(8);
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?,?)`)
    .run(id, tenantId, role, role + '-' + nanoid(5) + '@gym.test', bcrypt.hashSync('pw', 8), role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

const proTenant = makeTenant('pro');
const starterTenant = makeTenant('starter');
const admin = makeUser(proTenant, 'hotel_admin');      // gym.use + gym.manage
const desk = makeUser(proTenant, 'receptionist');      // gym.use only
const staff = makeUser(proTenant, 'staff');            // no gym.use
const starterAdmin = makeUser(starterTenant, 'hotel_admin');

const adminTok = signAccessToken(admin);
const deskTok = signAccessToken(desk);
const staffTok = signAccessToken(staff);
const starterTok = signAccessToken(starterAdmin);

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '✓ PASS' : '✗ FAIL') + '  ' + name + (extra ? '  — ' + extra : ''));
}

const { app } = require('../server/index');
const server = app.listen(0, '127.0.0.1');

function req(method, pathName, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: server.address().port, path: pathName, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (e) { json = buf; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function run() {
  await new Promise(resolve => server.once('listening', resolve));

  // ── 1. Gym CRUD ──────────────────────────────────────────────────────
  let r = await req('GET', '/api/gym/gyms', adminTok);
  check('GET /api/gym/gyms as admin → 200 []', r.status === 200 && Array.isArray(r.body) && r.body.length === 0, 'got ' + r.status);

  r = await req('POST', '/api/gym/gyms', adminTok, {
    name: 'Sky Fitness Centre', type: 'Premium',
    facilities: ['Free Weights', 'Sauna', 'Cardio Machines'],
    capacity: 3, priceDaily: 10, priceMonthly: 80, priceYearly: 800,
    description: 'Rooftop gym with a view',
  });
  check('POST /api/gym/gyms → 201', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
  const gym = r.body;
  check('gym round-trips name/type/capacity/prices',
    gym && gym.name === 'Sky Fitness Centre' && gym.type === 'Premium' && gym.capacity === 3 &&
    gym.price_daily === 10 && gym.price_monthly === 80 && gym.price_yearly === 800);
  check('facilities round-trip as array',
    Array.isArray(gym.facilities) && gym.facilities.length === 3 && gym.facilities.includes('Sauna'),
    JSON.stringify(gym.facilities));

  r = await req('POST', '/api/gym/gyms', deskTok, { name: 'No Permission Gym' });
  check('receptionist (no gym.manage) cannot create a gym → 403', r.status === 403, 'got ' + r.status);

  r = await req('GET', '/api/gym/gyms', staffTok);
  check('staff (no gym.use) blocked → 403', r.status === 403, 'got ' + r.status);

  // ── 2. Registration period derivation (daily / monthly / yearly) ─────
  r = await req('POST', '/api/gym/registrations', adminTok, {
    gymId: gym.id, memberName: 'Ada Obi', registrationType: 'daily', startDate: '2026-10-21',
  });
  check('daily registration → 201', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 120));
  check('daily period: end == start', r.body && r.body.end_date === r.body.start_date && r.body.start_date === '2026-10-21',
    r.body && (r.body.start_date + '..' + r.body.end_date));
  check('daily amount defaults to price_daily (10)', r.body && r.body.amount === 10, 'amount=' + (r.body && r.body.amount));

  r = await req('POST', '/api/gym/registrations', adminTok, {
    gymId: gym.id, memberName: 'Ben Eke', registrationType: 'monthly', startDate: '2026-10-21',
    amount: 999, // admin override allowed
  });
  check('monthly registration → 201', r.status === 201, 'got ' + r.status);
  check('monthly period = start + 1 month − 1 day (2026-11-20)', r.body && r.body.end_date === '2026-11-20',
    r.body && r.body.end_date);
  check('admin amount override honoured (999)', r.body && r.body.amount === 999, 'amount=' + (r.body && r.body.amount));

  r = await req('POST', '/api/gym/registrations', adminTok, {
    gymId: gym.id, memberName: 'Cleo Umeh', registrationType: 'yearly', startDate: '2026-02-28',
  });
  check('yearly registration → 201', r.status === 201, 'got ' + r.status);
  check('yearly period = start + 12 months − 1 day (2027-02-27)', r.body && r.body.end_date === '2027-02-27',
    r.body && r.body.end_date);

  // ── 3. Capacity: gym capacity is 3, and 3 active members overlap 2026-10-21
  // (Ada daily that day, Ben monthly from that day, Cleo yearly spanning it).
  r = await req('POST', '/api/gym/registrations', adminTok, {
    gymId: gym.id, memberName: 'Dan Oke', registrationType: 'daily', startDate: '2026-10-21',
  });
  check('4th overlapping registration → 409 capacity', r.status === 409, 'got ' + r.status + ' ' + (r.body && r.body.error));

  // ── 4. Cancel (gym.manage) frees the slot ────────────────────────────
  const monthly = (await req('GET', '/api/gym/registrations?gymId=' + gym.id, adminTok)).body
    .find(x => x.member_name === 'Ben Eke');
  r = await req('POST', '/api/gym/registrations/' + monthly.id + '/cancel', deskTok);
  check('receptionist (gym.use only) cannot cancel → 403', r.status === 403, 'got ' + r.status);

  r = await req('POST', '/api/gym/registrations/' + monthly.id + '/cancel', adminTok);
  check('admin cancel → 200 cancelled', r.status === 200 && r.body.status === 'cancelled', 'got ' + r.status);

  r = await req('POST', '/api/gym/registrations', adminTok, {
    gymId: gym.id, memberName: 'Dan Oke', registrationType: 'daily', startDate: '2026-10-21',
  });
  check('slot freed after cancel → 201', r.status === 201, 'got ' + r.status + ' ' + (r.body && r.body.error));

  // ── 5. Listing + PATCH edit + permission on price change ─────────────
  r = await req('GET', '/api/gym/registrations?gymId=' + gym.id + '&from=2026-10-01', adminTok);
  check('GET registrations filtered by gym + date → array', Array.isArray(r.body), 'got ' + typeof r.body);

  const dan = (await req('GET', '/api/gym/registrations', adminTok)).body.find(x => x.member_name === 'Dan Oke');
  r = await req('PATCH', '/api/gym/registrations/' + dan.id, deskTok, { memberPhone: '+2348012345678' });
  check('receptionist can edit member contact → 200', r.status === 200 && r.body.member_phone === '+2348012345678', 'got ' + r.status);

  r = await req('PATCH', '/api/gym/registrations/' + dan.id, deskTok, { amount: 5 });
  check('receptionist cannot change amount → 403', r.status === 403, 'got ' + r.status);

  r = await req('PATCH', '/api/gym/gyms/' + gym.id, adminTok, { priceMonthly: 90, capacity: 5, facilities: ['Sauna'] });
  check('admin updates gym prices/capacity/facilities → 200', r.status === 200 && r.body.price_monthly === 90 &&
    r.body.capacity === 5 && Array.isArray(r.body.facilities) && r.body.facilities.length === 1, 'got ' + r.status);

  // ── 6. Delete rules ──────────────────────────────────────────────────
  r = await req('DELETE', '/api/gym/gyms/' + gym.id, adminTok);
  check('cannot delete gym with active registrations → 409', r.status === 409, 'got ' + r.status);

  // ── 7. Entitlement gate: starter plan → 402 UPGRADE_REQUIRED ─────────
  r = await req('GET', '/api/gym/gyms', starterTok);
  check('starter plan → 402 UPGRADE_REQUIRED', r.status === 402 && r.body && r.body.code === 'UPGRADE_REQUIRED',
    'got ' + r.status + ' ' + (r.body && r.body.code));

  // ── Summary ──────────────────────────────────────────────────────────
  const failed = results.filter(x => !x.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (failed.length) {
    console.error('FAILED: ' + failed.map(f => f.name).join(' | '));
    process.exit(1);
  }
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
