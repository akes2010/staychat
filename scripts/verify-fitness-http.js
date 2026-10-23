// scripts/verify-fitness-http.js
// End-to-end HTTP check for the additive Gym & Pool membership module
// (quarterly registrations + combined plans with month/quarter/year pricing,
// features and benefits). Boots the REAL Express app on an ephemeral port
// (temp DATA_DIR) and drives /api/fitness through the actual middleware stack
// (auth → resolveTenant → requireTenant → use-gate → entitlement → manage
// gates). Covers:
//   auth on the list endpoints, plan create → 201 round-trip (scope, three
//   prices, features, benefits), validation → 400s, permission gates
//   (staff without gym/pool.use → 403; receptionist with use but not manage
//   → 403 on plan management, 203 on registration with price override
//   ignored), quarterly/monthly/yearly period math (start + N months − 1
//   day, inclusive), manager override honoured, duration change re-derives
//   end date + price, complete/cancel gates, plan deletion guard,
//   entitlement 402 on the starter plan, per-tenant isolation, audit rows,
//   and a smoke check that the untouched gym module still answers.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-fitness-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // ephemeral

const db = require('../server/db/connection');
require('../server/db/migrate');

const { nanoid } = require('nanoid');
const bcrypt = require('bcryptjs');
const { signAccessToken } = require('../server/utils/tokens');

// ── Seed: pro tenant A (admin + receptionist + staff), pro tenant B (isolation),
//    starter tenant C (entitlement 402).
function makeTenant(plan) {
  const id = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?,?,'active')`)
    .run(id, 'Fit ' + plan + ' Hotel', 'fit-' + nanoid(5), plan);
  return id;
}
function makeUser(tenantId, role) {
  const id = 'user_' + nanoid(8);
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?,?)`)
    .run(id, tenantId, role, role + '-' + nanoid(5) + '@fit.test', bcrypt.hashSync('pw', 8), role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

const tenantA = makeTenant('pro');
const tenantB = makeTenant('pro');
const tenantC = makeTenant('starter');
const admin = makeUser(tenantA, 'hotel_admin');      // gym.use + gym.manage + pool.*
const receptionist = makeUser(tenantA, 'receptionist'); // gym.use + pool.use, NO .manage
const staff = makeUser(tenantA, 'staff');            // neither gym.use nor pool.use
const adminB = makeUser(tenantB, 'hotel_admin');
const adminC = makeUser(tenantC, 'hotel_admin');

const adminTok = signAccessToken(admin);
const receptionistTok = signAccessToken(receptionist);
const staffTok = signAccessToken(staff);
const adminBTok = signAccessToken(adminB);
const adminCTok = signAccessToken(adminC);

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

async function run() {
  await new Promise(resolve => server.once('listening', resolve));

  // ── 1. Auth + permissions ─────────────────────────────────────────────
  let r = await req('GET', '/api/fitness/plans', null);
  check('GET /plans without token → 401', r.status === 401, 'got ' + r.status);

  r = await req('GET', '/api/fitness/plans', staffTok);
  check('staff (no gym.use/pool.use) → 403', r.status === 403, 'got ' + r.status);

  r = await req('GET', '/api/fitness/plans', adminTok);
  check('admin GET /plans → 200 [] on a fresh tenant', r.status === 200 && Array.isArray(r.body) && r.body.length === 0,
    'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 60));

  r = await req('POST', '/api/fitness/plans', receptionistTok, { name: 'Nope' });
  check('receptionist (use, not manage) cannot create plans → 403', r.status === 403, 'got ' + r.status);

  // ── 2. Combined plan create → round-trip ──────────────────────────────
  r = await req('POST', '/api/fitness/plans', adminTok, {
    name: 'Wellness Combo', scope: 'both',
    priceMonthly: 50, priceQuarterly: 135, priceYearly: 480,
    features: ['Gym access', 'Pool access', 'Sauna'],
    benefits: ['Free towel service', '10% spa discount'],
  });
  check('POST combined plan → 201', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 90));
  const combo = r.body;
  check('plan round-trips scope/prices/features/benefits',
    combo && combo.scope === 'both' && combo.price_monthly === 50 && combo.price_quarterly === 135 && combo.price_yearly === 480 &&
    Array.isArray(combo.features) && combo.features.length === 3 && Array.isArray(combo.benefits) && combo.benefits.length === 2 && combo.active === true,
    JSON.stringify(combo && { scope: combo.scope, f: combo.features && combo.features.length }));

  r = await req('POST', '/api/fitness/plans', adminTok, {
    name: 'Gym Only', scope: 'gym', priceMonthly: 30, priceQuarterly: 80, priceYearly: 300, features: ['Gym access'],
  });
  check('gym-scope plan → 201', r.status === 201 && r.body.scope === 'gym', 'got ' + r.status);
  const gymOnly = r.body;

  r = await req('POST', '/api/fitness/plans', adminTok, {
    name: 'Pool Only', scope: 'pool', priceMonthly: 25, priceQuarterly: 65, priceYearly: 240, features: ['Pool access'], benefits: ['Guest pass'],
  });
  check('pool-scope plan → 201', r.status === 201 && r.body.scope === 'pool', 'got ' + r.status);
  const poolOnly = r.body;

  // ── 3. Validation ─────────────────────────────────────────────────────
  r = await req('POST', '/api/fitness/plans', adminTok, { name: '' });
  check('empty name → 400', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/fitness/plans', adminTok, { name: 'x'.repeat(81) });
  check('81-char name → 400', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/fitness/plans', adminTok, { name: 'Bad Scope', scope: 'spa' });
  check('bad scope → 400', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/fitness/plans', adminTok, { name: 'Bad Price', priceQuarterly: -5 });
  check('negative quarterly price → 400', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/fitness/plans', adminTok, { name: 'Bad Features', features: 'not-an-array' });
  check('features not an array → 400', r.status === 400, 'got ' + r.status);

  r = await req('GET', '/api/fitness/plans?scope=both', adminTok);
  check('GET /plans?scope=both returns only the combined plan',
    r.status === 200 && r.body.length === 1 && r.body[0].id === combo.id, 'n=' + (r.body && r.body.length));

  // ── 4. Quarterly registration (the headline feature) ──────────────────
  r = await req('POST', '/api/fitness/memberships', adminTok, {
    planId: combo.id, duration: 'quarterly', startDate: '2026-01-15', memberName: 'Ada Obi',
    memberPhone: '+2348012345678',
  });
  check('quarterly membership → 201', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 90));
  const qtr = r.body;
  check('quarterly period: 2026-01-15 → 2026-04-14 (start + 3 months − 1 day, inclusive)',
    qtr && qtr.start_date === '2026-01-15' && qtr.end_date === '2026-04-14', qtr && qtr.end_date);
  check('amount auto-defaults to the plan quarterly price (135)', qtr && qtr.amount === 135, qtr && String(qtr.amount));
  check('scope/duration/status round-trip', qtr && qtr.scope === 'both' && qtr.duration === 'quarterly' && qtr.status === 'active' && qtr.paid === false,
    qtr && (qtr.scope + '/' + qtr.duration + '/' + qtr.status));

  // ── 5. Receptionist registers; price/paid overrides are ignored ───────
  r = await req('POST', '/api/fitness/memberships', receptionistTok, {
    planId: combo.id, duration: 'monthly', startDate: '2026-02-10', memberName: 'Bola Ade',
    amount: 1, paid: true,
  });
  check('receptionist can register (use permission) → 201', r.status === 201, 'got ' + r.status);
  const mo = r.body;
  check('non-manager amount override (1) is ignored → plan price 50', mo && mo.amount === 50, mo && String(mo.amount));
  check('non-manager paid=true is ignored → paid false', mo && mo.paid === false, mo && String(mo.paid));
  check('monthly period: 2026-02-10 → 2026-03-09', mo && mo.end_date === '2026-03-09', mo && mo.end_date);

  // ── 6. Pool-scope registration on the pool-only plan ──────────────────
  r = await req('POST', '/api/fitness/memberships', receptionistTok, {
    planId: poolOnly.id, duration: 'yearly', startDate: '2026-03-01', memberName: 'Chidi Eze',
  });
  check('pool-scope yearly membership → 201 with scope=pool', r.status === 201 && r.body.scope === 'pool', 'got ' + r.status);
  const yr = r.body;
  check('yearly amount auto-defaults (240) + period 2026-03-01 → 2027-02-28',
    yr && yr.amount === 240 && yr.end_date === '2027-02-28', yr && (yr.amount + '/' + yr.end_date));

  // ── 7. Validation + missing rows ──────────────────────────────────────
  r = await req('POST', '/api/fitness/memberships', adminTok, { planId: combo.id, duration: 'daily', startDate: '2026-01-01', memberName: 'X' });
  check('duration "daily" → 400 (only monthly/quarterly/yearly)', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/fitness/memberships', adminTok, { planId: combo.id, duration: 'quarterly', startDate: '2026-01-01' });
  check('missing memberName → 400', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/fitness/memberships', adminTok, { planId: combo.id, duration: 'quarterly', startDate: '15-01-2026', memberName: 'X' });
  check('invalid startDate → 400', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/fitness/memberships', adminTok, { planId: 'mplan_missing', duration: 'quarterly', startDate: '2026-01-01', memberName: 'X' });
  check('unknown planId → 404', r.status === 404, 'got ' + r.status);

  // ── 8. Inactive plan refuses new registrations ────────────────────────
  r = await req('PATCH', '/api/fitness/plans/' + gymOnly.id, adminTok, { active: false });
  check('plan PATCH active=false → 200', r.status === 200 && r.body.active === false, 'got ' + r.status);
  r = await req('POST', '/api/fitness/memberships', adminTok, { planId: gymOnly.id, duration: 'monthly', startDate: '2026-01-01', memberName: 'X' });
  check('registration on inactive plan → 409', r.status === 409, 'got ' + r.status);
  r = await req('PATCH', '/api/fitness/plans/' + gymOnly.id, adminTok, { active: true, priceQuarterly: 85 });
  check('plan PATCH reactivate + price update round-trip', r.status === 200 && r.body.active === true && r.body.price_quarterly === 85, 'got ' + r.status);

  // ── 9. Manager override is honoured ───────────────────────────────────
  r = await req('POST', '/api/fitness/memberships', adminTok, {
    planId: combo.id, duration: 'quarterly', startDate: '2026-01-01', memberName: 'Director Pass', amount: 999, paid: true,
  });
  check('manager override honoured (amount 999, paid true)', r.status === 201 && r.body.amount === 999 && r.body.paid === true,
    'got ' + r.status + ' ' + (r.body && r.body.amount));

  // ── 10. PATCH gates: pricing authority vs contact fields ──────────────
  r = await req('PATCH', '/api/fitness/memberships/' + mo.id, receptionistTok, { amount: 5 });
  check('receptionist cannot PATCH amount → 403', r.status === 403, 'got ' + r.status);
  r = await req('PATCH', '/api/fitness/memberships/' + mo.id, receptionistTok, { memberPhone: '+2348000000000' });
  check('receptionist can PATCH contact fields → 200', r.status === 200 && r.body.member_phone === '+2348000000000', 'got ' + r.status);

  r = await req('PATCH', '/api/fitness/memberships/' + mo.id, adminTok, { duration: 'yearly' });
  check('admin changes duration monthly→yearly: end re-derived to 2027-02-09',
    r.status === 200 && r.body.duration === 'yearly' && r.body.end_date === '2027-02-09', 'got ' + r.status + ' ' + (r.body && r.body.end_date));
  check('amount reverts to the plan yearly price (480) on duration change', r.body && r.body.amount === 480, r.body && String(r.body.amount));

  // ── 11. Complete / cancel gates ───────────────────────────────────────
  r = await req('POST', '/api/fitness/memberships/' + yr.id + '/complete', receptionistTok);
  check('receptionist can COMPLETE (desk action) → 200 completed', r.status === 200 && r.body.status === 'completed', 'got ' + r.status);
  r = await req('POST', '/api/fitness/memberships/' + yr.id + '/cancel', receptionistTok);
  check('receptionist cannot CANCEL (manage gate) → 403', r.status === 403, 'got ' + r.status);
  r = await req('POST', '/api/fitness/memberships/' + qtr.id + '/cancel', adminTok);
  check('admin cancels → 200 cancelled', r.status === 200 && r.body.status === 'cancelled', 'got ' + r.status);
  r = await req('PATCH', '/api/fitness/memberships/' + yr.id, adminTok, { memberName: 'Too Late' });
  check('editing a completed membership → 409', r.status === 409, 'got ' + r.status);

  // ── 12. Filters ───────────────────────────────────────────────────────
  r = await req('GET', '/api/fitness/memberships?status=active', adminTok);
  check('status filter returns only actives', r.status === 200 && Array.isArray(r.body) && r.body.every(m => m.status === 'active'),
    'n=' + (r.body && r.body.length));
  r = await req('GET', '/api/fitness/memberships?status=bogus', adminTok);
  check('invalid status filter → 400', r.status === 400, 'got ' + r.status);

  // ── 13. Plan deletion guard ───────────────────────────────────────────
  r = await req('DELETE', '/api/fitness/plans/' + combo.id, adminTok);
  check('cannot delete a plan with active memberships → 409', r.status === 409, 'got ' + r.status);
  // Cancel every remaining active membership on the combined plan…
  const activeOnCombo = (await req('GET', '/api/fitness/memberships?status=active', adminTok)).body.filter(m => m.plan_id === combo.id);
  for (const m of activeOnCombo) await req('POST', '/api/fitness/memberships/' + m.id + '/cancel', adminTok);
  r = await req('DELETE', '/api/fitness/plans/' + combo.id, adminTok);
  check('plan deletes once no active memberships remain → {ok:true}', r.status === 200 && r.body.ok === true, 'got ' + r.status);
  r = await req('DELETE', '/api/fitness/plans/' + gymOnly.id, adminTok);
  check('plan without memberships deletes immediately', r.status === 200 && r.body.ok === true, 'got ' + r.status);

  // ── 14. Entitlement: starter plan has neither gym nor pool ────────────
  r = await req('GET', '/api/fitness/plans', adminCTok);
  check('starter tenant GET /plans → 402 UPGRADE_REQUIRED', r.status === 402 && r.body.code === 'UPGRADE_REQUIRED', 'got ' + r.status + ' ' + (r.body && r.body.code));
  r = await req('POST', '/api/fitness/memberships', adminCTok, { planId: 'x', duration: 'quarterly', startDate: '2026-01-01', memberName: 'X' });
  check('starter tenant POST /memberships → 402', r.status === 402, 'got ' + r.status);

  // ── 15. Per-tenant isolation ──────────────────────────────────────────
  r = await req('POST', '/api/fitness/plans', adminBTok, { name: 'Wellness Combo', scope: 'both', priceMonthly: 70, priceQuarterly: 190, priceYearly: 690 });
  check('tenant B may create the SAME plan name → 201', r.status === 201, 'got ' + r.status);
  r = await req('GET', '/api/fitness/plans', adminBTok);
  check('tenant B list has only its own plan', r.status === 200 && r.body.length === 1 && r.body[0].price_monthly === 70, 'n=' + (r.body && r.body.length));
  r = await req('GET', '/api/fitness/memberships', adminBTok);
  check('tenant B memberships exclude tenant A rows', r.status === 200 && r.body.length === 0, 'n=' + (r.body && r.body.length));

  // ── 16. Persistence + audit + the untouched gym module still works ────
  const planRows = db.prepare('SELECT COUNT(*) c FROM membership_plans WHERE tenant_id = ?').get(tenantA).c;
  check('plans persisted for tenant A (1 remaining after deletes)', planRows === 1, 'rows=' + planRows);
  const memRows = db.prepare('SELECT COUNT(*) c FROM memberships WHERE tenant_id = ?').get(tenantA).c;
  check('memberships persisted for tenant A (4)', memRows === 4, 'rows=' + memRows);
  const audits = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tenant_id = ? AND action = 'membership.create'").get(tenantA).c;
  check('audit rows written for membership creates', audits >= 4, 'n=' + audits);
  const planAudits = db.prepare("SELECT COUNT(*) c FROM audit_log WHERE tenant_id = ? AND action = 'membership_plan.create'").get(tenantA).c;
  check('audit rows written for plan creates', planAudits >= 3, 'n=' + planAudits);

  r = await req('GET', '/api/gym/registrations', adminTok);
  check('untouched gym module still answers (GET /api/gym/registrations → 200)', r.status === 200 && Array.isArray(r.body), 'got ' + r.status);

  // ── Cleanup ───────────────────────────────────────────────────────────
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter(x => !x.ok);
  console.log('\n' + (failed.length ? '✗ ' + failed.length + ' of ' + results.length + ' checks FAILED' : '✓ ALL ' + results.length + ' CHECKS PASSED'));
  process.exit(failed.length ? 1 : 0);
}

run().catch(e => { console.error(e); try { server.close(); } catch (x) {} process.exit(1); });
