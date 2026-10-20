# StayChat OS — WhatsApp-Native Hotel Management SaaS

A real, deployable, multi-tenant hotel management **SaaS**. Express + SQLite backend,
JWT auth with httpOnly cookies, WebSocket real-time updates, and a vanilla-JS frontend
(no build step). WhatsApp Business Cloud API webhook included and ready to connect.

## It sells itself

The platform is a complete SaaS + PWA out of the box:

- **Self-service signup & trials** — `/signup.html` creates the hotel workspace, starts a
  30-day full-feature trial of the chosen plan and (non-blockingly) records a plan request
  with a payment reference (`SC-XXXXXXXX`).
- **Real entitlement gating** — every plan has a feature list and usage limits
  (`server/services/entitlements.js`). Guarded routes answer `402 UPGRADE_REQUIRED` with a
  machine-readable body; the SPA opens an upgrade modal automatically. Rooms and staff
  seats are hard-capped per plan (402 `PLAN_LIMIT_REACHED`).
- **Billing that closes the loop** — hotels pick a plan in-app (Billing & Plan), get a
  payment reference, the platform operator approves payment in Super Admin → the tenant
  goes live instantly (plan, period, MRR and legacy columns all synced). Expired trials
  are swept to `suspended` at boot and on demand.
- **The site is the salesperson** — the landing page renders live pricing from the same
  catalog (monthly/yearly toggle), an OTA-commission savings calculator, and a chat
  assistant trained on the platform's real feature set (including PWA and billing topics).
- **Installable PWA** — manifest with maskable icons + app shortcuts, offline-first
  service worker (stale-while-revalidate shell, network-first API with cached fallback),
  install prompts with iOS fallback instructions, and logout cache-wipe for shared
  front-desk tablets. Icons are generated, not binary: `node scripts/generate-icons.js`.
- **Offline-first writes** — the desk keeps working with no connection: new reservations,
  guest registration, check-in, check-out and settle are queued in IndexedDB
  (`public/js/offline.js`) behind a live badge + review ledger, then auto-sync in order
  the moment the network returns (online event, 30s retry, tab-visible, Background Sync).
  Every replay carries an `Idempotency-Key` the server executes exactly once
  (`server/middleware/idempotency.js`), so a reconnect can never double-book a room or
  double-charge a guest; anything the server rejects on sync (e.g. the room was sold
  meanwhile) is flagged for staff review instead of retried. Proven by
  `scripts/test-idempotency.js` (23 checks) + `scripts/browser-test-offline-sync.js` (19 checks).

### Plans

| | Starter $29/mo | Pro $79/mo | Enterprise $199/mo |
|---|---|---|---|
| Rooms | 20 | 100 | Unlimited |
| Staff logins | 5 | 25 | Unlimited |
| Booking engine, AI receptionist, POS, front desk | ✓ | ✓ | ✓ |
| Guest Wi-Fi, accounting, EOD, pool/halls, shifts, integrations | — | ✓ | ✓ |
| Multi-property, custom integrations, dedicated onboarding | — | — | ✓ |

Yearly billing saves 2 months. Trial runs on the full requested plan.

### Payment & approval flow

**Automated (recommended):** configure the platform's own card gateway once, under
Super Admin → *Billing & Approvals*. Keys are stored encrypted at rest and never
returned in full by the API. From then on:

1. Hotel requests a plan (signup, Billing & Plan, or the upgrade modal) → the API
   creates a hosted-checkout session and the UI redirects straight to Stripe/Paystack.
2. The guest pays on the gateway's page; the gateway calls the platform webhook:
   - Stripe: `POST /api/webhooks/platform/stripe` (signature-verified,
     `checkout.session.completed`, 5-minute replay window)
   - Paystack: `POST /api/webhooks/platform/paystack` (HMAC-SHA512 signature-verified)
3. The webhook auto-activates the subscription — tenant goes live on the plan for the
   period with **no manual step**. Replayed webhooks are no-ops (idempotent), and an
   event whose amount is below the subscription total is logged for operator review
   instead of activating anything.
4. Everything is audit-logged in `billing_events` (approved by `auto:stripe` / `auto:paystack`).

**Manual (bank transfer / POS, always available as fallback):**

1. Hotel requests a plan → unique `SC-` reference issued (also shown at `/pay?ref=SC-…`).
2. Hotel pays by bank transfer/POS and quotes the reference.
3. Operator opens Super Admin → *Billing & Approvals*, sees the pending request,
   approves with the gateway ref → tenant is active on the plan for the period.

If no gateway is configured — or the gateway is down — checkout creation degrades
gracefully to the manual `SC-` reference flow, so a gateway outage can never prevent
a hotel from requesting a plan.

### Platform billing credentials (superadmin-only)

- `GET /api/superadmin/platform-billing` — masked view + webhook URLs
- `PUT /api/superadmin/platform-billing` — set/clear `stripe_secret_key`,
  `stripe_webhook_secret`, `paystack_secret_key` (encrypted at rest, AES-256-GCM)

Every plan/tenant management surface (`/api/plans`, `/api/superadmin/*`) requires the
`superadmin` role; hotel admins cannot read gateway state, approve payments, or change
plans/status/MRR from tenant settings (strict column whitelist).

## What's real here

- **Real database** — SQLite file on disk (`data/staychat.db`), not localStorage. Survives restarts, backs up with a single file copy. Swappable for PostgreSQL later (see "Scaling up").
- **Real auth** — bcrypt password hashing, JWT access tokens (15 min) in httpOnly cookies, rotating refresh tokens (30 days) stored hashed in the DB, rate-limited login.
- **Real multi-tenancy** — every table has `tenant_id`; middleware (`server/middleware/auth.js`) enforces that non-superadmin users can only ever read/write their own tenant's rows, regardless of what a request body claims.
- **Real-time** — a WebSocket server pushes room/order/message/maintenance updates to every connected client for that tenant, so two staff members looking at the dashboard see the same state instantly.
- **Real WhatsApp integration point** — `server/routes/webhooks.js` implements the actual Meta WhatsApp Business Cloud API webhook contract (verification handshake + signed message events) and a `sendWhatsAppMessage()` helper. Plug in real credentials in Settings and it works with a live WhatsApp number.
- **Real payment webhook** — Paystack webhook handler with HMAC signature verification included; Stripe/Flutterwave follow the same pattern.
- **Audit log** — every write action is recorded with user, tenant, IP, and a JSON diff.

## What's real here (AI)

- The **AI Receptionist** (`server/ai/receptionist.js`) now makes **real LLM calls**:
  1. A hotel can plug in its own provider under Settings → AI (OpenAI, Anthropic,
     Qwen, DeepSeek, OpenRouter, Kimi, Z.ai — key stored per-tenant, used only for
     that tenant's guests).
  2. Otherwise platform keys from the environment are used (`ANTHROPIC_API_KEY`,
     `OPENAI_API_KEY`, or `OPENROUTER_API_KEY`).
  3. With no keys at all (or on any API error/network failure), it falls back to the
     built-in offline keyword replies — the product never breaks without credentials.
- The LLM is hotel-branded and constrained to hospitality topics; booking-code
  (`BE-…`) lookups stay deterministic (they read the DB, not the model) and remain
  strictly tenant-scoped.
- Outbound LLM calls are hardened: IPv4-pinned `node:https` (avoids the Happy-Eyeballs
  ETIMEDOUT failure mode on some hosts), 10s connect / 30s total timeout, and the
  WhatsApp webhook always 200s first so a slow model can never delay Meta's retries.

## What's still a stand-in (by design, clearly marked in code)

- **Email** isn't wired up (no transactional email provider configured) — `tempPassword` values are currently returned directly in API responses/toasts for demo convenience. Wire up an email provider before going live so passwords aren't shown in the UI.

---

## Quick Start (local machine)

Requires Node.js 18+.

```bash
cd staychat-os
npm install
npm run seed      # creates the DB file and loads demo data
npm run check     # verifies demo users/data actually landed in the DB
npm start         # http://localhost:3000
```

Demo logins (password `Demo@123456` for all — override at seed time with the `DEMO_PASSWORD` env var — or click "Demo Access" on the login screen):

| Role | Email |
|---|---|
| Super Admin | `superadmin@staychat.io` |
| Hotel Admin | `admin@hospitally.com` |
| Receptionist | `reception@hospitally.com` |
| Housekeeping Staff | `felix@hospitally.com` |
| Cashier | `cashier@hospitally.com` |
| Barman | `barman@hospitally.com` |
| Accountant | `accountant@hospitally.com` |
| Auditor | `auditor@hospitally.com` |

For local development with auto-restart on file changes:
```bash
npm run dev
```

---## Deploy it for real

> **New to this?** [`install-guide/`](install-guide/) is a complete,
> beginner-level, copy-paste tutorial (prerequisites → DNS on Cloudflare →
> install → email/payments/WhatsApp → auto-deploy → day-2 operations →
> troubleshooting) that takes a fresh VPS to a live HTTPS system in ~2 hours.
>
> **Operating a hotel on it?** [`tenant-manual/`](tenant-manual/) is the full
> tenant & user manual — property setup, WhatsApp/Meta connection, APIs, and
> per-role guides (admin, receptionist, housekeeping, maintenance, restaurant/
> bar POS, accountant, auditor, OTA booking channel).

### Option A′ — Ready-made VPS kit (Contabo / any Ubuntu VPS, with a domain)`deploy/` contains a complete production stack: app + **Caddy (automatic
HTTPS)** compose file, a one-shot `setup-vps.sh` (installs Docker, generates
all secrets, opens the firewall, builds, seeds, starts, waits for health) and
a step-by-step runbook for email, gateway webhooks, WhatsApp, backups and
demo-data wipe. Start at **`deploy/SETUP.md`** (or the guided version:
[`install-guide/`](install-guide/)).
Server sizing (how much CPU/RAM 500–1000 concurrent staff need, measured) and
the GitHub→production update pipeline that can never touch tenant data live in
**`deploy/OPERATIONS.md`**.

### Option A — Docker (any VPS, DigitalOcean, Hetzner, AWS Lightsail, etc.)

```bash
git clone <your-repo> staychat-os && cd staychat-os
cp .env.example .env
# Edit .env — set strong JWT_ACCESS_SECRET / JWT_REFRESH_SECRET
docker compose up -d --build
docker compose exec staychat node server/db/seed.js   # first run only
```
The app is now on port 3000. Put Caddy or Nginx in front for HTTPS, or use Docker
with a reverse proxy like Traefik/Caddy for automatic TLS certificates.

### Option B — Render.com / Railway.app (zero-config PaaS)

1. Push this folder to a GitHub repo.
2. Create a new **Web Service**, connect the repo.
3. Build command: `npm install` — Start command: `node server/db/migrate.js && node server/db/seed.js && node server/db/check.js && npm start`
   The check step fails the deploy on a bad seed (missing demo users, rotated passwords) instead of serving 401s later. Set `CHECK_DEMO_USERS=false` to verify only the core schema — for hardened deployments where demo accounts were removed.
4. Add environment variables: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `NODE_ENV=production`.
5. **Important:** attach a persistent disk (Render: "Disks" tab) mounted at `/app/data` (or wherever `DATA_DIR` points) — otherwise the SQLite file resets on every deploy.

### Option C — Fly.io

```bash
fly launch                  # detects the Dockerfile automatically
fly volumes create staychat_data --size 1
# Edit fly.toml to mount the volume at /app/data
fly secrets set JWT_ACCESS_SECRET=$(openssl rand -hex 32) JWT_REFRESH_SECRET=$(openssl rand -hex 32)
fly deploy
```

### Option D — A plain VPS without Docker

```bash
sudo apt install nodejs npm nginx
git clone <repo> && cd staychat-os
npm install --omit=dev
cp .env.example .env   # fill in secrets
npm run seed
npm run check          # fails fast on a bad seed — fix before starting pm2
npm install -g pm2
pm2 start server/index.js --name staychat
pm2 save && pm2 startup
```
Then reverse-proxy Nginx → `localhost:3000` and run `certbot --nginx` for free HTTPS.

---

## Connecting a real WhatsApp number

1. Create a Meta Business + WhatsApp Business app at [developers.facebook.com](https://developers.facebook.com).
2. Get a **Phone Number ID** and a permanent **Access Token**.
3. In StayChat OS → Settings, paste the Phone Number ID, Access Token, and choose any
   string as your **Webhook Verify Token**.
4. In Meta's Developer Console → WhatsApp → Configuration, set the webhook callback URL to:
   ```
   https://yourdomain.com/api/webhooks/whatsapp/<your-hotel-subdomain>
   ```
   (subdomain is set when the hotel is onboarded — visible in Settings).
5. Use the same Verify Token you entered in step 3.
6. Send a message to your WhatsApp number from any phone — it will appear in the Inbox in real time, and the AI Receptionist will reply automatically (or escalate to staff if you've turned AI off).

## Connecting real payments

Paystack: Settings → paste your Public + Secret key. In Paystack's dashboard, set the
webhook URL to `https://yourdomain.com/api/webhooks/paystack/<subdomain>`. Stripe and
Flutterwave follow the same shape — see `server/routes/webhooks.js` for the Paystack
example to copy.

## Hardware & platform integrations

Beyond payments and messaging, the **API Integrations** page supports four more
categories — credentials are entered per-hotel, stored encrypted-at-rest, and can be
connection-tested from the same page:

- **Door locks** 🚪 — code guest doors on check-in (PIN / mobile key for the stay
  window), auto-expire on checkout:
  **Seam** (universal API for Yale/Schlage/August/2N…), **ASSA ABLOY Global
  Solutions (VingCard)**, **SALTO Systems**, **TTLock**, **ZKTeco**, **Onity
  DirectKey**, **dormakaba**, **RemoteLock**.
- **IPTV & VOD** 📺 — branded welcome page, VOD library, folio view and room-service
  ordering on the in-room TV:
  **mwareTV**, **HotelTV / VOD Server**, **AlphaOTT**, **VITEC (EZ-Runner / EZ
  Room)**, **Samsung LYNK Cloud**, **LG Pro:Centric Direct**.
- **Internet management** 📶 — per-room guest Wi-Fi with speed tiers by booking,
  voucher/quota control, captive-portal room binding:
  **Ubiquiti UniFi**, **Cisco Meraki**, **MikroTik RouterOS (REST)**, **TP-Link
  Omada**, **Ruckus**.
- **Room automation** 🏠 — check-in welcome scene (lights 60%, TV on, curtains), DND
  from the guest's phone, checkout eco-reset:
  **Control4**, **Crestron Home**, **KNX (IP gateway)**, **Lutron**, **Philips Hue**,
  **Sonos**.
- **Zigbee / IoT & Cameras** 📡 — low-power room sensors and video:
  **Zigbee Gateway (Zigbee2MQTT)**, **Hikvision (ISAPI)**, **Dahua (HTTP API)**,
  **IoT Platform (generic MQTT/HTTP)** for ThingsBoard / AWS IoT / Azure IoT or a
  property's own broker.

## Own booking engine (public channel)

StayChat OS ships its own OTA-style booking channel — the hotel's direct
booking page, synchronized with the same reservation system the front desk
uses:

1. **Enable it** in Settings → *Booking Engine (public)*, optionally with a
   guest-facing notice and a daily submission cap. The page lives at
   `/book.html?hotel=<subdomain>` (link is shown right on the settings card).
2. **The guest** picks dates, sees live availability priced from the same
   rate card the desk uses, and submits name + phone. No payment is taken
   online — they "reserve now, pay at the hotel".
3. **The system** creates a `pending_payment` booking with `source=engine` and
   a short tender code (e.g. `BE-7K2M9QX4`). Pending submissions do **not**
   block room inventory, and each hotel has a daily submission cap.
4. **The guest is notified on WhatsApp** the moment they submit (reference,
   tender code, dates, total) — and again when the desk confirms or rejects.
   Sends are fire-and-forget: hotels without WhatsApp credentials skip them
   silently, and a Meta API outage can never delay or fail a booking.
5. **The front desk** sees the submission under Bookings → *Pending* (the tab
   auto-opens when new ones arrive) with the code displayed prominently, and
   either **Confirms** (room is now held — availability is re-validated at
   that moment inside the write transaction) or **Rejects** it. The guest
   presents the code at the desk; from there the normal
   check-in → payment → checkout lifecycle applies.
6. **The front desk gets a WhatsApp heads-up** for every submission and every
   confirm/reject decision — sent to all active staff with `bookings.manage`
   and a phone number (per-user permission overrides honored).
7. **Printable confirmation**: guests (or the desk) open
   `/confirmation.html?hotel=<subdomain>` and look up a booking by tender code
   or reference + phone — a print-optimized slip with the code, dates, rooms,
   total, and a **QR code** that re-opens the confirmation on any phone.
   The QR is generated locally (`GET /api/booking-engine/qr`), never through a
   third-party image service. The desk also gets a 🖨 Slip button on every
   online booking.
8. **The AI receptionist knows booking codes**: a guest who messages the
   hotel's WhatsApp with their tender code (`BE-…`, dash optional) gets their
   live booking status — awaiting confirmation, confirmed, checked in,
   completed, or cancelled — with rooms, dates, and total. Lookups are
   tenant-scoped, so one hotel's guests can never read another hotel's
   bookings.
9. **Analytics → Booking Engine — Direct Channel** (and the dedicated
   **Booking Engine** dashboard page) tracks the funnel: submissions,
   confirmations, rejection count, confirmation rate over decided bookings,
   confirmed revenue, average booking value, and a 14-day submission chart.

Admin endpoints: `GET/PUT /api/booking-engine/admin/config`. Public endpoints
(rate-limited, no auth): `/api/booking-engine/hotels`, `/config`,
`/availability`, `/book`.

Cloud services (Seam, TTLock, Meraki, Sonos, Samsung LYNK…) get a live, read-only
credential probe — **Test Connection** actually authenticates against the provider.
Self-hosted/on-prem gear (ZKTeco controllers, SALTO Space, UniFi, KNX gateways…)
get a TCP reachability probe; their credentials are validated on first real use.
Service definitions live in `server/config/api-services.js`, probes in
`server/utils/service-tests.js` — adding a vendor is one entry in each file.

## Guest Wi-Fi per booking

Wi-Fi is provisioned automatically when a booking is **checked in**, tiered by
room type (suites 100↓/50↑, deluxe 50↓/20↑, standard 20↓/10↑ with a 50GB cap —
see `TIERS` in `server/services/wifi.js`), and **revoked automatically on
checkout**. One active session per booking; the credentials are encrypted at
rest (AES-256-GCM) and never displayed in lists.

- **Configure a controller** under API Integrations → Internet Management
  (UniFi, MikroTik, Meraki, Omada, Ruckus). UniFi and MikroTik get real pushes
  (guest authorization / hotspot user); the others record the session locally
  and tell you what to create in their dashboard.
- **Staff page**: Dashboard → Guest Wi-Fi — list, filter, credentials card
  (printable), extend for late stays, revoke on early departure.
- **Guest self-service**: `/wifi.html` — room number + booking reference from
  the key sleeve returns credentials for live stays only.
- **API**: `POST /api/wifi` {bookingId}, `GET /api/wifi?status=active`,
  `GET /api/wifi/:id`, `POST /api/wifi/:id/extend`, `POST /api/wifi/:id/revoke`,
  `GET /api/wifi/my?room=&reference=`.
- Check-in responses include a `wifi` object; if a controller push fails
  (device offline) the session still exists locally and the error surfaces on
  the integrations page — provisioning never blocks a check-in.

---

## Load testing (multi-tenant capacity)

`scripts/load-test.js` proves the server holds up with hundreds of concurrent staff
across multiple tenants — it seeds an ISOLATED database (never your dev/prod data),
spawns virtual users that each hold a real WebSocket plus a realistic API loop
(page navigations, interactions, maintenance writes that fan out over WS), and
reports latency percentiles, server CPU/RSS, WS rejections and any cross-tenant
broadcast leakage (which must always be 0):

```bash
node scripts/load-test.js setup --tenants 200 --users 1000   # seed isolated DB (platform scale)
DATA_DIR=./data/loadtest PORT=3100 NODE_ENV=production node server/index.js   # run server against it
node scripts/load-test.js run --users 1000 --duration 45      # 1000 concurrent users
node scripts/load-test.js run --users 1000 --only-tenant lt_tenant_0   # one hotel, 1000 users
node scripts/load-test.js logins --users 300                  # bcrypt login-burst probe
node scripts/load-test.js cleanup
```

Reference results (Node 22, single process, SQLite/WAL, production mode, 1000
concurrent staff on one laptop-class core that boosts to 4.8 GHz):

| Profile | Throughput | Latency | Errors | CPU (one core) | RSS |
|---|---|---|---|---|---|
| **200 tenants / 1000 users** | 827 req/s | p50 7ms · p95 41ms | 0 (all 200s), 0 WS drops, 0 cross-tenant leaks | avg 89% | peak 211MB |
| 5 tenants / 1000 users | ≈840 req/s | p50 4ms · p95 19ms | 0 | ≈75% | ≈240MB |

Tenant count is nearly free: 200 hotels vs 5 costs ~+15% CPU, ~+22ms p95 —
concurrency is the driver, not the number of properties. The `logins` phase
confirms a 300-account simultaneous login burst keeps the rest of the API at
canary p95 ≈ 7ms (bcrypt runs in worker threads, event loop never freezes).

---

## Scaling up: SQLite → PostgreSQL

SQLite comfortably handles a single hotel or a handful of hotels on one server. For a
larger multi-tenant SaaS with hundreds of hotels or need for read replicas:

1. Swap `server/db/connection.js` for a `pg` Pool.
2. `server/db/migrate.js` SQL is 95% standard SQL — the only SQLite-specific bits are
   `datetime('now')` (→ `NOW()`) and the `CHECK(...)` inline constraints (Postgres
   supports these natively too, no change needed).
3. Add Postgres Row-Level Security policies keyed on `tenant_id` for defense-in-depth
   on top of the application-layer tenant isolation already in `middleware/auth.js`.
4. Everything else (routes, frontend) is unchanged — `better-sqlite3`'s synchronous
   `.prepare().run()/.get()/.all()` API would need to become `await pool.query(...)`,
   which is a mechanical find-and-replace across the route files.

## Project structure

```
staychat-os/
├── server/
│   ├── index.js              # Express app entry point
│   ├── ws.js                  # WebSocket real-time broadcast
│   ├── ai/receptionist.js     # AI auto-reply engine (swap for Claude API here)
│   ├── db/
│   │   ├── connection.js      # SQLite connection
│   │   ├── migrate.js         # Schema (idempotent)
│   │   └── seed.js            # Demo data
│   ├── middleware/auth.js     # JWT verification + tenant isolation + audit log
│   ├── routes/                # One file per resource — all REST, all tenant-scoped
│   └── utils/tokens.js        # JWT signing/verification helpers
├── public/
│   ├── index.html
│   ├── manifest.json          # PWA manifest
│   ├── css/app.css
│   └── js/
│       ├── api.js             # fetch wrapper with auto token refresh
│       ├── ws-client.js        # WebSocket client with reconnect
│       ├── ui.js               # toast/modal/badge helpers
│       ├── auth.js
│       ├── app.js              # navigation + sidebar + boot
│       └── pages/*.js          # one module per screen
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## Security notes for production

- Change `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` to long random values — never use the defaults.
- Put this behind HTTPS always (cookies are `secure` in production mode, so they won't even be sent over plain HTTP).
- The `data/` directory contains your entire database — back it up regularly (`cp data/staychat.db backups/$(date +%F).db` in a cron job is enough for SQLite).
- Rotate the Meta WhatsApp access token before it expires (permanent tokens via a System User don't expire; temporary ones do).
- Review `server/middleware/auth.js` — `resolveTenant()` is the single chokepoint that prevents tenant data leakage; if you add new routes, always mount them behind `requireAuth, resolveTenant, requireTenant`.
