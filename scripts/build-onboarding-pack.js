#!/usr/bin/env node
// scripts/build-onboarding-pack.js
// Rebuilds public/StayChat-OS-Onboarding-Pack.zip from the three onboarding
// PDFs. The archive is deterministic (fixed entry timestamps, fixed order), so
// an unchanged pack produces byte-identical output and the file is left alone.
//
//   node scripts/build-onboarding-pack.js           rebuild if stale
//   node scripts/build-onboarding-pack.js --check   exit 1 if stale (CI/deploy)
//   node scripts/build-onboarding-pack.js --watch   rebuild whenever a PDF changes
//
// No dependencies: Node's zlib supplies deflate and the ZIP container is
// written directly (store/deflate only — the PDFs are far below ZIP64).
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const PDF_NAMES = [
  'StayChat-OS-User-Manual.pdf',
  'StayChat-OS-Quick-Reference.pdf',
  'StayChat-OS-Welcome-Checklist.pdf',
];
const PDF_DIR = path.join(ROOT, 'public');
const OUT = path.join(PDF_DIR, 'StayChat-OS-Onboarding-Pack.zip');

// Fixed DOS timestamp (1 Jan 2020, 00:00) keeps the archive reproducible.
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const UTF8_FLAG = 0x0800;
const METHOD_DEFLATE = 8;
const METHOD_STORE = 0;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(UTF8_FLAG, 6);    // general purpose flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, spec 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);       // end of central directory
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

function readEntries() {
  return PDF_NAMES.map(name => {
    const file = path.join(PDF_DIR, name);
    if (!fs.existsSync(file)) throw new Error('Missing PDF: public/' + name);
    return { name, data: fs.readFileSync(file) };
  });
}

function fmt(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function build({ check = false, quiet = false } = {}) {
  const entries = readEntries();
  const zip = makeZip(entries);
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT) : null;
  const changed = !existing || !existing.equals(zip);

  if (!changed) {
    if (!quiet) console.log('Onboarding pack is up to date (' + fmt(zip.length) + ', ' + entries.length + ' PDFs).');
    return { changed: false, bytes: zip.length };
  }
  if (check) {
    if (!quiet) console.error('Onboarding pack is STALE — run: npm run pack:onboarding');
    return { changed: true, bytes: zip.length, stale: true };
  }

  const tmp = OUT + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, zip);
  fs.renameSync(tmp, OUT);
  if (!quiet) console.log('Rebuilt public/' + path.basename(OUT) + ' — ' + fmt(zip.length) + ' from ' + entries.length + ' PDFs.');
  return { changed: true, bytes: zip.length };
}

function watch() {
  build();
  console.log('Watching the three onboarding PDFs for changes… (Ctrl+C to stop)');
  let timer = null;
  const schedule = (filename) => {
    if (filename && !PDF_NAMES.includes(filename.toString())) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { build(); } catch (err) { console.error('Pack rebuild failed:', err.message); }
    }, 250);
  };
  const watcher = fs.watch(PDF_DIR, (event, filename) => {
    // Editors often write via rename; only the three known names matter.
    schedule(filename);
  });
  process.on('SIGINT', () => { watcher.close(); process.exit(0); });
  process.on('SIGTERM', () => { watcher.close(); process.exit(0); });
}

function main() {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter(a => a !== '--check' && a !== '--watch');
  if (unknown.length) {
    console.error('Unknown option(s): ' + unknown.join(', '));
    process.exit(2);
  }
  if (args.has('--watch')) {
    if (args.has('--check')) { console.error('--watch and --check cannot be combined'); process.exit(2); }
    watch();
  } else {
    const result = build({ check: args.has('--check') });
    if (result.stale) process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { build, makeZip, PDF_NAMES, OUT, PDF_DIR };
