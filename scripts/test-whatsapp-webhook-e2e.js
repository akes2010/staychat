#!/usr/bin/env node
// scripts/test-whatsapp-webhook-e2e.js — end-to-end test of the WhatsApp
// inbound pipeline, with THIS SCRIPT playing the role of Meta:
//
//   1. Callback URL reachable, webhook verification handshake (GET
//      hub.challenge echoed for the right verify token, 403 for the wrong one)
//   2. Fail-closed security: unsigned / mis-signed deliveries rejected;
//      unconfigured hotel returns 503
//   3. A correctly signed Cloud API message payload → 200 → the guest message
//      is IN the shared inbox (conversation + message rows via /api/inbox)
//   4. Idempotency: Meta redelivers until 200 — replaying the same wamid must
//      not duplicate the message
//   5. Status-only payloads (no messages[]) are accepted and ignored
//
// Boots a throwaway server against a DB copy (no production data touched) and
// configures the hospitally tenant's WhatsApp credentials directly in that
// copy — AI disabled for determinism (no LLM/outbound calls in the pipeline).
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 4317;
const BASE = 'http://localhost:' + PORT;
const SUB = 'hospitally';
const WEBHOOK = '/api/webhooks/whatsapp/' + SUB;
const VERIFY_TOKEN = 'staychat-test-verify';
const APP_SECRET = 'e2e_test_app_secret_0123456789';
const FROM_PHONE = '2348077700123';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const bad = (m) => { fail++; console.log('  ✗ ' + m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function request(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === null ? null : Buffer.from(body);
    const req = http.request(BASE + urlPath, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } : headers,
    }, (res) => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function sign(rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
}

function cloudApiPayload(messageId, text) {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_E2E',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '2348012345678', phone_number_id: '111111111111111' },
          contacts: [{ profile: { name: 'Ada E2E Guest' }, wa_id: FROM_PHONE }],
          messages: [{ from: FROM_PHONE, id: messageId, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }],
        },
      }],
    }],
  });
}

function statusOnlyPayload() {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_E2E',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '2348012345678', phone_number_id: '111111111111111' },
          statuses: [{ id: 'wamid.STATUS1', status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: FROM_PHONE }],
        },
      }],
    }],
  });
}

async function loginAdmin() {
  const r = await request('POST', '/api/auth/login', {
    body: JSON.stringify({ email: 'admin@hospitally.com', password: 'Demo@123456' }),
  });
  return JSON.parse(r.body).accessToken;
}

(async () => {
  const dataDir = fs.mkdtempSync('/tmp/staychat-wa-e2e.');
  fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db'), path.join(dataDir, 'staychat.db'));
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(path.join(ROOT, 'data', 'staychat.db' + ext))) fs.copyFileSync(path.join(ROOT, 'data', 'staychat.db' + ext), path.join(dataDir, 'staychat.db' + ext));
  }

  // Configure the tenant's WhatsApp credentials in the DB COPY (values only
  // exist there). AI off → deterministic ingest, no LLM or outbound Meta calls.
  const Database = require('better-sqlite3');
  const db = new Database(path.join(dataDir, 'staychat.db'));
  db.prepare(`UPDATE tenants SET wa_phone_id='111111111111111', wa_token='e2e_test_token', wa_verify_token=?, wa_app_secret=?, wa_connected=1, ai_enabled=0 WHERE subdomain=?`)
    .run(VERIFY_TOKEN, APP_SECRET, SUB);
  // The fail-closed probe in section 2 needs A hotel with no app secret. Seed
  // that hotel in the scratch copy rather than assuming the developer's
  // database still ships a particular demo tenant — with the seed pruned or
  // renamed, the probe hit 404 (unknown subdomain) and stopped testing the
  // behaviour it exists for: configured-but-secretless must refuse, not accept.
  db.prepare(`INSERT INTO tenants (id, name, subdomain, plan, status, wa_app_secret, wa_connected)
              VALUES ('tenant_e2e_unconf', 'Unconfigured WhatsApp Hotel', 'savanna', 'starter', 'active', NULL, 0)
              ON CONFLICT(subdomain) DO UPDATE SET wa_app_secret = NULL, wa_connected = 0`).run();
  db.close();

  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: dataDir, NODE_ENV: 'production' }),
    stdio: 'ignore',
  });

  try {
    for (let i = 0; i < 40; i++) {
      try { await fetch(BASE + '/api/health'); break; } catch (e) { await sleep(400); }
    }

    console.log('── 1. Webhook verification handshake (Meta → callback URL)');
    const wrong = await request('GET', WEBHOOK + '?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=12345');
    if (wrong.status === 403) ok('wrong verify token → 403 (rejected)');
    else bad('wrong verify token returned ' + wrong.status + ' (expected 403)');
    const right = await request('GET', WEBHOOK + `?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=12345`);
    if (right.status === 200 && right.body === '12345') ok('correct verify token → 200, hub.challenge echoed back exactly');
    else bad('correct verify token → ' + right.status + ' body=' + right.body.slice(0, 40));
    const unknown = await request('GET', '/api/webhooks/whatsapp/no-such-hotel?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1');
    if (unknown.status === 404) ok('unknown hotel subdomain → 404');
    else bad('unknown subdomain returned ' + unknown.status);

    console.log('── 2. Fail-closed: unsigned and mis-signed deliveries are rejected');
    const payload1 = cloudApiPayload('wamid.E2E_001', 'Hello!');
    const unsigned = await request('POST', WEBHOOK, { body: payload1 });
    if (unsigned.status === 403) ok('POST with NO signature → 403 (injection refused)');
    else bad('unsigned POST returned ' + unsigned.status + ' (expected 403)');
    const mismatch = await request('POST', WEBHOOK, {
      body: payload1,
      headers: { 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) },
    });
    if (mismatch.status === 403) ok('POST with a WRONG signature → 403');
    else bad('mis-signed POST returned ' + mismatch.status);
    const unconf = await request('POST', '/api/webhooks/whatsapp/savanna', { body: cloudApiPayload('wamid.E2E_X', 'hi') });
    if (unconf.status === 503) ok('hotel WITHOUT a configured app secret → 503 (fails closed, not open)');
    else bad('unconfigured hotel returned ' + unconf.status + ' (expected 503)');

    console.log('── 3. Correctly signed guest message lands in the shared inbox');
    const text1 = 'Do you have a room available this weekend for two nights?';
    const signedBody = cloudApiPayload('wamid.E2E_100', text1);
    const delivered = await request('POST', WEBHOOK, {
      body: signedBody,
      headers: { 'X-Hub-Signature-256': sign(signedBody) },
    });
    if (delivered.status === 200) ok('signed delivery → 200 (Meta expects a fast ack)');
    else bad('signed delivery returned ' + delivered.status);
    await sleep(400); // processing is async after the 200

    const token = await loginAdmin();
    const convs = await request('GET', '/api/inbox/conversations', { headers: { Authorization: 'Bearer ' + token } }).then(r => JSON.parse(r.body));
    const conv = convs.find(c => c.guest_phone === FROM_PHONE);
    if (conv) ok(`conversation created for guest ${conv.guest_name} (${FROM_PHONE}), unread=${conv.unread_count}`);
    else { bad('NO conversation appeared in the inbox for the delivered message'); }
    if (conv && conv.unread_count >= 1) ok('conversation is flagged unread for the desk');
    else if (conv) bad('conversation unread_count is 0');
    const msgs = conv
      ? await request('GET', '/api/inbox/conversations/' + conv.id + '/messages', { headers: { Authorization: 'Bearer ' + token } }).then(r => JSON.parse(r.body))
      : { messages: [] };
    const guestMsg = msgs.messages.find(m => m.sender === 'guest' && m.body === text1);
    if (guestMsg) ok('guest message readable in the inbox: "' + guestMsg.body.slice(0, 45) + '…"');
    else bad('guest message not found in conversation');

    console.log('── 4. Idempotency: Meta redelivers the same wamid until 200');
    const replay = await request('POST', WEBHOOK, { body: signedBody, headers: { 'X-Hub-Signature-256': sign(signedBody) } });
    await sleep(400);
    const msgsAfter = conv
      ? await request('GET', '/api/inbox/conversations/' + conv.id + '/messages', { headers: { Authorization: 'Bearer ' + token } }).then(r => JSON.parse(r.body))
      : { messages: [] };
    const count = msgsAfter.messages.filter(m => m.sender === 'guest').length;
    if (replay.status === 200 && count === 1) ok('redelivery of wamid.E2E_100 → 200 but still exactly ' + count + ' guest message (no duplicate)');
    else bad('replay: status ' + replay.status + ', guest message count ' + count);

    console.log('── 5. Status-only payloads (no messages[]) are accepted and ignored');
    const statusBody = statusOnlyPayload();
    const st = await request('POST', WEBHOOK, { body: statusBody, headers: { 'X-Hub-Signature-256': sign(statusBody) } });
    if (st.status === 200) ok('status update → 200');
    else bad('status-only payload returned ' + st.status);

    console.log('\n' + (fail === 0 ? '═══ WHATSAPP WEBHOOK E2E: ' + pass + ' passed, 0 failed ═══' : '═══ WHATSAPP WEBHOOK E2E: ' + fail + ' FAILED ═══'));
    process.exitCode = fail === 0 ? 0 : 1;
  } finally {
    try { srv.kill(); } catch (e) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('✗', e.message); process.exit(1); });
