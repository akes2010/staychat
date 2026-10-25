#!/usr/bin/env node
// scripts/verify-linux-icons.js — fail if a built Linux package installs an
// icon into a hicolor directory the freedesktop theme doesn't declare.
//
// Why this exists: icon lookup only searches DIRECTORIES declared in the
// hicolor theme's index.theme. Arch ships no `1024x1024` entry, so a package
// installing /usr/share/icons/hicolor/1024x1024/apps/foo.png gets silently
// ignored — desktops show a generic white card with the app's name. That is
// exactly what happened when electron-builder used the natural size of the
// 1024px build/icon.png for the fpm targets.
//
// Usage:
//   node scripts/verify-linux-icons.js                # check dist/desktop/*.{pacman,deb}
//   node scripts/verify-linux-icons.js file.pacman…   # check specific packages
//
// Exit 0 = every icon lands in a declared dir (or no packages to check).
// Registered as a step in .github/workflows/desktop.yml after packaging.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Sizes the freedesktop.org hicolor theme declares (its index.theme
// Directories= list). 1024x1024 is deliberately absent — it is not part of
// the spec and Arch/Ubuntu themes do not declare it.
const DECLARED = new Set([
  '8x8', '16x16', '22x22', '24x24', '32x32', '48x48', '64x64', '72x72',
  '96x96', '128x128', '256x256', '512x512', 'scalable',
  '16x16@2', '24x24@2', '32x32@2', '48x48@2', '64x64@2', '96x96@2',
  '128x128@2', '256x256@2', '512x512@2',
]);

function listEntries(file) {
  if (file.endsWith('.pacman')) {
    // .pacman is a zstd tarball; bsdtar handles it (installed on Arch and,
    // in CI, by the libarchive-tools step).
    return execFileSync('bsdtar', ['-tf', file], { encoding: 'utf8' })
      .split('\n').map(l => l.trim()).filter(Boolean);
  }
  if (file.endsWith('.deb')) {
    return execFileSync('dpkg-deb', ['-c', file], { encoding: 'utf8' })
      .split('\n')
      .map((l) => { const m = l.match(/\.\/(\S+)$/); return m ? m[1] : null; })
      .filter(Boolean);
  }
  throw new Error('unsupported package type: ' + file);
}

function checkFile(file) {
  const problems = [];
  const declaredSeen = [];
  for (const entry of listEntries(file)) {
    const m = entry.match(/(?:^|\/)usr\/share\/icons\/hicolor\/([^/]+)\/apps\//);
    if (!m) continue;
    const size = m[1];
    if (DECLARED.has(size)) {
      declaredSeen.push(size);
    } else {
      problems.push(size + '  ← not declared by the hicolor theme: ' + entry);
    }
  }
  return { problems, declaredSeen };
}

function main() {
  let files = process.argv.slice(2);
  if (!files.length) {
    const dist = path.join(__dirname, '..', 'dist', 'desktop');
    for (const name of fs.existsSync(dist) ? fs.readdirSync(dist) : []) {
      if (name.endsWith('.pacman') || name.endsWith('.deb')) files.push(path.join(dist, name));
    }
  }
  if (!files.length) {
    console.log('verify-linux-icons: no Linux packages to check — skipping');
    return 0;
  }

  let failed = false;
  for (const file of files) {
    const label = path.basename(file);
    let result;
    try {
      result = checkFile(file);
    } catch (e) {
      failed = true;
      console.error('✗ ' + label + ' — could not read package: ' + e.message.split('\n')[0]);
      continue;
    }
    const { problems, declaredSeen } = result;
    if (problems.length) {
      failed = true;
      console.error('✗ ' + label + ' installs icons into undeclared hicolor dirs:');
      for (const p of problems) console.error('    ' + p);
    } else {
      const sizes = [...new Set(declaredSeen)];
      console.log('✓ ' + label + ' — icons only in declared dirs: ' +
        (sizes.length ? sizes.join(', ') : '(none)'));
    }
  }
  if (failed) {
    console.error('\nIcon lookup ignores undeclared dirs — desktops will show a white card.');
    console.error('Point linux.icon at a directory of size-named PNGs (see build/icons-linux).');
  }
  return failed ? 1 : 0;
}

process.exit(main());