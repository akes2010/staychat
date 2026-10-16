# 05 — Configure (email · payments · WhatsApp · .env)

Everything optional but valuable. Do them in any order; the system runs
without all of them (email no-ops with a log line, payments fall back to
manual approval).

All config lives in **`/opt/staychat-os/.env`** on the VPS (chmod 600,
server-owned — no deploy ever overwrites it). After any edit:

```bash
cd /opt/staychat-os
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d
```

---

## 1. Email (Resend recommended, 5 minutes)

Without this, welcome/reset emails are logged and skipped — never an error.

**Option A — Resend (best deliverability, works around port-25 blocks):**

1. Sign up at resend.com → **Add Domain** → `staychatos.com`.
2. Resend shows DNS records → add them in Cloudflare (exact how-to in
   [03-dns-cloudflare.md §5](03-dns-cloudflare.md)) → wait for "Verified".
3. Create an **API key**, then on the VPS:

```bash
cd /opt/staychat-os
sed -i "s|^RESEND_API_KEY=.*|RESEND_API_KEY=re_yourkeyhere|" .env
docker compose --env-file .env -f deploy/docker-compose.prod.yml up -d
```

4. **Test:** open `https://staychatos.com/signup` and register a throwaway
   hotel with *your own email* → the welcome email should arrive in seconds.

**Option B — SMTP (your own mail server):** edit `.env`:

```
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_USER=you@staychatos.com
SMTP_PASS=app-password-here
SMTP_FROM=StayChat OS <support@staychatos.com>
```

then the same `up -d`. (Contabo/Truehost block outbound port 25 — SMTP on
port 587/465 usually works; if not, use Resend.)

---

## 2. Payment gateways (platform plan revenue)

Log in as **superadmin** → **Super Admin → Billing & Approvals → Gateways**.
Paste the keys you use (stored AES-256-GCM encrypted; the page never shows a
full key back):

| Gateway | Keys needed |
|---|---|
| Stripe | `sk_live_…` + webhook secret `whsec_…` |
| Paystack | `sk_live_…` |
| Flutterwave | `FLWSECK-…` + `verif-hash` webhook secret |
| OPay | merchant secret key |
| Payoneer / Airtm / Crypto | shared settlement webhook secret |

Then register the webhook at each gateway (URLs are listed on that same page):

| Gateway | Webhook URL |
|---|---|
| Stripe | `https://staychatos.com/api/webhooks/platform/stripe` |
| Paystack | `https://staychatos.com/api/webhooks/platform/paystack` |
| Flutterwave | `https://staychatos.com/api/webhooks/platform/flutterwave` |
| OPay | `https://staychatos.com/api/webhooks/platform/opay` |
| Payoneer/Airtm/Crypto | `https://staychatos.com/api/webhooks/platform/manual` |

Stripe/Paystack/Flutterwave/OPay run hosted checkout — subscriptions activate
**automatically** on payment. The others confirm via the settlement webhook or
the manual `SC-` approval flow (always available as fallback).

> Works through Cloudflare's proxy — webhooks are plain HTTPS POSTs.

---

## 3. WhatsApp (per hotel, optional)

Each hotel connects **its own** WhatsApp number:

1. Meta for Developers → create a Meta app → WhatsApp product → get
   **Phone Number ID** + **Access Token**.
2. In the hotel's StayChat: **Settings → WhatsApp** → paste Phone Number ID,
   Access Token and a verify token you invent → Save.
3. In Meta's console set the webhook URL:

```
https://staychatos.com/api/webhooks/whatsapp/<hotel-subdomain>
```

(`<hotel-subdomain>` is what the hotel chose at signup — shown on that same
settings card.) Meta sends verification challenges there; the verify token
from step 2 completes the handshake.

---

## 4. `.env` knobs you may actually need

Generated automatically at install — these are the ones you might *change*:

| Variable | When to touch it | Safe value |
|---|---|---|
| `RESEND_API_KEY` / `SMTP_*` | §1 above | — |
| `PLATFORM_GATEWAY` | default checkout gateway shown to hotels | `stripe` (default) |
| `RATE_LIMIT_GLOBAL_MAX` | many staff behind ONE office IP get rate-limited | `400`–`600` |
| `BCRYPT_WORKERS` | login-storm protection during morning rush | default `cpus-2`, max 6 |
| `SCHEDULER_INTERVAL_MINUTES` | renewal reminders + expiry sweeps cadence | `60` (default) |
| `MAINTENANCE=1` | manual maintenance mode (guests/staff see a clean 503) | lift via `bash deploy/update.sh --lift-maintenance` |

**Do not casually touch:** `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
`COOKIE_SECRET` (rotating logs **everyone** out), `CREDENTIALS_ENCRYPTION_KEY`
(**changing it makes all saved gateway credentials undecryptable** — there is
no recovery without a backup of the old key).

**CORS:** nothing to set. The app is served from the same origin
(`staychatos.com`) behind Caddy — the server defaults to same-origin-only,
which is exactly right.

---

## Checkpoint ✓

- [ ] Test signup at `https://staychatos.com/signup` — welcome email arrives
- [ ] (If payments) webhook registered and a test checkout activates a plan
- [ ] (If WhatsApp) Meta webhook verified, test message appears in the Inbox

---

## Next → [06-go-live-checklist.md](06-go-live-checklist.md)
