# StayChat Desk — Desktop Setup Manual (Windows · macOS · Linux)

**Install and run the whole hotel system as a desktop app** — no server, no
domain, no internet needed after installation.

The app is a native shell around the real system: it boots the Express +
SQLite + WebSocket server **inside the app**, stores the database locally,
opens the dashboard in a native window — and can optionally serve front-desk
tablets and PCs on the same network from that one machine.

> This is the desktop edition of the guide. For the cloud/VPS edition with a
> public domain, read the numbered files in this folder instead, starting at
> [01-prerequisites.md](01-prerequisites.md).

---

## Part 1 — Installing

### 🪟 Windows 10 / 11

**Install**

1. Get **`StayChat Desk Setup 1.0.0.exe`** (from a release, or built into
   `dist/desktop/`).
2. Double-click it. If SmartScreen shows *"Windows protected your PC"* →
   **More info → Run anyway** (the installer is not code-signed yet).
3. Follow the wizard — you can change the install folder (default:
   `%LOCALAPPDATA%\StayChat Desk`; no admin rights needed).
4. Launch from the **Start Menu** or the **StayChat Desk** desktop shortcut.

**First launch**

- A splash screen appears while the database is created and seeded (first run
  takes a few seconds).
- **Firewall prompt:** click **Allow access** on the private network —
  otherwise other front-desk devices can't open the app (you can skip this if
  you'll only ever use this one computer).

**Data folder:** `%APPDATA%\StayChat Desk`
(i.e. `C:\Users\<you>\AppData\Roaming\StayChat Desk` — type it into the File
Explorer address bar. *File → Open Data Folder* in the app opens it too.)

---

### 🍎 macOS

**Install**

1. Get **`StayChat Desk-1.0.0-*.dmg`** — use the **arm64** build on Apple
   Silicon (M1/M2/M3/M4), **x64** on Intel.
2. Open the `.dmg`, drag **StayChat Desk** into **Applications**.
3. Eject the disk image, then launch from Applications / Launchpad / Spotlight.

**First launch — unblocking Gatekeeper** (the app is not notarized yet):

- If macOS says *"StayChat Desk" cannot be opened because it is from an
  unidentified developer* → in **Finder**: **right-click (Control-click) the
  app → Open → Open**. Do this once; afterwards it opens normally.
- Terminal alternative: `xattr -cr "/Applications/StayChat Desk.app"`
- **Network prompt:** allow incoming connections if other devices should reach
  the app.

**Data folder:** `~/Library/Application Support/StayChat Desk`

---

### 🐧 Linux

**Option A — AppImage (any distro)**

```bash
chmod +x "StayChat Desk-1.0.0.AppImage"
./"StayChat Desk-1.0.0.AppImage"
```

*If it won't start:* install FUSE (`sudo apt install libfuse2` on
Ubuntu/Debian; `sudo pacman -S fuse2` on Arch).

**Option B — `.deb` (Ubuntu / Debian / Mint)**

```bash
sudo dpkg -i dist/desktop/staychat-os_1.0.0_amd64.deb
staychat-desk
```

(Package name is `staychat-os`; the launcher/menu entry is **StayChat Desk**.)

**First launch:** creates and seeds the database in `~/.config/StayChat Desk`.
**LAN access:** if you use `ufw`, open the port: `sudo ufw allow 3000/tcp`.

---

### First-run sign-in (all platforms)

Demo data is seeded automatically on first launch. Sign in with (or click
**Demo Access** on the login screen):

| Role | Email | Password |
|---|---|---|
| Super Admin | `superadmin@staychat.io` | `Demo@123456` |
| Hotel Admin | `admin@hospitally.com` | `Demo@123456` |
| Receptionist | `reception@hospitally.com` | `Demo@123456` |
| …full list in [`README.md`](../README.md) → Quick Start | | |

Change the demo passwords (or re-seed without demo data) before real use.

---

## Part 2 — Daily operation

### Sharing with front-desk tablets / PCs

1. On the desk computer: **File → Show Address for Other Devices** — it lists
   `http://<desk-ip>:3000/app`.
2. Other devices on the same Wi-Fi/network open that URL in any browser and
   sign in with the same staff accounts.
3. The database lives **only on the desk computer**; tablets are displays, not
   storage.

### Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `STAYCHAT_PORT` | `3000` (auto-falls-back to a free port if taken) | Fixed port instead of auto-fallback |
| `STAYCHAT_HOST` | `0.0.0.0` (LAN-visible) | Set `127.0.0.1` for private single-machine use |
| `STAYCHAT_DATA_DIR` | per-OS app-data folder | Relocate the database folder |
| `STAYCHAT_UPDATE_URL` | — | Custom auto-update feed (generic HTTPS server) |

Set them before launching (Windows: `setx STAYCHAT_PORT 3001` then reopen the
app; macOS/Linux: launch from a terminal, e.g.
`STAYCHAT_PORT=3001 open -a "StayChat Desk"`). Leaving them unset is the
normal case.

### Backup

Close the app, then copy the **entire data folder** (locations above) to
external storage. Restoring = putting the folder back. That one folder contains
the database **and** the encryption secrets — copy both or credentials won't
decrypt.

### Updates

- Packaged apps check for updates **hourly** (and via
  **Help → Check for Updates…**). The default feed is the GitHub releases of
  `akes2010/staychat` (auto-derived from the git remote); point
  `STAYCHAT_UPDATE_URL` elsewhere to use your own server.
- When an update is downloaded you get a prompt; it installs on **Restart Now**
  or automatically when you quit.
- With no releases published yet, update checks fail silently — the app keeps
  working; ship a new installer manually.
- Releases are produced by the **`desktop-release`** GitHub workflow
  ([`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml)): push a
  `v*` tag → it runs a headless boot smoke test, then builds Windows, macOS and
  Linux installers.

### Uninstall

| OS | Steps | Data |
|---|---|---|
| Windows | Settings → Apps → **StayChat Desk** → Uninstall | Kept in `%APPDATA%\StayChat Desk` — delete manually for a clean wipe |
| macOS | Delete `StayChat Desk.app` from Applications | Kept in `~/Library/Application Support/StayChat Desk` |
| Linux (deb) | `sudo dpkg -r staychat-os` | Kept in `~/.config/StayChat Desk` |
| Linux (AppImage) | Delete the `.AppImage` file | Kept in `~/.config/StayChat Desk` |

---

## Part 3 — Building it yourself (developers)

**Prerequisites:** Node.js **20+** and git, plus a native-build toolchain if
the SQLite driver needs compiling:

- **Windows:** VS Build Tools (C++) + Python — [nodejs.org](https://nodejs.org)
  LTS is enough if the prebuilt driver matches
- **macOS:** `xcode-select --install`
- **Linux:** `sudo apt install build-essential python3`

```bash
npm install              # installs deps, builds driver for Node
npm run desktop:rebuild  # rebuild SQLite driver for Electron (once)
npm run desktop          # launch the app
```

> **Driver ABI note:** the native driver is built for one runtime at a time —
> `npm run desktop:rebuild` before `npm run desktop`, `npm run rebuild` before
> `npm start` / `npm run dev`.

**Build installers** (output → `dist/desktop/`):

```bash
npm run dist          # current OS
npm run dist:win      # NSIS .exe      (works from Linux too)
npm run dist:mac      # .dmg           (build on macOS)
npm run dist:linux    # .AppImage + .deb
```

- The `.deb` target needs an Ubuntu/Debian-like host (electron-builder's
  bundled `fpm`/ruby requires `libcrypt.so.1` — absent on Arch-based systems;
  CI's Ubuntu runner is fine).
- Icons: `build/icon.png` (512×512) is the installer/app icon; regenerate with
  `npm run icons`.

**Smoke-test the exact boot path the app uses (no GUI):**

```bash
STAYCHAT_DATA_DIR=/tmp/x STAYCHAT_PORT=3456 node electron/boot-server.js
# → "DESKTOP BOOT OK" once healthy
```

---

## Part 4 — Troubleshooting

| Symptom | Fix |
|---|---|
| *"StayChat Desk could not start"* mentioning port 3000 | Something holds the port; the app auto-falls back — use **File → Show Address for Other Devices** for the real URL, or set `STAYCHAT_PORT` |
| macOS: *"unidentified developer"* | Right-click → **Open** once (see Part 1) |
| AppImage won't launch | `chmod +x` it; install `libfuse2` / `fuse2` |
| Other devices can't reach the app | Allow the app through the firewall (Windows: Allow on private networks; Linux: `ufw allow 3000/tcp`); device must be on the same network, not a guest/AP-isolated WLAN |
| Dev run fails with `NODE_MODULE_VERSION` mismatch | Wrong driver build for the runtime — `npm run rebuild` (Node) or `npm run desktop:rebuild` (Electron) |
| Need to see what's happening | Launch from a terminal to watch server logs, or run `node electron/boot-server.js` directly |