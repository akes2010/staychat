#!/usr/bin/env node
// scripts/generate-icons.js
// Generates the PWA icon set as real PNG files — no image dependencies, no
// build step, no binary assets in git. Re-run after changing brand colors:
//
//   node scripts/generate-icons.js
//
// Outputs to public/: icon-192.png, icon-512.png, maskable-512.png,
// apple-touch-icon.png (180x180, opaque for iOS) and favicon.svg, plus
// build/icon.png (1024x1024) — the desktop build icon electron-builder turns
// into the Windows .ico, the macOS .icns and the Linux desktop-entry icon.
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Brand palette (matches the landing page) ────────────────────────────────
const GRAD_FROM = [79, 140, 255];   // #4f8cff
const GRAD_TO = [34, 211, 167];     // #22d3a7
const BG = [10, 18, 32];            // #0a1220 deep navy

function lerp(a, b, t) { return a + (b - a) * t; }

// Diagonal blue→teal gradient, same feel as the landing page hero.
function pixelAt(size, x, y) {
  const t = Math.min(1, Math.max(0, (x + y) / (2 * size)));
  return [
    Math.round(lerp(GRAD_FROM[0], GRAD_TO[0], t)),
    Math.round(lerp(GRAD_FROM[1], GRAD_TO[1], t)),
    Math.round(lerp(GRAD_FROM[2], GRAD_TO[2], t)),
    255,
  ];
}

// Rounded-rectangle coverage for maskable/adaptive icons.
function roundRectCoverage(size, x, y, radiusRatio) {
  const r = size * radiusRatio;
  const cx = x + 0.5, cy = y + 0.5;
  const nx = Math.max(r - cx, cx - (size - r), 0);
  const ny = Math.max(r - cy, cy - (size - r), 0);
  return Math.hypot(nx, ny) <= r;
}

// A "chat bubble + signal" glyph: white rounded bubble with a tail and three
// signal bars PUNCHED OUT of it (background shows through — same look as
// favicon.svg), drawn with a coarse signed-distance approximation. Good enough
// at icon sizes and fully deterministic.
function glyphCoverage(size, x, y) {
  const cx = (x + 0.5) / size, cy = (y + 0.5) / size; // 0..1
  // Bubble: rounded rect from (0.18,0.20) to (0.82,0.66)
  const inBubble = cx > 0.18 && cx < 0.82 && cy > 0.20 && cy < 0.66 &&
    !((cx < 0.24 || cx > 0.76) && (cy < 0.26 || cy > 0.60));
  // Tail: triangle bottom-left of the bubble
  const inTail = cy >= 0.66 && cy < 0.80 && cx > 0.20 + (cy - 0.66) * 0.9 && cx < 0.40 - (cy - 0.66) * 0.35;
  // Signal bars inside the bubble
  const barW = 0.07, gap = 0.045, base = 0.58;
  let inBars = false;
  for (let i = 0; i < 3; i++) {
    const bx0 = 0.27 + i * (barW + gap);
    const bh = 0.10 + i * 0.09;
    if (cx > bx0 && cx < bx0 + barW && cy < base && cy > base - bh) inBars = true;
  }
  // Bars are holes, not fill: painting them white merged them into the white
  // bubble and the glyph read as a blank blob.
  return (inBubble || inTail) && !inBars;
}

// Compose a full RGBA buffer for one icon size.
function renderIcon(size, { maskable = false, opaque = true } = {}) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(size * 4);
    for (let x = 0; x < size; x++) {
      let [r, g, b, a] = pixelAt(size, x, y);
      if (maskable) {
        // Maskable icons must fill the canvas; the glyph shrinks into the
        // inner 80% safe zone.
        if (!glyphCoverage(size * 0.8, x - size * 0.1, y - size * 0.1)) a = 0;
        if (a > 0) { [r, g, b] = [255, 255, 255]; } // white glyph over gradient
      } else {
        const inGlyph = glyphCoverage(size, x, y);
        if (inGlyph) { [r, g, b] = [255, 255, 255]; }
        else if (opaque) { [r, g, b] = BG; } // navy background square
        else { a = 0; }
      }
      // Row-local RGBA index — `row` is ONE scanline (size*4 bytes), so a
      // full-image index (x + y*size)*4 is out of bounds for every row after
      // the first, and Buffer silently drops the write (that bug shipped
      // icons where only row 0 was painted — everything else transparent).
      const i = x * 4;
      row[i] = r; row[i + 1] = g; row[i + 2] = b; row[i + 3] = a;
    }
    rows.push(row);
  }
  return Buffer.concat(rows);
}

// ── Minimal PNG encoder (RGBA, no interlace) ────────────────────────────────
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  // Raw scanlines with filter byte 0.
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Write outputs ────────────────────────────────────────────────────────────
const outDir = path.join(__dirname, '..', 'public');
const targets = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}],
];
targets.forEach(([name, size, opts]) => {
  fs.writeFileSync(path.join(outDir, name), encodePNG(renderIcon(size, opts), size));
  console.log('✓ public/' + name + ' (' + size + 'x' + size + ')');
});

// Favicon as SVG (crisp at any size, one file).
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#4f8cff"/><stop offset="1" stop-color="#22d3a7"/>
</linearGradient></defs>
<rect width="64" height="64" rx="14" fill="url(#g)"/>
<path d="M14 20c0-3.3 2.7-6 6-6h24c3.3 0 6 2.7 6 6v18c0 3.3-2.7 6-6 6H30l-9 8v-8h-1c-3.3 0-6-2.7-6-6z" fill="#fff"/>
<g fill="#4f8cff"><rect x="22" y="24" width="4.5" height="9" rx="1"/><rect x="29.75" y="21" width="4.5" height="12" rx="1"/><rect x="37.5" y="18" width="4.5" height="15" rx="1"/></g>
</svg>`;
fs.writeFileSync(path.join(outDir, 'favicon.svg'), favicon);
console.log('✓ public/favicon.svg');

// Desktop build icon (electron-builder buildResources/icon.png) — generated
// from the same renderer so the installer/shortcut icon can never drift from
// the web icons. 1024px so the macOS .icns and Windows .ico stay crisp.
const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'icon.png'), encodePNG(renderIcon(1024, {}), 1024));
console.log('✓ build/icon.png (1024x1024)');
console.log('\nDone. Reference them from manifest.json / HTML heads.');
