// electron/desktop-shortcuts.js — first-run desktop launcher icons.
//
// Installers already give every platform a launcher except where the OS
// convention makes that impossible:
//   Windows — the NSIS installer drops Desktop + Start Menu shortcuts itself.
//   Linux   — .pacman/.deb install a menu entry, but nothing on the Desktop
//             (and AppImage gets no launcher at all), so we write one here.
//   macOS   — no installer-side mechanism; we symlink the .app onto the
//             Desktop on first launch (Dock pinning stays a user gesture).
//
// Runs at most once per install: a marker file in the app's userData folder
// records that we tried, so deleting the icon later doesn't resurrect it on
// every launch. Creation is best-effort — a failure never breaks startup.
'use strict';

const fs = require('fs');
const path = require('path');

// Resolve $XDG_DESKTOP_DIR (respecting localized desktop folders like
// ~/Escritorio) from ~/.config/user-dirs.dirs, falling back to ~/Desktop.
function linuxDesktopDir(home) {
  try {
    const cfg = fs.readFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'utf8');
    const m = cfg.match(/^\s*XDG_DESKTOP_DIR=(.+)\s*$/m);
    if (m) {
      let v = m[1].trim().replace(/^"|"$/g, '');
      if (v.startsWith('$HOME/')) v = path.join(home, v.slice('$HOME/'.length));
      if (v.startsWith('~')) v = path.join(home, v.slice(1).replace(/^\//, ''));
      if (fs.existsSync(v)) return v;
    }
  } catch (e) { /* no user-dirs.dirs — fall through */ }
  const fallback = path.join(home, 'Desktop');
  return fs.existsSync(fallback) ? fallback : null;
}

// The bundle path of the running macOS app: …/StayChat Desk.app/Contents/MacOS/binary
function macBundlePath(execPath) {
  const i = execPath.indexOf('.app/');
  return i === -1 ? null : execPath.slice(0, i + '.app'.length);
}

function ensureDesktopShortcut(opts) {
  const platform = opts.platform || process.platform;
  const home = opts.home;
  const marker = opts.markerPath;

  if (marker && fs.existsSync(marker)) return { skipped: 'already handled' };

  let created = false;
  if (platform === 'linux') {
    const desktopDir = linuxDesktopDir(home);
    if (!desktopDir) return { skipped: 'no desktop folder' };

    const linkPath = path.join(desktopDir, 'StayChat Desk.desktop');
    // Respect launchers the user already placed there by hand (e.g. KDE's
    // "Link to File" on the app-menu entry) — readFileSync follows symlinks,
    // so a manual link to the system entry is detected by its content.
    const alreadyThere = fs.readdirSync(desktopDir).some((name) => {
      if (!name.endsWith('.desktop')) return false;
      try {
        const txt = fs.readFileSync(path.join(desktopDir, name), 'utf8');
        return /^Exec=.*staychat-desk/m.test(txt) || /^Icon=staychat-desk$/m.test(txt);
      } catch (e) { return false; }
    });
    if (alreadyThere || fs.existsSync(linkPath)) {
      if (marker) fs.writeFileSync(marker, String(Date.now()));
      return { skipped: 'already on desktop' };
    }

    // AppImage runs from a mounted/extracted path that vanishes on exit —
    // the launcher must point at the AppImage file itself ($APPIMAGE).
    const exec = opts.appImage || opts.execPath;
    // Ship our own icon into the hicolor theme so AppImage installs (which
    // don't install system icons) still render; deb/pacman already have it.
    const iconDir = path.join(home, '.local', 'share', 'icons', 'hicolor', '512x512', 'apps');
    try {
      fs.mkdirSync(iconDir, { recursive: true });
      fs.copyFileSync(opts.iconSource, path.join(iconDir, 'staychat-desk.png'));
    } catch (e) { /* system icon may already exist */ }

    const entry = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=StayChat Desk',
      'Comment=Hotel management system — local desktop edition',
      'Exec="' + exec.replace(/"/g, '\\"') + '"',
      'Icon=staychat-desk',
      'Terminal=false',
      'Categories=Office;',
      '',
    ].join('\n');
    fs.writeFileSync(linkPath, entry, { mode: 0o755 });
    fs.chmodSync(linkPath, 0o755); // desktop files must be executable to launch
    created = true;
  } else if (platform === 'darwin') {
    const bundle = macBundlePath(opts.execPath);
    const allowed = bundle &&
      (bundle.startsWith('/Applications/') ||
       bundle.startsWith(path.join(home, 'Applications') + path.sep));
    if (!allowed) return { skipped: 'running outside an Applications folder' };

    const linkPath = path.join(home, 'Desktop', path.basename(bundle));
    if (fs.existsSync(linkPath)) {
      if (marker) fs.writeFileSync(marker, String(Date.now()));
      return { skipped: 'already on desktop' };
    }
    fs.symlinkSync(bundle, linkPath, 'dir');
    created = true;
  } else {
    return { skipped: 'installer creates shortcuts on this platform' };
  }

  if (marker) fs.writeFileSync(marker, String(Date.now()));
  return { created: true };
}

module.exports = { ensureDesktopShortcut, linuxDesktopDir };