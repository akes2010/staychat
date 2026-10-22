// scripts/verify-menu-categories-http.js
// End-to-end HTTP check for the Menu Manager "+" feature (new product
// categories): boots the REAL Express app on an ephemeral port (temp
// DATA_DIR) and drives /api/menu/categories + /api/menu through the actual
// middleware stack (auth → resolveTenant → requireTenant → permission gate).
// Covers:
//   auth on the list endpoint, create → 201 round-trip,
//   duplicate + case-insensitive duplicate → 409 with the canonical name,
//   empty / whitespace / overlong names → 400,
//   permission gate (staff without menu.manage → 403, read still 200),
//   merge with categories in use by menu_items (+ case-insensitive dedupe),
//   category round-trip through product creation,
//   per-tenant isolation, audit row + persisted row.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-menu-cat-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
process.env.PORT = '0'; // ephemeral

const db = require('../server/db/connection');
require('../server/db/migrate');

const { nanoid } = require('nanoid');
const bcrypt = require('bcryptjs');
const { signAccessToken } = require('../server/utils/tokens');

// ── Seed: two tenants (isolation), one manager + one staff per first tenant
function makeTenant(plan) {
  const id = 'tenant_' + nanoid(8);
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status) VALUES (?,?,?,?,'active')`)
    .run(id, 'Cat ' + plan + ' Hotel', 'cat-' + nanoid(5), plan);
  return id;
}
function makeUser(tenantId, role) {
  const id = 'user_' + nanoid(8);
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role) VALUES (?,?,?,?,?,?)`)
    .run(id, tenantId, role, role + '-' + nanoid(5) + '@cat.test', bcrypt.hashSync('pw', 8), role);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

const tenantA = makeTenant('pro');
const tenantB = makeTenant('pro');
const admin = makeUser(tenantA, 'hotel_admin');   // menu.manage + pos.manage_products
const staff = makeUser(tenantA, 'staff');         // neither
const adminB = makeUser(tenantB, 'hotel_admin');

const adminTok = signAccessToken(admin);
const staffTok = signAccessToken(staff);
const adminBTok = signAccessToken(adminB);

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

  // ── 1. Auth + empty list ────────────────────────────────────────────────
  let r = await req('GET', '/api/menu/categories', null);
  check('GET without token → 401', r.status === 401, 'got ' + r.status);

  r = await req('GET', '/api/menu/categories', adminTok);
  check('GET as admin → 200 array (no categories yet)', r.status === 200 && Array.isArray(r.body) && r.body.length === 0,
    'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 80));

  // ── 2. Create → round-trip ──────────────────────────────────────────────
  r = await req('POST', '/api/menu/categories', adminTok, { name: 'Shisha' });
  check('POST create "Shisha" → 201 {name}', r.status === 201 && r.body && r.body.name === 'Shisha',
    'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 80));

  r = await req('GET', '/api/menu/categories', adminTok);
  check('GET now lists "Shisha"', r.status === 200 && r.body.includes('Shisha'), JSON.stringify(r.body));

  r = await req('POST', '/api/menu/categories', adminTok, { name: '  Tapas  ' });
  check('whitespace name is trimmed → 201 "Tapas"', r.status === 201 && r.body && r.body.name === 'Tapas',
    r.body && r.body.name);

  // ── 3. Duplicates → 409 with the canonical-cased name ───────────────────
  r = await req('POST', '/api/menu/categories', adminTok, { name: 'Shisha' });
  check('exact duplicate → 409', r.status === 409, 'got ' + r.status);
  check('duplicate body carries canonical existing name', r.body && r.body.existing === 'Shisha',
    JSON.stringify(r.body));

  r = await req('POST', '/api/menu/categories', adminTok, { name: 'SHISHA' });
  check('case-insensitive duplicate → 409', r.status === 409, 'got ' + r.status);
  check('case-insensitive: existing is canonical "Shisha"', r.body && r.body.existing === 'Shisha',
    JSON.stringify(r.body));

  const catCount = db.prepare('SELECT COUNT(*) c FROM menu_categories WHERE tenant_id = ?').get(tenantA).c;
  check('duplicates never insert rows (2 rows for A)', catCount === 2, 'rows=' + catCount);

  // ── 4. Validation → 400 ─────────────────────────────────────────────────
  r = await req('POST', '/api/menu/categories', adminTok, { name: '' });
  check('empty name → 400', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/menu/categories', adminTok, { name: '   ' });
  check('whitespace-only name → 400', r.status === 400, 'got ' + r.status);
  r = await req('POST', '/api/menu/categories', adminTok, { name: 'x'.repeat(61) });
  check('61-char name → 400', r.status === 400 && /60/.test(r.body && r.body.error ? r.body.error : ''),
    'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 90));

  // ── 5. Permission gate ──────────────────────────────────────────────────
  r = await req('POST', '/api/menu/categories', staffTok, { name: 'Nope' });
  check('staff (no menu.manage) cannot create → 403', r.status === 403, 'got ' + r.status);
  r = await req('GET', '/api/menu/categories', staffTok);
  check('staff can still READ the list → 200', r.status === 200 && Array.isArray(r.body), 'got ' + r.status);

  // ── 6. Merge with categories IN USE by menu_items ───────────────────────
  r = await req('POST', '/api/menu', adminTok, { name: 'Legacy Special', price: 9, category: 'Legacy' });
  check('product created with brand-new category "Legacy" → 201', r.status === 201, 'got ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 90));

  r = await req('GET', '/api/menu/categories', adminTok);
  check('in-use category "Legacy" appears without explicit create', r.status === 200 && r.body.includes('Legacy'),
    JSON.stringify(r.body));

  r = await req('POST', '/api/menu', adminTok, { name: 'Smoke Platter', price: 12, category: 'shisha' });
  check('product created with casing-variant category → 201', r.status === 201, 'got ' + r.status);

  r = await req('GET', '/api/menu/categories', adminTok);
  check('list dedupes case-insensitively (one "Shisha")',
    r.status === 200 && r.body.filter(c => String(c).toLowerCase() === 'shisha').length === 1,
    JSON.stringify(r.body));

  // ── 7. Category round-trips through product creation ────────────────────
  r = await req('POST', '/api/menu', adminTok, { name: 'Ayra Special', price: 15, category: 'Shisha' });
  check('product saved under the newly created category → 201', r.status === 201 && r.body.category === 'Shisha',
    'got ' + r.status + ' cat=' + (r.body && r.body.category));

  // ── 8. Per-tenant isolation ─────────────────────────────────────────────
  r = await req('POST', '/api/menu/categories', adminBTok, { name: 'Shisha' });
  check('tenant B may create the SAME name → 201', r.status === 201, 'got ' + r.status);
  r = await req('GET', '/api/menu/categories', adminBTok);
  check('tenant B list has its own "Shisha" and no tenant A products',
    r.status === 200 && r.body.includes('Shisha') && !r.body.includes('Legacy'), JSON.stringify(r.body));
  r = await req('GET', '/api/menu/categories', adminTok);
  check('tenant A list unchanged (still has "Legacy")', r.status === 200 && r.body.includes('Legacy'), JSON.stringify(r.body));

  // ── 9. Persistence + audit ──────────────────────────────────────────────
  const row = db.prepare('SELECT * FROM menu_categories WHERE tenant_id = ? AND name = ?').get(tenantA, 'Shisha');
  check('row persisted with created_by = manager id', !!row && row.created_by === admin.id, row ? 'by=' + row.created_by : 'missing');
  const audits = db.prepare("SELECT * FROM audit_log WHERE tenant_id = ? AND action = 'menu.category_create'").all(tenantA);
  check('audit rows written for category creates', audits.length >= 2, 'n=' + audits.length);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  server.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });

  const failed = results.filter(x => !x.ok);
  console.log('\n' + (failed.length ? '✗ ' + failed.length + ' of ' + results.length + ' checks FAILED' : '✓ ALL ' + results.length + ' CHECKS PASSED'));
  process.exit(failed.length ? 1 : 0);
}

run().catch(e => { console.error(e); try { server.close(); } catch (x) {} process.exit(1); });
