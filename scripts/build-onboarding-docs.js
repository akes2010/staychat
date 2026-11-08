#!/usr/bin/env node
// scripts/build-onboarding-docs.js
// One command for the whole onboarding pack: render all three printable HTML
// sources to PDF with headless Chromium, then rebuild the ZIP from those PDFs.
//
//   npm run onboarding:build
//
// Chromium is resolved from CHROMIUM_BIN, then chromium / chromium-browser /
// google-chrome on PATH. Each PDF is rendered to a temp file and only swapped
// in after all three succeed, so a failed render leaves the published pack
// untouched.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { build } = require('./build-onboarding-pack');
const { stampPdf } = require('./lib/pdf-metadata');

const ROOT = path.join(__dirname, '..');
const DOCS = [
  { html: 'tenant-manual/Complete-User-Manual.html', pdf: 'StayChat-OS-User-Manual.pdf',
    creator: 'StayChat OS documentation', subject: 'StayChat OS complete user manual · 2026 edition' },
  { html: 'tenant-manual/quick-reference.html', pdf: 'StayChat-OS-Quick-Reference.pdf',
    creator: 'StayChat OS', subject: 'StayChat OS onboarding pack · quick reference' },
  { html: 'tenant-manual/welcome-checklist.html', pdf: 'StayChat-OS-Welcome-Checklist.pdf',
    creator: 'StayChat OS', subject: 'StayChat OS onboarding pack · welcome & training checklist' },
];

function findChromium() {
  const candidates = [process.env.CHROMIUM_BIN, 'chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']
    .filter(Boolean);
  for (const bin of candidates) {
    if (bin.includes(path.sep)) {
      try { fs.accessSync(bin, fs.constants.X_OK); return bin; } catch (e) { /* next */ }
    } else {
      const found = spawnSync('which', [bin], { encoding: 'utf8' });
      if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
    }
  }
  throw new Error('Chromium not found — set CHROMIUM_BIN or install chromium.');
}

function render(chromium, htmlPath, outPath, meta) {
  const t0 = Date.now();
  const res = spawnSync(chromium, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-pdf-header-footer',
    '--print-to-pdf=' + outPath,
    pathToFileURL(htmlPath).href,
  ], { encoding: 'utf8', timeout: 180000 });

  if (res.error) throw new Error(path.basename(htmlPath) + ': ' + res.error.message);
  if (res.status !== 0) {
    const err = (res.stderr || '').trim().split('\n').slice(-4).join('\n');
    throw new Error(path.basename(htmlPath) + ': chromium exited ' + res.status + (err ? '\n' + err : ''));
  }
  if (!fs.existsSync(outPath)) throw new Error(path.basename(htmlPath) + ': chromium produced no PDF');

  const data = fs.readFileSync(outPath);
  if (data.length < 1024 || data.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error(path.basename(htmlPath) + ': output is not a valid PDF');
  }

  // Chromium carries the HTML <title> but drops Author/Subject/Creator; stamp
  // them with a dependency-free incremental Info update before publishing.
  const html = fs.readFileSync(htmlPath, 'utf8');
  const title = ((html.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || meta.pdf)
    .replace(/&amp;/g, '&').replace(/&mdash;/g, '—').trim();
  const stamped = stampPdf(data, { title, author: 'StayChat OS', creator: meta.creator, subject: meta.subject });
  fs.writeFileSync(outPath, stamped);
  return { bytes: stamped.length, ms: Date.now() - t0 };
}

function main() {
  const chromium = findChromium();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staychat-onboarding-'));
  const rendered = [];

  try {
    console.log('Rendering ' + DOCS.length + ' PDFs with ' + chromium + '…');
    for (const doc of DOCS) {
      const htmlPath = path.join(ROOT, doc.html);
      if (!fs.existsSync(htmlPath)) throw new Error('Missing source: ' + doc.html);
      const outPath = path.join(tmpDir, doc.pdf);
      const info = render(chromium, htmlPath, outPath, doc);
      rendered.push({ ...doc, outPath });
      console.log('  ✓ ' + doc.pdf + ' — ' + (info.bytes / 1024 / 1024).toFixed(2) + ' MB in ' + (info.ms / 1000).toFixed(1) + 's');
    }

    for (const doc of rendered) {
      fs.copyFileSync(doc.outPath, path.join(ROOT, 'public', doc.pdf));
    }
    console.log('Updated the three PDFs in public/.');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  const result = build();
  console.log(result.changed ? 'Onboarding pack rebuilt.' : 'Onboarding pack was already current.');
}

try {
  main();
} catch (err) {
  console.error('Onboarding build failed: ' + err.message);
  process.exit(1);
}
