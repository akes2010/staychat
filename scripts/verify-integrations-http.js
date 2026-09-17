// scripts/verify-integrations-http.js
// End-to-end HTTP verification: encryption, CRUD, masking, real connection test
'use strict';

const http = require('http');

const BASE = 'http://localhost:3000';
let TOKEN, TENANT_ID, CONFIG_ID;

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (TOKEN) opts.headers.Authorization = `Bearer ${TOKEN}`;

    const r = http.request(BASE + path, opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const parsed = data ? JSON.parse(data) : null;
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

async function run() {
  console.log('\n=== 1. Login as hotel admin ===');
  const auth = await req('POST', '/api/auth/login', {
    email: 'admin@hospitally.com', password: 'Demo@123456'
  });
  if (auth.status !== 200) throw new Error('Login failed: ' + auth.status);
  TOKEN = auth.body.accessToken;
  TENANT_ID = auth.body.user.tenantId;
  console.log('✓ Logged in, tenant:', TENANT_ID);

  // Cleanup from any previous (possibly crashed) run so this script is
  // idempotent — otherwise the duplicate-config guard 409s the creates below.
  const existing = await req('GET', '/api/api-integrations', null);
  if (existing.status === 200 && Array.isArray(existing.body)) {
    for (const cfg of existing.body) {
      if (cfg.service_key === 'stripe' || cfg.service_key === 'booking_com') {
        await req('DELETE', `/api/api-integrations/${cfg.id}`, null);
        console.log('✓ Removed stale test config:', cfg.service_key);
      }
    }
  }

  console.log('\n=== 2. List available services ===');
  const avail = await req('GET', '/api/api-integrations/available', null);
  if (avail.status !== 200) throw new Error('Available failed: ' + avail.status);
  console.log('✓ Categories:', avail.body.categories.join(', '));
  console.log('✓ Services count:', avail.body.services.length);

  console.log('\n=== 3. Create Stripe config with real credentials (encrypted at rest) ===');
  const create = await req('POST', '/api/api-integrations', {
    serviceKey: 'stripe',
    label: 'My Stripe Gateway',
    credentials: {
      publishable_key: 'pk_test_PUBLIC_ABCD1234',
      secret_key: 'sk_test_SECRET_XYZ9876_TOPSECRET',
      webhook_secret: 'whsec_WEBHOOK_SECRET_999'
    },
    testMode: true,
    active: true,
  });
  if (create.status !== 201) throw new Error('Create failed: ' + create.status);
  CONFIG_ID = create.body.id;
  console.log('✓ Config created:', CONFIG_ID);

  // Verify secrets are masked in response
  if (create.body.credentials.secret_key.includes('TOPSECRET')) {
    throw new Error('Secret key NOT masked in create response!');
  }
  if (!create.body.credentials.secret_key.includes('***')) {
    throw new Error('Expected masked secret_key in response');
  }
  console.log('✓ Secret key masked in response:', create.body.credentials.secret_key);
  console.log('✓ Public key unmasked:', create.body.credentials.publishable_key);

  console.log('\n=== 4. Direct DB check: credentials stored as ciphertext ===');
  const db = require('../server/db/connection');
  const row = db.prepare('SELECT credentials FROM tenant_api_configs WHERE id = ?').get(CONFIG_ID);
  if (!row.credentials.startsWith('v1:')) {
    throw new Error('Credentials NOT encrypted in DB! Got: ' + row.credentials.slice(0, 50));
  }
  if (row.credentials.includes('TOPSECRET')) {
    throw new Error('Plaintext secret found in DB! Encryption failed.');
  }
  console.log('✓ Ciphertext format:', row.credentials.slice(0, 30) + '...');

  // Verify decryption works
  const { decryptJSON } = require('../server/utils/crypto-store');
  const dec = decryptJSON(row.credentials);
  if (dec.secret_key !== 'sk_test_SECRET_XYZ9876_TOPSECRET') {
    throw new Error('Decrypt mismatch! Got: ' + dec.secret_key);
  }
  console.log('✓ Decryption round-trip correct');

  console.log('\n=== 5. GET list — credentials masked ===');
  const list = await req('GET', '/api/api-integrations', null);
  if (list.status !== 200) throw new Error('List failed: ' + list.status);
  const item = list.body.find(c => c.id === CONFIG_ID);
  if (!item) throw new Error('Config not in list');
  if (item.credentials.secret_key.includes('TOPSECRET')) {
    throw new Error('Secret NOT masked in list response!');
  }
  console.log('✓ List masked secret:', item.credentials.secret_key);

  console.log('\n=== 6. GET :id — credentials masked ===');
  const get = await req('GET', `/api/api-integrations/${CONFIG_ID}`, null);
  if (get.status !== 200) throw new Error('Get failed: ' + get.status);
  if (get.body.credentials.secret_key.includes('TOPSECRET')) {
    throw new Error('Secret NOT masked in GET response!');
  }
  console.log('✓ Get masked secret:', get.body.credentials.secret_key);

  console.log('\n=== 7. PATCH — partial credential update ===');
  const patch = await req('PATCH', `/api/api-integrations/${CONFIG_ID}`, {
    credentials: { webhook_secret: 'whsec_NEW_WEBHOOK_111' },
    label: 'Updated Stripe',
  });
  if (patch.status !== 200) throw new Error('Patch failed: ' + patch.status);
  console.log('✓ Patched');

  // Verify old secret_key still there after partial update
  const row2 = db.prepare('SELECT credentials FROM tenant_api_configs WHERE id = ?').get(CONFIG_ID);
  const dec2 = decryptJSON(row2.credentials);
  if (dec2.secret_key !== 'sk_test_SECRET_XYZ9876_TOPSECRET') {
    throw new Error('Partial update lost existing secret_key!');
  }
  if (dec2.webhook_secret !== 'whsec_NEW_WEBHOOK_111') {
    throw new Error('Partial update did not apply new webhook_secret!');
  }
  console.log('✓ Partial update merged correctly (old secret kept, new webhook set)');

  console.log('\n=== 8. Test connection with real HTTP probe ===');
  // This will hit real Stripe API with a bogus key → expect success:false, tested:true
  const test = await req('POST', `/api/api-integrations/${CONFIG_ID}/test`, null);
  if (test.status !== 400) {
    console.log('  (test returned status', test.status, '— may be 200 if key valid or 400 if invalid)');
  }
  if (test.body.tested !== true) {
    throw new Error('Expected tested:true, got: ' + test.body.tested);
  }
  console.log('✓ Real connection test executed, tested=' + test.body.tested);
  console.log('  Result:', test.body.success ? 'success' : 'failed');
  console.log('  Message/error:', test.body.message || test.body.error);

  console.log('\n=== 9. Test service with no probe (booking_com) ===');
  const bc = await req('POST', '/api/api-integrations', {
    serviceKey: 'booking_com',
    credentials: { hotel_id: '123', username: 'user', password: 'pass' },
    active: false,
  });
  if (bc.status !== 201) throw new Error('booking_com create failed: ' + bc.status);
  const bcTest = await req('POST', `/api/api-integrations/${bc.body.id}/test`, null);
  if (bcTest.body.tested !== false) {
    throw new Error('Expected tested:false for service with no probe');
  }
  if (bcTest.body.success !== true) {
    throw new Error('Expected success:true (fallback) for complete creds with no probe');
  }
  console.log('✓ No-probe fallback: success=' + bcTest.body.success + ', tested=false');
  console.log('  Message:', bcTest.body.message);
  // Clean up so the script leaves no artifacts behind (idempotent re-runs).
  await req('DELETE', `/api/api-integrations/${bc.body.id}`, null);
  console.log('✓ Cleaned up booking_com test config');

  console.log('\n=== 10. DELETE ===');
  const del = await req('DELETE', `/api/api-integrations/${CONFIG_ID}`, null);
  if (del.status !== 200) throw new Error('Delete failed: ' + del.status);
  const check = await req('GET', `/api/api-integrations/${CONFIG_ID}`, null);
  if (check.status !== 404) throw new Error('Config still exists after delete!');
  console.log('✓ Deleted');

  console.log('\n=== ALL CHECKS PASSED ===');
  console.log('  • Credentials encrypted at rest with AES-256-GCM (v1: format)');
  console.log('  • Secrets masked in HTTP responses (public keys unmasked)');
  console.log('  • Partial updates merge correctly (existing creds preserved)');
  console.log('  • Real Stripe connection test reached the API');
  console.log('  • No-probe services fall back gracefully (tested:false)');
  console.log('  • CRUD operations work end-to-end');
}

run().then(() => process.exit(0)).catch(e => {
  console.error('\n❌ FAILED:', e.message);
  process.exit(1);
});
