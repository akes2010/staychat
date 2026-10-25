// electron/main.js — StayChat Desk: the whole system as a desktop app.
//
// The app is a thin native shell around the real server: on launch it boots
// the embedded Express + SQLite + WebSocket server (electron/boot-server.js)
// with data in the OS app-data dir, then opens the dashboard in a native
// window. The server also listens on the LAN, so tablets/PCs at the front
// desk can open the same app from their own browsers.
'use strict';

const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const path = require('path');

const { boot } = require('./boot-server');
const { ensureDesktopShortcut } = require('./desktop-shortcuts');

// ── Auto-update (packaged builds only) ──────────────────────────────────────
// electron-updater reads resources/app-update.yml (written by electron-builder
// at build time). The feed URL can also be overridden at runtime with
// STAYCHAT_UPDATE_URL — e.g. a generic https server you control. With no feed
// configured, checks fail silently and the app simply never updates itself;
// nothing else in the app depends on this code path.
let autoUpdater = null;
let updateStatus = 'not checked';

function initAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    const feed = process.env.STAYCHAT_UPDATE_URL;
    if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed });

    autoUpdater.on('update-available', (info) => {
      updateStatus = `v${info.version} downloading…`;
    });
    autoUpdater.on('update-downloaded', (info) => {
      updateStatus = `v${info.version} ready`;
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      dialog.showMessageBox(win || BrowserWindow.getAllWindows()[0], {
        type: 'info',
        title: 'Update ready',
        message: `StayChat Desk ${info.version} has been downloaded.`,
        detail: 'It will install automatically when you quit the app, or you can restart now.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => { if (response === 0) autoUpdater.quitAndInstall(); });
    });
    autoUpdater.on('error', () => { updateStatus = 'update check failed'; });

    checkForUpdates(false);
    setInterval(() => checkForUpdates(false), 60 * 60 * 1000); // hourly
  } catch (err) {
    console.warn('auto-update unavailable:', err.message);
  }
}

function checkForUpdates(interactive) {
  if (!autoUpdater) {
    if (interactive) {
      dialog.showMessageBox({ type: 'info', title: 'Check for Updates',
        message: 'Development build — updates are only checked in packaged installs.', buttons: ['OK'] });
    }
    return;
  }
  autoUpdater.checkForUpdates()
    .then((r) => {
      if (!interactive) return;
      const ver = r && r.updateInfo && r.updateInfo.version;
      if (ver && ver !== app.getVersion()) {
        updateStatus = `v${ver} available`;
      } else {
        updateStatus = 'up to date';
        dialog.showMessageBox({ type: 'info', title: 'Check for Updates',
          message: `You're running the latest version (${app.getVersion()}).`, buttons: ['OK'] });
      }
    })
    .catch((err) => {
      updateStatus = 'update check failed';
      if (interactive) {
        dialog.showMessageBox({ type: 'warning', title: 'Check for Updates',
          message: 'Could not check for updates.',
          detail: String(err.message || err), buttons: ['OK'] });
      }
    });
}

app.setName('StayChat Desk');

// ── Single instance ─────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow = null;
  let bootInfo = null;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // ── Window ────────────────────────────────────────────────────────────────
  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1360,
      height: 860,
      minWidth: 1024,
      minHeight: 700,
      title: 'StayChat Desk',
      backgroundColor: '#0f1220',
      icon: path.join(__dirname, '..', 'public', 'icon-512.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });

    // Splash while the embedded server migrates + seeds the database (first
    // launch hashes demo passwords — a few seconds; the renderer keeps
    // painting even though the boot work runs on the main process).
    mainWindow.loadURL(
      'data:text/html;charset=utf-8,' +
      encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>StayChat Desk</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px;background:#0f1220;color:#e7eaf6;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
.logo{font-size:26px;font-weight:700;letter-spacing:.3px}
.spin{width:34px;height:34px;border-radius:50%;border:3px solid #2a3050;border-top-color:#4f8cff;animation:sp .9s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}</style>
<div class="logo">StayChat Desk</div><div class="spin"></div>
<div style="color:#8b93b5;font-size:13px">Starting your hotel system…</div>`)
    );

    // No navigation away from the local server, no surprise popups.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url) && !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
      return { action: 'allow' };
    });
    mainWindow.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost') && !url.startsWith('data:')) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });

    mainWindow.on('closed', () => { mainWindow = null; });
  }

  // ── Menu ──────────────────────────────────────────────────────────────────
  function buildMenu() {
    const template = [
      ...(process.platform === 'darwin' ? [{
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      }] : []),
      {
        label: 'File',
        submenu: [
          {
            label: 'Open Data Folder',
            click: () => bootInfo && shell.openPath(bootInfo.dataDir),
          },
          {
            label: 'Show Address for Other Devices',
            click: () => {
              if (!bootInfo) return;
              const list = bootInfo.lanUrls.length
                ? bootInfo.lanUrls.map(u => '  ' + u).join('\n')
                : '  (no LAN interface found — this computer is not on a network)';
              dialog.showMessageBox({
                type: 'info',
                title: 'StayChat on your network',
                message: 'Other devices on the same Wi-Fi/network can open:',
                detail: list + '\n\nLog in with the same staff accounts. The database lives on this computer.',
                buttons: ['OK'],
              });
            },
          },
          { type: 'separator' },
          process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
        ],
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload' },
          { role: 'togglefullscreen' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
        ],
      },
      {
        label: 'Help',
        submenu: [
          {
            label: 'Check for Updates…',
            click: () => checkForUpdates(true),
          },
          {
            label: `Version ${app.getVersion()}`,
            enabled: false,
          },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // ── IPC for the preload bridge ────────────────────────────────────────────
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    url: bootInfo && bootInfo.url,
    lanUrls: bootInfo ? bootInfo.lanUrls : [],
    dataDir: bootInfo ? bootInfo.dataDir : null,
    updateStatus,
    platform: process.platform,
  }));

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  app.whenReady().then(async () => {
    createWindow();
    buildMenu();
    initAutoUpdate();

    try {
      // Packaged builds live inside a read-only asar archive, so data goes
      // to the OS app-data dir (~/Library/Application Support/StayChat Desk,
      // %APPDATA%\StayChat Desk, ~/.config/StayChat Desk) — it survives
      // updates and is the folder users back up. From source we keep the
      // repo's data/ dir (same as `npm start`) for dev continuity.
      bootInfo = await boot(app.isPackaged ? { dataDir: app.getPath('userData') } : {});
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(bootInfo.url);
      }
    } catch (err) {
      console.error('StayChat failed to start:', err);
      dialog.showErrorBox(
        'StayChat Desk could not start',
        (err && err.message ? err.message : String(err)) +
        '\n\nIf port 3000 is in use by another app, set STAYCHAT_PORT and try again.'
      );
      app.quit();
    }

    // Packaged installs only: put a launcher on the Desktop where the
    // platform offers no installer-side way to (Linux .pacman/.deb/AppImage,
    // macOS). Windows is covered by the NSIS installer's shortcuts. Runs at
    // most once — see desktop-shortcuts.js — and never blocks startup.
    if (app.isPackaged) {
      try {
        const r = ensureDesktopShortcut({
          platform: process.platform,
          home: require('os').homedir(),
          markerPath: path.join(app.getPath('userData'), '.desktop-shortcut-done'),
          execPath: process.execPath,
          appImage: process.env.APPIMAGE,
          iconSource: path.join(__dirname, '..', 'public', 'icon-512.png'),
        });
        if (r.created) console.log('desktop shortcut created');
      } catch (err) {
        console.warn('desktop shortcut skipped:', err.message);
      }
    }
  });

  // Server lifecycle is tied to the window: closing the app stops the local
  // server (same expectation as any desktop app).
  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    // server/index.js drains on SIGTERM/SIGINT; process.exit on quit is enough
    // for SQLite (WAL + synchronous API) — every completed write is on disk.
  });
}
