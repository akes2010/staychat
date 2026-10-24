// electron/boot-server.js
// Boots the full StayChat OS server (Express + SQLite + WebSocket) inside the
// desktop app process. Pure Node — no electron imports — so the exact boot
// path the app uses can be tested with plain `node electron/boot-server.js`.
//
// Desktop semantics (all overridable with env vars):
//   • DATA lives in the OS app-data directory (~/Library/…, %APPDATA%, ~/.config)
//     so it survives app updates and backs up as one folder — never in the
//     install dir, which is replaced on every update.
//   • SECRETS are generated once on first run and persisted (chmod 600) next
//     to the database. CREDENTIALS_ENCRYPTION_KEY in particular MUST persist:
//     rotating it would make every saved integration credential unreadable.
//   • LAN binding — the server listens on 0.0.0.0 so other front-desk PCs,
//     tablets and phones on the same network can open the app too
//     (http://<desk-ip>:<port>/app), while the desktop window itself loads
//     127.0.0.1. Set STAYCHAT_HOST to override (e.g. 127.0.0.1 for private).
//   • PORT defaults to 3000; if another process already holds it, an
//     OS-assigned free port is used instead of crashing.
//   • NODE_ENV stays `development` on purpose: production marks auth cookies
//     `Secure`, and browsers reject Secure cookies over plain-HTTP LAN
//     addresses — sign-in would silently never stick for tablets on the LAN
//     (same rationale as scripts/setup-env.js). Set NODE_ENV yourself when
//     running behind a TLS proxy.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── Secrets: generated once, persisted forever ──────────────────────────────
const SECRET_FILES = {
  JWT_ACCESS_SECRET: 48,
  JWT_REFRESH_SECRET: 48,
  COOKIE_SECRET: 32,
  CREDENTIALS_ENCRYPTION_KEY: 32,
};

function loadSecrets(secretsPath) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(secretsPath, 'utf8')); } catch (e) { /* first run */ }
  let changed = false;
  for (const [key, bytes] of Object.entries(SECRET_FILES)) {
    if (!process.env[key]) {
      if (!saved[key]) { saved[key] = crypto.randomBytes(bytes).toString('hex'); changed = true; }
      process.env[key] = saved[key];
    }
  }
  if (changed || !fs.existsSync(secretsPath)) {
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, JSON.stringify(saved, null, 2), { mode: 0o600 });
  }
}

// ── Port: prefer 3000, fall back to any free port ───────────────────────────
function pickPort(preferred) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(0)); // busy → OS-assigned
    probe.once('listening', () => probe.close(() => resolve(preferred)));
    probe.listen(preferred, '127.0.0.1');
  });
}

// ── LAN addresses to show in the app menu ───────────────────────────────────
function lanAddresses(port) {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        out.push(`http://${iface.address}:${port}/app`);
      }
    }
  }
  return out;
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function boot({ dataDir, preferredPort } = {}) {
  // STAYCHAT_DATA_DIR still wins so a packaged build can be pointed
  // elsewhere for debugging (header contract: everything overridable by env).
  const data = process.env.STAYCHAT_DATA_DIR || dataDir || path.join(ROOT, 'data');
  fs.mkdirSync(data, { recursive: true });

  // These MUST be set before any server module is required — db/connection.js
  // reads DATA_DIR and server/index.js reads the secrets at require time.
  process.env.DATA_DIR = data;
  process.env.NODE_ENV = process.env.NODE_ENV || 'development';
  // Edition: this boot path IS the desktop app, and the Desk edition has no
  // platform superadmin — seed, role gates and billing activation all key off
  // this (see server/utils/edition.js). Set before seed/index are required.
  process.env.STAYCHAT_EDITION = process.env.STAYCHAT_EDITION || 'desk';
  const pkg = require(path.join(ROOT, 'package.json'));
  process.env.APP_VERSION = process.env.APP_VERSION || pkg.version;
  loadSecrets(path.join(data, 'desktop-secrets.json'));

  const preferred = Number.isFinite(Number(process.env.STAYCHAT_PORT))
    ? Number(process.env.STAYCHAT_PORT)
    : (preferredPort || 3000);
  const port = await pickPort(preferred);

  process.env.PORT = String(port);
  process.env.HOST = process.env.STAYCHAT_HOST || '0.0.0.0';

  // migrate + demo seed (idempotent: seed skips when tenants already exist,
  // so this is a single SELECT on every later launch)
  require(path.join(ROOT, 'server', 'db', 'seed'));

  // Boots Express + WebSocket and starts listening (PORT/HOST honoured above)
  const { server } = require(path.join(ROOT, 'server', 'index.js'));
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const actualPort = server.address().port;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}/app`,
    lanUrls: lanAddresses(actualPort),
    dataDir: data,
    version: process.env.APP_VERSION,
  };
}

module.exports = { boot, lanAddresses };

// Runnable directly (used by tests / headless smoke checks):
//   STAYCHAT_DATA_DIR=/tmp/x STAYCHAT_PORT=3456 node electron/boot-server.js
if (require.main === module) {
  boot().then((info) => {
    console.log('DESKTOP BOOT OK');
    console.log(JSON.stringify(info, null, 2));
  }).catch((err) => {
    console.error('DESKTOP BOOT FAILED:', err);
    process.exit(1);
  });
}
