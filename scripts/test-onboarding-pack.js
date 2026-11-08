#!/usr/bin/env node
// scripts/test-onboarding-pack.js
// Fast gate (no browser): the onboarding ZIP is exactly the three published
// PDFs, the ZIP is current, and every download link used by the signup page,
// Help Center, onboarding modal, training page and welcome email resolves over
// HTTP with the right content type.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');
const { freePort } = require('./lib/free-port');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const ZIP = path.join(PUBLIC, 'StayChat-OS-Onboarding-Pack.zip');
const PDFS = [
  'StayChat-OS-User-Manual.pdf',
  'StayChat-OS-Quick-Reference.pdf',
  'StayChat-OS-Welcome-Checklist.pdf',
];
const LINKS = [
  '/StayChat-OS-Onboarding-Pack.zip',
  '/StayChat-OS-User-Manual.pdf',
  '/StayChat-OS-Quick-Reference.pdf',
  '/StayChat-OS-Welcome-Checklist.pdf',
];
const LINK_RE = /\/StayChat-OS-[A-Za-z0-9._-]+\.(?:pdf|zip)/g;

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Minimal reader for the archive this repo writes: local headers in order,
// deflate/store, no data descriptors.
function readZip(buf) {
  const entries = [];
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const start = off + 30 + nameLen + extraLen;
    const body = buf.subarray(start, start + compSize);
    entries.push({ name, data: method === 8 ? zlib.inflateRawSync(body) : body });
    off = start + compSize;
  }
  return entries;
}

function waitHealthy(base, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => http.get(base + '/api/health', r => { r.resume(); resolve(); })
      .on('error', () => Date.now() - t0 > timeoutMs ? reject(new Error('server not healthy')) : setTimeout(tick, 300));
    tick();
  });
}

function linksIn(text) {
  return text.match(LINK_RE) || [];
}

(async () => {
  console.log('▶ Onboarding pack integrity');

  // 1. The committed ZIP is current for the committed PDFs.
  const check = spawnSync('node', [path.join(__dirname, 'build-onboarding-pack.js'), '--check'], { encoding: 'utf8' });
  assert.strictEqual(check.status, 0, 'ZIP is stale — run npm run pack:onboarding\n' + (check.stderr || check.stdout));

  // 2. ZIP contents are byte-for-byte the published PDFs.
  assert.ok(fs.existsSync(ZIP), 'missing ' + path.basename(ZIP));
  const entries = readZip(fs.readFileSync(ZIP));
  assert.deepStrictEqual(entries.map(e => e.name).sort(), [...PDFS].sort(), 'ZIP entries do not match the pack');
  for (const e of entries) {
    const pdf = fs.readFileSync(path.join(PUBLIC, e.name));
    assert.strictEqual(sha(e.data), sha(pdf), e.name + ' in the ZIP does not match public/' + e.name);
  }
  console.log('  ✓ ZIP holds the current manual, cheat sheet and checklist');

  // 3. Every surface that offers the pack links to all four files.
  const sources = {
    'public/help.html': fs.readFileSync(path.join(PUBLIC, 'help.html'), 'utf8'),
    'public/signup.html': fs.readFileSync(path.join(PUBLIC, 'signup.html'), 'utf8'),
    'public/js/auth.js': fs.readFileSync(path.join(PUBLIC, 'js', 'auth.js'), 'utf8'),
  };
  for (const [file, text] of Object.entries(sources)) {
    const found = linksIn(text);
    for (const link of LINKS) assert.ok(found.includes(link), file + ' is missing download link ' + link);
  }
  const training = fs.readFileSync(path.join(PUBLIC, 'js', 'pages', 'training.js'), 'utf8');
  for (const link of ['/StayChat-OS-Onboarding-Pack.zip', '/StayChat-OS-Welcome-Checklist.pdf']) {
    assert.ok(linksIn(training).includes(link), 'training page is missing download link ' + link);
  }
  console.log('  ✓ signup, Help Center, modal and tracker link to all four downloads');

  // 4. Start a throwaway server and resolve each download over HTTP.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-pack-test.'));
  const port = await freePort();
  const base = 'http://localhost:' + port;
  const logPath = path.join(dataDir, 'server.log');
  const log = fs.openSync(logPath, 'w');
  const srv = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, APP_URL: base, NODE_ENV: 'development' },
    stdio: ['ignore', log, log],
  });

  try {
    await waitHealthy(base);
    for (const link of LINKS) {
      const r = await fetch(base + link, { method: 'HEAD' });
      const type = String(r.headers.get('content-type') || '');
      const size = Number(r.headers.get('content-length') || 0);
      assert.strictEqual(r.status, 200, link + ' returned ' + r.status);
      assert.ok(type.includes(link.endsWith('.zip') ? 'zip' : 'pdf'), link + ' has content-type ' + type);
      assert.ok(size > 1000, link + ' has content-length ' + size);
    }

    // 5. The welcome email carries the same four absolute URLs.
    process.env.APP_URL = base;
    const emailSvc = require(path.join(ROOT, 'server', 'services', 'email'));
    const mail = emailSvc.signupWelcomeEmail({
      hotelName: 'Pack Test Hotel', ownerName: 'Ada', subdomain: 'pack-test', plan: 'pro', trialEndsAt: '2026-12-08',
    });
    for (const link of LINKS) {
      assert.ok(mail.html.includes(base + link), 'welcome email HTML is missing ' + link);
      assert.ok(mail.text.includes(base + link), 'welcome email text is missing ' + link);
    }
    console.log('  ✓ all four download URLs return 200 with the right content type');
    console.log('  ✓ welcome email includes the ZIP and all three PDFs');
  } finally {
    srv.kill('SIGKILL');
    fs.closeSync(log);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('✓ Onboarding pack test passed');
})().catch(err => {
  console.error('✗ ' + err.message);
  process.exit(1);
});
