# StayChat OS — Operations & Capacity Guide

How to choose a server, install the system, and keep it updated **remotely from
GitHub** without ever risking tenant data. The day-to-day install runbook lives
in [`SETUP.md`](SETUP.md); this document covers **sizing + safe remote updates**.

---

## 1. Recommended server specifications

All numbers below are **measured**, not guessed — they come from the load test in
`scripts/load-test.js` (production mode, SQLite/WAL, single Node process, one
laptop-class core boosting to 4.8 GHz). Two profiles were run — 1000 concurrent
staff across **5 tenants** and the same 1000 staff spread across **200 tenants**:

| Measured at 1000 concurrent users | 5 tenants | 200 tenants (platform scale) |
|---|---|---|
| Throughput | ~840 req/s (plus 1000 live WebSockets, ~115k broadcast msgs/45s) | **827 req/s** (1000 live WS, 0 drops) |
| Latency | p50 3.8ms · **p95 19ms** · p99 33ms | p50 7ms · **p95 41ms** · p99 516ms (ramp spike only) |
| Errors | 0 | 0 (all responses 2xx) |
| Cross-tenant WS leaks | 0 | 0 |
| CPU | ~77% of ONE core | **avg 89%** of one core |
| RAM (server RSS) | peak 193–250MB | peak **211MB** (heap 95MB) |
| Login burst (300 simultaneous) | all succeed, API at single-digit ms | canary p95 **7.3ms** during the burst — event loop never froze |

**Tenant count is nearly free.** 200 hotels vs 5 costs ~+15% CPU and +22ms p95 —
the cost driver is *concurrency* (how many staff are clicking right now), not how
many properties share the process. The practical limit stays the single fast core.

> Reproduce (isolated DB, never prod data):
> `node scripts/load-test.js setup --tenants 200 --users 1000` →
> `DATA_DIR=./data/loadtest PORT=3100 NODE_ENV=production node server/index.js` →
> `node scripts/load-test.js run --users 1000 --duration 45` → `… logins --users 300`

### Sizing table

| Tier | Scale | CPU | RAM | Disk | Example plans* |
|---|---|---|---|---|---|
| Demo / staging | 1 hotel, 1–50 staff | 2 vCPU | 2–4 GB | 40 GB NVMe | smallest VPS anywhere |
| Small production | 1–20 hotels, up to ~500 staff | 2–4 vCPU @ ≥3.0 GHz | 4–8 GB | 40–80 GB NVMe | Contabo VPS 100 tier, Hetzner CX22/CPX21, Lightsail 4 GB |
| **Target (500–1000 staff, the tested profile)** | up to ~50 hotels | **4 vCPU @ ≥3.2 GHz** | **8 GB** | **80 GB NVMe** | Contabo VPS 200 / Cloud VPS tier, Hetzner CX32/CPX31, DO 8 GB, Vultr 8 GB |
| **Platform scale (100–200 tenants — measured)** | 100–200 hotels, up to 1000 busy staff | **8 vCPU @ ≥3.2 GHz** | **16 GB** | **160 GB NVMe** | Contabo VPS 400 tier, Hetzner CX52/CPX41, DO 16 GB, Vultr 16 GB |
| Growth (>1000 busy users across many large properties) | 200+ hotels | 8–16 vCPU | 32 GB | 320 GB NVMe + start the [SQLite → PostgreSQL path](../README.md#scaling-up-sqlite--postgresql) | dedicated/bare metal |

**Why 8 vCPU / 16 GB for the 100–200 tenant tier "without scratching":** the
measured 200-tenant run held avg 89% of ONE 4.8 GHz boost core. Cloud vCPU
cores sustain ~3.2 GHz (≈30–40% slower than that laptop boost), so one busy
core saturates — you want 2–3 fast cores of app headroom plus cores for WAL
I/O, Docker, the daily `VACUUM INTO` backup and bcrypt worker threads during
morning login rushes. 16 GB RAM keeps years of SQLite page cache hot (the app
itself peaks at ~211MB RSS — the rest is deliberate file cache, which is what
makes 100-tenant reporting queries fast).

\* SKU names change — match the **spec**, not the name.

**Why these numbers**

- **Single-core speed is the #1 factor.** The app is one Node process; the tests
  showed 77–89% of one core at 1000 users (5→200 tenants). Clock speed buys
  headroom; extra cores help SQLite WAL I/O, the OS, Docker, backups and the
  bcrypt worker threads.
- **RAM:** Node heap + 64MB SQLite page cache + 256MB mmap window + Docker +
  OS page cache. 8GB is comfortable at 1000 users (peak RSS measured 250MB for
  the app alone); 4GB is the practical floor.
- **Disk:** NVMe SSD, **local** (never NFS/network storage — SQLite WAL
  requires a local filesystem). WAL + daily `VACUUM INTO` backups + logs:
  80GB gives years of headroom. Keep ≥20% free.
- **Bandwidth:** worst-case measured ~21MB/s sustained at 1000 users
  (~940MB per 45s). Real staff traffic is far lower (the SPA polls nothing —
  it is WebSocket-driven), but pick ≥10TB/month or unmetered.

### Shared hosting (cPanel / Plesk / "PHP hosting")

**Not suitable** — the system needs a long-running Node.js process, WebSocket
connections, native modules (`better-sqlite3`) and a persistent SQLite file;
typical shared hosting offers none of these. Closest viable options, in order:

1. **Any root VPS** (Contabo, Hetzner, DigitalOcean, Vultr, Hostinger KVM,
   AWS Lightsail, GCP) — the documented path, full control, cheapest per core.
2. **Container PaaS** — Render / Railway / Fly.io (README "Quick Start" options
   B/C). Attach a **persistent disk** to `DATA_DIR` — without it the database
   resets on every deploy.
3. If you are forced onto a managed panel, you need at minimum: Node 18+
   (22 recommended), persistent process manager (pm2/systemd), and WebSocket
   support (no read-only `public_html`-only accounts).

### OS baseline

Ubuntu 22.04/24.04 LTS · 2GB swap file · automatic security updates ·
NTP enabled · firewall: only 22/80/443 (the setup script does this).

---

## 2. Installation

### Option A (recommended) — Docker kit on a VPS

```bash
# from your laptop, repo checked out:
npm run smoke                       # 0. exit code proves the repo deploys as-is
REMOTE=root@YOUR_VPS_IP DOMAIN=staychat.yourdomain.com deploy/deploy.sh
```

One command: uploads code (never `data/` or `.env`), installs Docker, generates
**fresh secrets**, opens the firewall, builds, seeds, waits for health.
Manual/step-by-step and provider notes: [`SETUP.md`](SETUP.md).
After it goes green, walk [`POST-DEPLOY-CHECKLIST.md`](POST-DEPLOY-CHECKLIST.md).

Daily DB backups (03:17, integrity-verified, 14-day retention) are installed
automatically as a cron job by `setup-vps.sh`; add
[`sync-backups-offsite.sh`](sync-backups-offsite.sh) to push them to
another machine/object storage.

### Option B — plain VPS without Docker (pm2)

```bash
sudo apt install -y nodejs npm git            # Node 22 recommended (nvm)
git clone <repo> /opt/staychat-os && cd /opt/staychat-os
npm install --omit=dev                        # postinstall rebuilds better-sqlite3
cp .env.example .env                          # then GENERATE the 4 secrets (see below)
npm run seed && npm run check
npm install -g pm2 && pm2 start server/index.js --name staychat
pm2 save && pm2 startup                       # restart on reboot
```

Nginx/Caddy in front for HTTPS (see [`Caddyfile`](Caddyfile)).

### Secrets (both options) — generate, never invent

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_ACCESS_SECRET
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_REFRESH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # COOKIE_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # CREDENTIALS_ENCRYPTION_KEY
```

| Variable | Purpose | Notes |
|---|---|---|
| `NODE_ENV=production` | cookie/JWT hardening | required |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | session signing | rotating them logs everyone out |
| `COOKIE_SECRET` | cookie signing | mandatory in production (server refuses without) |
| `CREDENTIALS_ENCRYPTION_KEY` | AES-256-GCM for tenant gateway/API keys | **changing it makes saved credentials undecryptable** |
| `DATA_DIR` | where `staychat.db` lives | keep on local disk; Docker kit uses the `staychat_data` volume |
| `CORS_ORIGIN` | public origin(s) | set to `https://staychat.yourdomain.com` |
| `RATE_LIMIT_GLOBAL_MAX` | per-IP req/min (default 200) | raise if many staff share one office IP |
| `WS_MAX_CLIENTS_PER_TENANT` | WS cap (default 2000) | covers a 1000-seat hotel |
| `BCRYPT_WORKERS` | bcrypt thread pool (default cpus-2, ≤6) | login-storm protection |
| `ACCESS_LOG` | per-request log (default on) | `off` when a log shipper owns stdout |

---

## 3. Remote updates from GitHub that cannot harm tenant data

### The invariant: code and data live in different worlds

| Surface | Owner | What a deploy may touch |
|---|---|---|
| `server/`, `public/`, `package*.json` | **git** | replaced exactly as committed |
| `data/staychat.db` (+ `-wal`, `-shm`) | **the server** | **never by a deploy** — `data/` is in `.gitignore`, every sync excludes it, Docker keeps it in the `staychat_data` volume that survives image swaps |
| `.env` (all secrets, gateway keys) | **the server** | **never by a deploy** — excluded from every code-sync step |
| Schema (`server/db/migrate.js`) | git | strictly **additive** (`CREATE TABLE IF NOT EXISTS`, column-existence guards); running it on an existing DB produces zero row drift; the server runs it automatically at every container start |
| Demo seed (`server/db/seed.js`) | git | **no-op when tenants exist** — it only seeds an empty database. `FORCE_SEED=1` (the wipe flag) must never be set in production |

So an update can only ever change *code*, never *tenants* — and the pipeline
below verifies that claim before and after the swap.

### The pipeline (already wired up)

```
you:  git push origin master
GitHub:  CI (.github/workflows/ci.yml) ─── 9-suite regression battery ── red ⇒ STOP, nothing deploys
GitHub:  Deploy (.github/workflows/deploy.yml) ─── SSH ──► VPS
VPS:     bash deploy/update.sh --pull
           1. preflight: .env present? container up? ≥1GB disk free?
           2. record current git ref + image ID (rollback points)
           3. MAINTENANCE=1 → API answers 503 JSON (health & webhooks stay up)
           4. DB snapshot: VACUUM INTO + integrity_check → /opt/backups/staychat-<stamp>.db.gz
           5. git pull (only tracked code files)
           6. build new image
           7. PRE-FLIGHT MIGRATION: new code's migrate.js runs against a COPY
              of the live DB — a bad migration aborts here, old container
              untouched and still serving
           8. swap containers (new one re-runs migrate + seed-guard + check)
           9. verify: /api/health 200, seed check, auth answers 401 on bad
              password, key pages 200
          10. lift maintenance
           ── ANY step fails ⇒ automatic rollback: previous image + git ref +
              DB restore from the snapshot just taken, maintenance left ON ──
```

### One-time setup for the GitHub → server link

1. On the VPS, generate a **dedicated deploy key** (not your personal key):
   ```bash
   ssh-keygen -t ed25519 -f ~/.staychat_deploy -N '' -C 'github-deploy'
   # add the .pub line to the repo as a Deploy Key (Settings → Deploy keys, read-only is enough)
   ```
2. In GitHub → Settings → Secrets and variables → **Actions**, add:
   `DEPLOY_HOST`, `DEPLOY_USER` (e.g. `root`), `DEPLOY_SSH_KEY` (contents of
   `~/.staychat_deploy`), optional `DEPLOY_PATH` (default `/opt/staychat-os`).
3. Optional approval gate: repo → Environments → create `production` →
   add "Required reviewers". Now every deploy waits for your click.
4. Push to `master`. CI runs; on green, Deploy runs `deploy/update.sh --pull`
   on the server. Watch it under Actions → Deploy; if secrets aren't
   configured yet, the workflow **skips with a notice** (never red).

### Manual / emergency equivalent

```bash
ssh root@YOUR_VPS_IP
cd /opt/staychat-os && bash deploy/update.sh --pull        # same safety chain
# lift maintenance after a failed update / manual intervention:
bash deploy/update.sh --lift-maintenance
```

### Option B (pm2, no Docker) — the same safety chain by hand

`deploy/update.sh` drives Docker; for a pm2 install run the equivalent steps
in this order (each protects the step after it):

```bash
cd /opt/staychat-os
# 1. snapshot FIRST (consistent VACUUM INTO copy — never cp a live WAL db)
node -e "const db=require('better-sqlite3')('data/staychat.db'); \
  db.exec(\"VACUUM INTO 'data/preupdate-$(date +%F-%H%M).db'\"); db.close();"
# 2. pull code — git only replaces TRACKED files; data/ (.gitignored) and
#    .env (untracked) are untouched by construction
if git rev-parse HEAD >/dev/null 2>&1; then git pull; else git status; fi
# 3. dependencies + native module rebuilt for this Node version
npm ci --omit=dev        # postinstall rebuilds better-sqlite3 (npm run rebuild)
# 4. additive, idempotent migrations (safe to run on existing data)
node server/db/migrate.js
# 5. restart + verify
pm2 restart staychat && sleep 2
curl -fsS localhost:3000/api/health >/dev/null && echo OK
```

Rollback: `git checkout <previous-tag> && npm ci --omit=dev && pm2 restart
staychat`, and if the data itself was damaged, stop the app and replace
`data/staychat.db` with the `preupdate-*.db` snapshot taken in step 1.

### Rollback

Automatic on any failed update. Manual:

```bash
ls -1t /opt/backups/                          # dated .db.gz snapshots + update-state/<stamp>/{image-id,git-ref}
git -C /opt/staychat-os log --oneline -10     # pick the previous good commit
```
Restore = check out that commit (or re-run `deploy/deploy.sh` with the old
ref) + `bash deploy/backup-db.sh`-style restore of the chosen snapshot; the
update script prints exactly which files it recorded if a manual rollback is
ever needed.

### Rules that keep upgrades safe (the "systematic update" contract)

1. **Merge only green CI.** The 9-suite battery is the same gate the update
   script uses; red means the change is not ready.
2. **Tag releases** — `git tag v1.4.0 && git push --tags` before/after each
   deploy so any version can be identified and reverted later.
3. **Schema changes only via `migrate.js`, additive** — new tables/columns with
   `IF NOT EXISTS` / existence guards; never edit or drop existing columns in
   place. Destructive cleanups ship as a separate, reviewed migration with a
   backup note.
4. **Never** run `FORCE_SEED=1`, `git checkout -- data/`, `git clean` on the
   server, or delete `.env` — none of these are part of any deploy path.
5. **Backups before every deploy** are automatic (step 4 above) — also keep the
   daily cron + [`sync-backups-offsite.sh`](sync-backups-offsite.sh) (3-2-1:
   local snapshots, offsite copy, versioned code).
6. **Load-test a staging copy** when touching hot paths:
   ```bash
   node scripts/load-test.js setup --tenants 5 --users 1000   # isolated DB, never prod data
   DATA_DIR=./data/loadtest PORT=3100 node server/index.js
   node scripts/load-test.js run --users 1000 --duration 45
   ```

### Watch it in production

- `GET /api/health` — liveness (uptime monitors / Uptime Kuma)
- `GET /api/health/detailed` — RSS + cumulative CPU (both exposed as fields;
  diff two samples against wall time for CPU %)
- Docker log rotation: in `deploy/docker-compose.prod.yml` set
  `logging: { driver: json-file, options: { max-size: "50m", max-file: "5" } }`
  (or rely on `ACCESS_LOG=off` + an external shipper).
- Disk: alert below 1GB free — the update script refuses to run without it.
