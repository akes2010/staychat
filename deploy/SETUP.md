# Deploying StayChat OS to any VPS

Target: your own domain (default **https://staychat.akmustech.com**) · stack:
Docker Compose (app + Caddy with automatic HTTPS) · works on **any provider
where you get a root VPS**: Contabo, DigitalOcean, GCP, Hetzner, Hostinger KVM,
AWS Lightsail, Vultr, Linode. Only requirements: root SSH, Ubuntu/Debian,
ports 80/443 reachable, and an A record pointing your domain at the VPS IP.

---

## 0. Buy + point DNS (provider panel → DNS, or your domain's registrar)

1. Create any root VPS (Ubuntu 24.04, smallest plan is fine to start).
   - Contabo / DigitalOcean / Hetzner / Hostinger KVM: plain Ubuntu image.
   - GCP: an `e2-small` VM with Ubuntu 22.04/24.04 and HTTP+HTTPS firewall rules.
2. Create/confirm one DNS record:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `staychat` (or `@`/your subdomain) | `YOUR_VPS_IPV4` | 3600 |

Verify from your machine before continuing:

```bash
dig +short staychat.akmustech.com   # must return the VPS IP
```

## 1. Deploy — one command from your laptop

From this repo:

```bash
REMOTE=root@YOUR_VPS_IP DOMAIN=staychat.akmustech.com deploy/deploy.sh
```

That single command uploads the code, installs Docker, generates secrets,
opens the firewall, builds, starts, seeds demo data and waits for health.
Re-running it later safely redeploys new code (it backs up the DB first).

Prefer doing it manually?

```bash
rsync -avz --exclude node_modules --exclude data --exclude .env \
  ~/Downloads/staychat-os/ root@YOUR_VPS_IP:/opt/staychat-os/
ssh root@YOUR_VPS_IP
cd /opt/staychat-os && DOMAIN=staychat.akmustech.com bash deploy/setup-vps.sh
```

(Or `git clone` your repo into `/opt/staychat-os` if you've pushed it.)

## 2. First visit

Open `https://<your-domain>` — automatic Let's Encrypt certificate issuance
(takes ~1 minute). Logs: `docker logs -f caddy`.

## 3. Log in

| Role | Email | Password |
|---|---|---|
| Super Admin | `superadmin@staychat.io` | `Demo@123456` |
| Hotel Admin | `admin@hospitally.com` | `Demo@123456` |

**Change these right away** (Users → pick user → reset password), or when
you're ready for real customers, wipe demo data — see §7.

## 4. Turn on email (support@akmustech.com)

The email service supports **Resend (recommended)** or **any SMTP**. Both
options are already wired — you only set credentials.

**Option A — Resend (5 minutes, best deliverability):**
1. Sign up at https://resend.com → verify your domain `akmustech.com`
   (Resend shows the DKIM/SPF records to add at your DNS provider).
2. Create an API key → then on the VPS:
   ```bash
   cd /opt/staychat-os
   sed -i "s|^RESEND_API_KEY=.*|RESEND_API_KEY=re_yourkeyhere|" .env
   docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d
   ```
3. Test: sign up a hotel at `https://staychat.akmustech.com/signup` with your
   own email — you should receive the welcome email.

**Option B — SMTP (your existing mail server):**
```bash
cd /opt/staychat-os
# edit .env: SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM
nano .env
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d
```
`SMTP_FROM` is already preset to `StayChat OS <support@akmustech.com>`.

With neither configured, email stays in no-op mode (logged, never an error).

## 5. Automate plan payments (Super Admin only)

1. Log in as `superadmin@staychat.io` → **Super Admin → Billing & Approvals**.
2. Paste your **Stripe secret key** (`sk_live_…`, plus the `whsec_…` webhook
   secret) or **Paystack secret key** → Save.
3. Register the webhook with the gateway (URLs are displayed on that page):
   - Stripe: `https://staychat.akmustech.com/api/webhooks/platform/stripe`
     (event: `checkout.session.completed`)
   - Paystack: `https://staychat.akmustech.com/api/webhooks/platform/paystack`
4. From then on, hotels pay via hosted checkout and their subscription
   activates **automatically**. Manual `SC-` approvals still work as fallback.

## 6. Connect WhatsApp (optional, per hotel)

Settings → WhatsApp: paste Phone Number ID + Access Token + a verify token,
then in Meta's console point the webhook at:
`https://staychat.akmustech.com/api/webhooks/whatsapp/<hotel-subdomain>`

### Contabo / Truehost quick reference

Both providers follow the exact same path:

| Step | Contabo | Truehost |
|---|---|---|
| Image | Ubuntu 24.04, any plan (Cloud VPS 1 is plenty) | Ubuntu 24.04 KVM plan |
| SSH | `ssh root@VPS_IP` (password arrives by email → set your key) | `ssh root@VPS_IP` from the Truehost client panel |
| DNS | Domain panel → add an **A record** → VPS IPv4 | Client Area → DNS Zone → **A record** → VPS IPv4 |
| Firewall | open 22/80/443 (ufw is configured by setup-vps.sh) | check the panel's firewall allows 22/80/443 |
| Deploy | `REMOTE=root@VPS_IP DOMAIN=yourdomain.com deploy/deploy.sh` | same one-liner |

One caveat for both: **email port 25 is often blocked by default on new VPSs.**
That's fine — the app uses Resend/SMTP APIs over 443, which are never blocked.

## 7. Maintenance

```bash
cd /opt/staychat-os

# Deploy new code (after git pull or rsync)
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build

# CERTIFIED-SAFE UPDATE — backs up the DB first, dress-rehearses migrations on
# a COPY of your data before the live container changes, verifies health, and
# auto-rolls back (previous image + code + DB) if anything fails. Customer
# data and .env secrets are never touched.
bash deploy/update.sh                # code already uploaded (default)
bash deploy/update.sh --pull         # repo is a git checkout — pull latest first
bash deploy/update.sh --set-maintenance   # keep maintenance mode on after

# MAINTENANCE MODE (manual, no code/data changes)
bash deploy/update.sh --lift-maintenance   # take the app back to full service
# (update.sh sets/lifts it automatically; only touch it by hand after a
#  manual intervention)

# Logs
docker compose --env-file .env -f deploy/docker-compose.prod.yml logs -f staychat
docker compose --env-file .env -f deploy/docker-compose.prod.yml logs -f caddy

# Backup the database (installed automatically as a daily 03:17 cron by
# setup-vps.sh; keeps 14 days in /opt/backups). Manual run:
deploy/backup-db.sh

# Restore a backup
docker compose --env-file .env -f deploy/docker-compose.prod.yml stop staychat
docker volume run --rm -i -v staychat-os_staychat_data:/data alpine sh -c \
  'cat > /data/staychat.db' < backup-YYYY-MM-DD.db
docker compose --env-file .env -f deploy/docker-compose.prod.yml start staychat
```

3. Config change: edit `.env`, then (same as deploy)
   `docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d --build`

**Wipe demo data before going live with real hotels** (one command, keeps the
superadmin login, secrets and platform settings — a fresh backup is taken first):

```bash
bash deploy/wipe-demo.sh          # prompts: type WIPE; add --force to skip
```

After the wipe, sign up real hotels at `https://<your-domain>/signup`.

## 8. What runs where

| Piece | Where |
|---|---|
| App (Express + SQLite + WebSocket) | `staychat` container, internal `:3000` |
| HTTPS + reverse proxy + auto certs | `caddy` container, ports 80/443 |
| Database | volume `staychat_data` → `/app/data/staychat.db` |
| Renewal reminders + expiry sweeps | inside the app, hourly scheduler |
| Emails | Resend/SMTP via `server/services/email.js` |
| Gateway auto-approvals | signed webhooks under `/api/webhooks/platform/*` |
