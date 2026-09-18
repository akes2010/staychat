# Deploying StayChat OS to your Contabo VPS

Target: **https://staychat.akmustech.com** · stack: Docker Compose (app + Caddy
with automatic HTTPS) · email: your `support@akmustech.com` · demo data seeded.

---

## 0. DNS (Contabo panel → DNS, or your domain's registrar)

Create/confirm one record:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `staychat` | `YOUR_VPS_IPV4` | 3600 |

Verify from your machine before continuing:

```bash
dig +short staychat.akmustech.com   # must return the VPS IP
```

## 1. Upload the repo to the VPS

From your local machine (this repo):

```bash
rsync -avz --exclude node_modules --exclude data --exclude .env \
  ~/Downloads/staychat-os/ root@YOUR_VPS_IP:/opt/staychat-os/
```

(Or `git clone` your repo into `/opt/staychat-os` if you've pushed it.)

## 2. One-shot setup on the VPS

```bash
ssh root@YOUR_VPS_IP
cd /opt/staychat-os
bash deploy/setup-vps.sh
```

The script installs Docker, generates all secrets into `/opt/staychat-os/.env`
(chmod 600), opens ports 80/443, builds the image, seeds the demo database,
starts the stack and waits for health.

First visit to `https://staychat.akmustech.com` triggers automatic Let's
Encrypt certificate issuance (takes ~1 minute). Logs: `docker logs -f caddy`.

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
   docker compose -f deploy/docker-compose.prod.yml up -d
   ```
3. Test: sign up a hotel at `https://staychat.akmustech.com/signup` with your
   own email — you should receive the welcome email.

**Option B — SMTP (your existing mail server):**
```bash
cd /opt/staychat-os
# edit .env: SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM
nano .env
docker compose -f deploy/docker-compose.prod.yml up -d
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

## 7. Maintenance

```bash
cd /opt/staychat-os

# Deploy new code (after git pull or rsync)
docker compose -f deploy/docker-compose.prod.yml up -d --build

# Logs
docker compose -f deploy/docker-compose.prod.yml logs -f staychat
docker compose -f deploy/docker-compose.prod.yml logs -f caddy

# Backup the database (installed automatically as a daily 03:17 cron by
# setup-vps.sh; keeps 14 days in /opt/backups). Manual run:
deploy/backup-db.sh

# Restore a backup
docker compose -f deploy/docker-compose.prod.yml stop staychat
docker volume run --rm -i -v staychat-os_staychat_data:/data alpine sh -c \
  'cat > /data/staychat.db' < backup-YYYY-MM-DD.db
docker compose -f deploy/docker-compose.prod.yml start staychat
```

**Wipe demo data before real customers** (careful — irreversible):

```bash
docker compose -f deploy/docker-compose.prod.yml stop staychat
docker volume rm staychat-os_staychat_data
docker compose -f deploy/docker-compose.prod.yml up -d
# Then sign up fresh at /signup — the superadmin login can also be created
# by re-seeding: docker exec staychat node server/db/seed.js
```

## 8. What runs where

| Piece | Where |
|---|---|
| App (Express + SQLite + WebSocket) | `staychat` container, internal `:3000` |
| HTTPS + reverse proxy + auto certs | `caddy` container, ports 80/443 |
| Database | volume `staychat_data` → `/app/data/staychat.db` |
| Renewal reminders + expiry sweeps | inside the app, hourly scheduler |
| Emails | Resend/SMTP via `server/services/email.js` |
| Gateway auto-approvals | signed webhooks under `/api/webhooks/platform/*` |
