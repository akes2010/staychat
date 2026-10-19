#!/usr/bin/env node
// scripts/build-desk-package.js — builds dist/staychat-desk.zip, the file the
// Desk PC Edition delivery email links customers to
// (server/services/selfhost.js serves dist/staychat-desk.zip by default;
//  override with SELFHOST_PACKAGE_PATH).
//
// The package = the full application + a first-run installer (install.sh /
// install.bat → npm install, generated .env, database) + INSTALL.txt.
// It is SELF-EXCLUDING for anything sensitive or machine-specific:
//   • .env and every other .env* except the two TEMPLATES (real secrets)
//   • data/          — never ship a database (password hashes, guest PII)
//   • node_modules/  — npm install rebuilds the driver for that machine
//   • .git, dist, logs, browser test screenshots, editor/tool dirs
//
// Re-run after any release:  npm run package:desk
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'staychat-desk.zip');
const PREFIX = 'staychat-desk/';

// ── CRC32 (zlib.crc32 on Node ≥22, table fallback otherwise) ────────────────
const crc32 = (() => {
  if (typeof zlib.crc32 === 'function') {
    return (buf) => zlib.crc32(buf) >>> 0;
  }
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
})();

function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// ── What goes in ────────────────────────────────────────────────────────────
const DIRS = ['server', 'public', 'scripts', 'tenant-manual', 'install-guide', 'deploy'];
const ROOT_FILES = [
  'package.json', 'package-lock.json', 'README.md', '.gitignore',
  '.env.example', '.env.production.example', '.nvmrc',
  'Dockerfile', 'docker-compose.yml', 'diagnose-and-fix.sh',
];
// Directory names never descended into, anywhere in the tree.
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'dist', 'browser-shots', '.claude', '.freebuff', '.github']);
// File names never included, anywhere in the tree.
function skipFile(name) {
  if (name === '.DS_Store' || name.endsWith('.log') || name.endsWith('.zip')) return true;
  if (name.startsWith('.env')) return !(name === '.env.example' || name === '.env.production.example');
  if (/\.(db|db-wal|db-shm|db-journal)$/i.test(name)) return true;
  if (/\.db\.backup/i.test(name)) return true;
  if (name.startsWith('pnpm-lock') || name === 'pnpm-workspace.yaml') return true;
  return false;
}

function walk(abs, relDir, out) {
  const st = fs.statSync(abs);
  const name = path.basename(abs);
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(name)) return;
    for (const child of fs.readdirSync(abs).sort()) {
      walk(path.join(abs, child), relDir + name + '/', out);
    }
  } else {
    if (skipFile(name)) return;
    out.push({ src: abs, arc: PREFIX + relDir + name, mtime: st.mtime, exec: (st.mode & 0o111) !== 0 });
  }
}

// ── First-run installer files (generated into the package root) ────────────
const INSTALL_SH = `#!/usr/bin/env sh
# StayChat OS — Desk PC Edition installer (macOS / Linux)
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "X Node.js 18 or newer is required."
  echo "  Install the LTS build from https://nodejs.org, then run this again."
  exit 1
fi
node -e 'const m=+process.versions.node.split(".")[0]; if(m<18){console.error("X Node.js 18+ required — found "+process.version);process.exit(1)}'

echo "1/3 Installing dependencies (also builds the database driver)..."
npm install --no-audit --no-fund

echo "2/3 Preparing your environment (fresh random secrets, generated locally)..."
node scripts/setup-env.js

echo "3/3 Creating your local database..."
npm run migrate

echo ""
echo "Installed. Start StayChat OS with:  npm start"
echo "Then open http://localhost:3000/app in your browser."
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "From another computer on your network: http://\${IP:-<this-computers-ip>}:3000/app"
`;

const INSTALL_BAT = [
  '@echo off',
  'rem StayChat OS - Desk PC Edition installer (Windows)',
  'cd /d "%~dp0"',
  'where node >nul 2>nul',
  'if errorlevel 1 goto no_node',
  'echo 1/3 Installing dependencies (also builds the database driver)...',
  'call npm install --no-audit --no-fund',
  'if errorlevel 1 goto failed',
  'echo 2/3 Preparing your environment (fresh random secrets, generated locally)...',
  'call node scripts/setup-env.js',
  'if errorlevel 1 goto failed',
  'echo 3/3 Creating your local database...',
  'call npm run migrate',
  'if errorlevel 1 goto failed',
  'echo.',
  'echo Installed. Start StayChat OS with:  npm start',
  'echo Then open http://localhost:3000/app in your browser.',
  'pause',
  'exit /b 0',
  '',
  ':no_node',
  'echo X Node.js 18 or newer is required.',
  'echo   Install the LTS build from https://nodejs.org, then run this again.',
  'pause',
  'exit /b 1',
  '',
  ':failed',
  'echo.',
  'echo X Installation stopped - see the error above.',
  'pause',
  'exit /b 1',
  '',
].join('\r\n');

function installTxt(version) {
  return `StayChat OS - Desk PC Edition
${'='.repeat(60)}
Self-hosted · offline-capable · yours forever  (v${version})

YOUR LICENCE
  Your licence key (SCHK-...) arrived in the delivery email together with
  this package. Keep both - the key proves your perpetual licence and is
  re-issued on request against your order reference (SC-...).

REQUIREMENTS
  * Node.js 18 or newer - https://nodejs.org (LTS build)
  * Windows 10/11, macOS or Linux
  * No internet needed AFTER installation

INSTALL - about 5 minutes
  Windows   : double-click  install.bat
  macOS/Linux: run  sh install.sh
  The installer sets up dependencies, generates a .env with fresh random
  secrets ON YOUR MACHINE (nothing is sent anywhere), and creates your
  local database.

START
  npm start
  Then open http://localhost:3000/app in the browser on this computer.
  Other computers on your network: http://<this-computers-ip>:3000/app
  First run? Open /signup.html to create YOUR hotel's workspace (or
  npm run seed for a fully seeded demo hotel to explore).

OFFLINE / LOCAL NETWORK
  * Front desk, bookings, POS, accounting and reports run without
    internet once installed.
  * Guest records never leave this machine - the database is
    ./data/staychat.db, right here.
  * Optional online features (WhatsApp messaging, cloud integrations)
    need a connection and resume automatically when it returns.

WHERE THINGS LIVE
  ./data/staychat.db       your database - back this up
  ./deploy/backup-db.sh    one-command backup
  ./README.md              full documentation
  ./tenant-manual/         end-user manuals, module by module
  ./install-guide/         step-by-step setup walkthroughs
  ./deploy/SETUP.md        operations reference

UPDATES
  Updates are included with your licence - new packages are emailed to
  your registered address against your order reference.

Questions? Reply to your delivery email and quote your SC- reference.
${'='.repeat(60)}
`;
}

// ── Minimal ZIP writer (DEFLATE, UTF-8 names, unix modes) ───────────────────
function buildZip(entries, outPath) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const data = e.data != null ? Buffer.from(e.data, 'utf8') : fs.readFileSync(e.src);
    const nameBuf = Buffer.from(e.arc, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const dt = dosDateTime(e.mtime || new Date());
    const flags = 0x0800; // names are UTF-8

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, payload);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE((3 << 8) | 20, 4); // made by: unix
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt16LE(dt.time, 12);
    c.writeUInt16LE(dt.date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(payload.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(0, 30); // extra
    c.writeUInt16LE(0, 32); // comment
    c.writeUInt16LE(0, 34); // disk
    c.writeUInt16LE(0, 36); // internal attrs
    const mode = e.exec ? 0o100755 : 0o100644;
    c.writeUInt32LE((mode << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, nameBuf]));

    offset += local.length + nameBuf.length + payload.length;
  }

  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat([...parts, cd, eocd]));
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const entries = [];

  for (const d of DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) walk(abs, '', entries);
    else console.warn('! directory missing, skipped: ' + d);
  }
  for (const f of ROOT_FILES) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) { console.warn('! file missing, skipped: ' + f); continue; }
    const st = fs.statSync(abs);
    entries.push({ src: abs, arc: PREFIX + f, mtime: st.mtime, exec: (st.mode & 0o111) !== 0 });
  }

  // Generated first-run files at the package root.
  const now = new Date();
  entries.push(
    { data: installTxt(pkg.version), arc: PREFIX + 'INSTALL.txt', mtime: now, exec: false },
    { data: INSTALL_SH, arc: PREFIX + 'install.sh', mtime: now, exec: true },
    { data: INSTALL_BAT, arc: PREFIX + 'install.bat', mtime: now, exec: false },
  );

  // Defense in depth: refuse to ship anything the skip rules should have
  // caught (a template passing the filter is fine; a real .env would not be).
  const forbidden = entries.filter(e =>
    /(^|\/)(\.env$|\.env\.save|node_modules\/|data\/|\.git\/)/.test(e.arc) ||
    /\.(db|db-wal|db-shm)$/i.test(e.arc)
  );
  if (forbidden.length) {
    console.error('X refusing to build — sensitive entries matched: ' + forbidden.map(e => e.arc).join(', '));
    process.exit(1);
  }

  buildZip(entries, OUT);
  const size = fs.statSync(OUT).size;
  console.log('✔ ' + path.relative(ROOT, OUT) + ' — ' + entries.length + ' files, ' +
    (size / 1024 / 1024).toFixed(2) + ' MB (StayChat OS v' + pkg.version + ')');
  console.log('  served by GET /api/selfhost/download/:ref/:token after payment confirmation');
}

main();
