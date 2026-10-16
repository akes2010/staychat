# StayChat OS — Complete Setup Tutorial (Contabo · Truehost · any Cloud VPS)

A true beginner's, copy-paste step-by-step guide: from "I just bought a VPS" to
"a live HTTPS system with auto-deploy from GitHub, daily backups and rollback
safety". Every command in this tutorial exists in this repo's `deploy/` kit —
nothing here is aspirational.

> Prefer the short version? [`SETUP.md`](SETUP.md) is the condensed runbook and
> [`OPERATIONS.md`](OPERATIONS.md) covers sizing + the update-safety model.
> This tutorial is the long, guided path.
>
> **Want a separate, file-by-file guide folder?** See
> [`../install-guide/`](../install-guide/) — the same walkthrough split into
> 10 focused files (with Cloudflare-specific DNS steps).

---

## What you are building

| Piece | Runs as | Public? |
|---|---|---|
| App (Express + SQLite + WebSocket) | `staychat` container, internal `:3000` | no — only Caddy reaches it |
| HTTPS + reverse proxy + auto Let's Encrypt certs | `caddy` container | **yes — ports 80/443** |
| Database | Docker volume `staychat_data` → `/app/data/staychat.db` | no |
| Daily DB backups (03:17, 14-day retention) | cron on the VPS → `/opt/backups` | no |
| Future updates | GitHub Actions → `deploy/update.sh` on the VPS | n/a |

Two hard rules the whole kit is built around — you never have to think about
them again once deployed:

1. **Code and data live in different worlds.** Deploys replace code only; your
   database and `.env` secrets are owned by the server and never touched.
2. **Every update is reversible.** DB snapshot first, migrations rehearsed on a
   *copy* of your data, health checks after swap, automatic rollback on any
   failure.

---

## Step 0 — What you need (5 minutes)

1. **A VPS** (any of these works — specs in Step 1):
   - **Contabo** — cheapest per core ([contabo.com](https://contabo.com) → VPS → Cloud VPS)
   - **Truehost** — good local/regional option ([truehost](https://truehost.com) → KVM VPS)
   - **Cloud** — DigitalOcean, Hetzner, Vultr, Linode, AWS Lightsail, GCP, AWS EC2
2. **A domain** (or a subdomain) you control — e.g. `staychat.yourdomain.com`.
   A cheap domain works; you only need to add one DNS record.
3. **Your laptop** with: `git`, `ssh`, `bash` (macOS/Linux/WSL all fine), and
   Node 18+ (22 recommended) for the pre-flight smoke test.

---

## Step 1 — Buy + prepare the VPS (10–15 minutes)

### Sizing (measured numbers — see [OPERATIONS.md](OPERATIONS.md) §1)

| Tier | Who | CPU | RAM | Disk | Example |
|---|---|---|---|---|---|
| Demo / staging | you, testers | 2 vCPU | 2–4 GB | 40 GB | smallest VPS anywhere |
| Small production | up to ~500 staff | 2–4 vCPU ≥3.0 GHz | 4–8 GB | 40–80 GB NVMe | Contabo VPS 100 tier, Hetzner CX22 |
| **Target** | 500–1000 staff | **4 vCPU ≥3.2 GHz** | **8 GB** | **80 GB NVMe** | Contabo VPS 200 tier, DO 8 GB |

Single-core **speed** matters most (the app is one Node process; measured 77%
of one core at 1000 concurrent users). Disk must be **local NVMe/SSD** — never
network storage (SQLite WAL requires a local filesystem).

### Provider specifics

| Step | Contabo | Truehost | Generic cloud (DO/Hetzner/Vultr/Lightsail/GCP) |
|---|---|---|---|
| Order | [contabo.com](https://contabo.com) → VPS → **Cloud VPS** | Client Area → Services → **KVM VPS** | Create Droplet/Instance/VM |
| Image | **Ubuntu 24.04 LTS** | **Ubuntu 24.04 LTS** | Ubuntu 22.04/24.04 LTS |
| Plan | smallest is fine to start | smallest is fine to start | smallest is fine to start |
| Root access | root password arrives **by email** | root password in the client panel | SSH key you add at creation (recommended) |
| Extra config | none | none | GCP: create `e2-small`, allow HTTP+HTTPS in the firewall rules |

**First login** (from your laptop, `VPS_IP` = the IP from the provider panel):

```bash
ssh root@VPS_IP
# Contabo/Truehost: paste the emailed password, then immediately add your key:
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'YOUR_PUBLIC_KEY_HERE' >> ~/.ssh/authorized_keys   # from: cat ~/.ssh/id_ed25519.pub
```

From now on `ssh root@VPS_IP` logs you in without a password.

> **Truehost/Contabo caveat:** outbound **port 25 is often blocked** on new
> VPSs. That's fine — StayChat sends email through Resend/SMTP APIs over port
> 443, which is never blocked (Step 8).

---

## Step 2 — Point your domain at the VPS (5 minutes)

In your **domain registrar's** DNS panel (or the provider's DNS zone —
Truehost: Client Area → DNS Zone; Contabo: the domain panel you bought the
domain with), add **one record**:

| Type | Name | Value | TTL |
|---|---|---|---|
| **A** | `staychat` (or `@` for the bare domain) | `YOUR_VPS_IPV4` | 3600 |

Verify **before continuing** (Caddy cannot get a certificate unless this
resolves publicly):

```bash
dig +short staychat.yourdomain.com    # must print YOUR_VPS_IPV4
```

DNS can take a few minutes to a few hours to propagate. `ping` works too.

---

## Step 3 — Prove deployability before spending anything else (2 minutes)

On **your laptop**, in this repo:

```bash
npm run smoke
```

This copies the repo to a throwaway directory *exactly as a fresh VPS would
receive it*, generates real production secrets, migrates from zero, seeds,
boots in production mode and walks the real first hour (landing page, booking
page, a live self-service signup, seeded rooms). **Exit 0 = the repo deploys
as-is.** If it fails, fix that first — deploying a broken tree wastes an hour
on the VPS.

---

## Step 4 — Deploy (one command from your laptop)

### Option A — automatic (recommended for your first deploy)

```bash
REMOTE=root@VPS_IP DOMAIN=staychat.yourdomain.com deploy/deploy.sh
```

That single command: uploads the code (never `data/` or `.env`), installs
Docker, **generates fresh secrets** (JWT, cookie, credential-encryption keys),
opens the firewall (22/80/443), builds the images, starts the stack, seeds
demo data and waits until `/api/health` is green. Re-running it later safely
redeploys (it backs up the DB first).

### Option B — git-based first deploy (recommended if you'll maintain remotely)

Deploying straight from GitHub makes every future upgrade a one-line push.
**On the VPS** (one time only):

```bash
apt-get update && apt-get install -y git
# a dedicated read-only deploy key — not your personal key:
ssh-keygen -t ed25519 -N '' -f /root/.ssh/staychat_deploy
cat /root/.ssh/staychat_deploy.pub        # → copy this line
cat >> /root/.ssh/config <<'CFG'
Host github-staychat
  HostName github.com
  User git
  IdentityFile /root/.ssh/staychat_deploy
CFG
```

Paste the `.pub` line into GitHub → your repo → **Settings → Deploy keys →
Add deploy key** (leave "Allow write access" **unchecked**), then:

```bash
git clone git@github-staychat:YOUR_USER/YOUR_REPO.git /opt/staychat-os
cd /opt/staychat-os && DOMAIN=staychat.yourdomain.com bash deploy/setup-vps.sh
```

`setup-vps.sh` does the server-side half: installs Docker + the Compose
plugin, generates the secrets into `/opt/staychat-os/.env` (once — re-runs
never overwrite them), opens ufw 22/80/443, brings the stack up, and installs
the **daily 03:17 backup cron** (14 days retained in `/opt/backups`).

> Recommended once per new VPS (the setup script leaves these to you):
> `apt-get install -y unattended-upgrades && dpkg-reconfigure -f noninteractive
> unattended-upgrades` for automatic security patches, and a 2 GB swap file
> (`fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile &&
> swapon /swapfile` + fstab entry) — see [OPERATIONS.md](OPERATIONS.md) §1
> OS baseline.

---

## Step 5 — First visit + first login (2 minutes)

1. Open **`https://staychat.yourdomain.com`** — automatic HTTPS. The first
   visit can take ~1 minute while Let's Encrypt issues the certificate.
   Watch it: `docker logs -f caddy`.
2. Log in with the seeded accounts:

| Role | Email | Password |
|---|---|---|
| Super Admin (platform) | `superadmin@staychat.io` | `Demo@123456` |
| Hotel Admin (demo hotel) | `admin@hospitally.com` | `Demo@123456` |

3. **Change both passwords immediately** (Users → pick user → reset), and do a
   quick sanity tour: Dashboard, Rooms, Bookings, POS, Super Admin console.

Verify from outside like a customer would:

```bash
curl -sI https://staychat.yourdomain.com | head -3      # 200 + HSTS
curl -s https://staychat.yourdomain.com/api/health       # healthy JSON
bash deploy/check-deployment.sh                          # full verification, run ON the VPS
```

---

## Step 6 — Wire GitHub auto-deploy (10 minutes, do it now or later)

After this, **every push to `master` = tested, backed-up, auto-rolled-back
deployment**. No SSH needed ever again.

1. **On the VPS** — reuse the deploy key from Option B (or make one):
   ```bash
   cat /root/.ssh/staychat_deploy        # copy the WHOLE private key
   ```
2. **On GitHub** → repo → Settings → Secrets and variables → **Actions** →
   New secret, add all four:

   | Secret | Value |
   |---|---|
   | `DEPLOY_HOST` | `YOUR_VPS_IP` (or the domain) |
   | `DEPLOY_USER` | `root` |
   | `DEPLOY_SSH_KEY` | the whole private key from above |
   | `DEPLOY_PATH` | `/opt/staychat-os` (the default — optional) |

3. *(Optional but recommended)* Add a manual approval gate: repo →
   **Environments** → create `production` → add yourself as "Required
   reviewer". Now every deploy waits for your click in the Actions tab.
4. Test it: `git push origin master` → watch **Actions → CI** (the full
   regression battery) → then **Actions → Deploy**. The deploy step runs
   `deploy/update.sh --pull` on the server: backup → maintenance mode →
   migration dress-rehearsal on a DB *copy* → build → swap → health/auth/page
   checks → lift maintenance. **Any failure = automatic rollback** of code +
   image + DB, with maintenance left on so you can look around.

> If the secrets aren't configured yet, the Deploy workflow prints a notice
> and skips — CI stays green either way. (This is exactly how it behaves on
> this repo today.)

---

## Step 7 — Walk the real first hour (15 minutes)

The smoke test already proved this works; now do it on your live domain:

1. **Public side** — open `https://<domain>/signup`, sign up a *test* hotel:
   you get a 14-day full-feature trial, auto-seeded starter workspace
   (floor, categories, 8 real bookable rooms), booking engine enabled.
2. **That hotel's desk** — log in as the new hotel admin, create a booking,
   check the guest in, take a payment, settle, check out. Watch the live
   WebSocket updates between two browser tabs.
3. **Booking engine** — open `https://<domain>/book.html` as an anonymous
   guest and make a booking end-to-end.
4. Then **wipe the demo data** before real hotels arrive (keeps the
   superadmin login, secrets and platform settings; takes a backup first):
   ```bash
   cd /opt/staychat-os && bash deploy/wipe-demo.sh    # type WIPE to confirm
   ```

---

## Step 8 — Turn on email (5 minutes)

Email is no-op until configured (never an error, just logged). Two options:

**Option A — Resend (recommended, 5 minutes):**
1. Sign up at [resend.com](https://resend.com), verify your domain (Resend
   shows the DKIM/SPF records to add at your DNS panel).
2. Create an API key, then on the VPS:
   ```bash
   cd /opt/staychat-os
   sed -i "s|^RESEND_API_KEY=.*|RESEND_API_KEY=re_yourkeyhere|" .env
   docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d
   ```
3. Test: sign up a hotel with your own email → welcome email arrives.

**Option B — SMTP** (your existing mail server): edit `.env` on the VPS:
`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`, then the
same `up -d` command.

---

## Step 9 — Automate plan payments (Super Admin only, optional)

1. Log in as the superadmin → **Super Admin → Billing & Approvals**.
2. Paste your gateway keys (stored AES-256-GCM encrypted; never shown back):
   Stripe (`sk_live_…` + `whsec_…`), Paystack, Flutterwave, OPay, or the
   shared settlement secret for Payoneer/Airtm/Crypto.
3. Register the webhooks the page shows, e.g.:
   `https://yourdomain.com/api/webhooks/platform/stripe`
   Subscriptions then activate automatically on payment.

---

## Step 10 — Day-2 operations (save this section)

```bash
ssh root@VPS_IP && cd /opt/staychat-os

# ── Updates ──────────────────────────────────────────────────────────────
# Preferred: git push origin master → CI → auto-deploy (Step 6).
# Manual / emergency, same safety chain as CI:
bash deploy/update.sh --pull          # git-based repo (Option B)
bash deploy/update.sh                 # rsync-uploaded repo (Option A)

# ── Status & logs ────────────────────────────────────────────────────────
docker ps                                    # both containers healthy?
docker logs -f staychat --tail 50            # app logs
docker logs -f caddy                         # HTTPS/cert logs
curl -s localhost:3000/api/health            # liveness
bash deploy/check-deployment.sh              # full post-deploy verification

# ── Backups (cron already installed; verify it works) ────────────────────
bash deploy/backup-db.sh                     # manual run → /opt/backups/*.db.gz
ls -1t /opt/backups | head                   # today's snapshot should be first
# Offsite copy (3-2-1) — push to another machine/object storage:
bash deploy/sync-backups-offsite.sh           # see the script's header for config

# ── Restore a backup ─────────────────────────────────────────────────────
docker compose --env-file .env -f deploy/docker-compose.prod.yml stop staychat
gunzip -c /opt/backups/staychat-YYYY-MM-DD-HHMM.db.gz | \
  docker run --rm -i -v staychat-os_staychat_data:/data alpine sh -c \
  'cat > /data/staychat.db'
docker compose --env-file .env -f deploy/docker-compose.prod.yml start staychat

# ── Config change ────────────────────────────────────────────────────────
nano .env     # e.g. RATE_LIMIT_GLOBAL_MAX if many staff share one office IP
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d
```

**Config knobs you may actually need** (all in `.env`; the full table is in
[OPERATIONS.md](OPERATIONS.md) §2):

| Variable | When to touch it |
|---|---|
| `CORS_ORIGIN` | set to `https://yourdomain.com` once live |
| `RATE_LIMIT_GLOBAL_MAX` | raise (e.g. 400) if many staff share one office IP |
| `BCRYPT_WORKERS` | login-storm protection; default `cpus-2` |
| `CHECK_DEMO_USERS=false` | already set by the prod compose — after you rotate demo passwords |
| `MAINTENANCE=1` | manual maintenance mode (set/lift via `update.sh`) |

---

## Troubleshooting (the only five things that go wrong)

| Symptom | Cause → fix |
|---|---|
| First visit hangs / cert error, `docker logs caddy` shows ACME errors | DNS A record missing or pointing elsewhere → `dig +short yourdomain` must return the VPS IP; then `docker restart caddy` |
| `curl` to the site times out | Provider firewall/security group → open **80, 443, 22**. On the VPS check: `ufw status` (setup installs ufw allowing exactly those) |
| Welcome emails never arrive | Expected until Step 8. Also: port 25 is often blocked on Contabo/Truehost → use Resend (port 443) |
| `update.sh` refuses: "< 1 GB free disk" | `docker system prune -af` (never prune volumes) and/or enlarge the disk; backups also auto-prune after 14 days |
| App crashed after you edited `.env` | A typo — server **refuses to boot without** `COOKIE_SECRET`/JWT secrets. `docker logs staychat --tail 50` names the missing var; restore from `.env.bak` if needed, `up -d` again |

Worst case, the recovery order is always the same: **the DB snapshots in
`/opt/backups` are never touched by any deploy or update** — stop the app,
restore the newest good snapshot (restore command above), `git checkout` the
last good ref, `up -d --build`.

---

## Where to go next

- [`SETUP.md`](SETUP.md) — condensed runbook + email/payment/WhatsApp detail
- [`OPERATIONS.md`](OPERATIONS.md) — measured capacity numbers, the update
  safety model, pm2 (no-Docker) path, scaling SQLite → PostgreSQL
- [`POST-DEPLOY-CHECKLIST.md`](POST-DEPLOY-CHECKLIST.md) — the go-live checklist
- `README.md` — product features, plans, booking engine, WhatsApp inbox
