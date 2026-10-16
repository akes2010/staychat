# 04 — APIs & Integrations (admin)

Everything connection-shaped that a hotel configures: AI providers, generic
API integrations, printers, and the developer API surface. All admin-only
(`settings.manage` / `ai.manage` / `printers.manage`).

---

## 1. AI Setup (🤖 AI Setup module)

Powers the **AI WhatsApp receptionist** — auto-answering guest messages in
the Inbox. StayChat is provider-agnostic: bring your own key.

**Supported providers:** OpenAI · Qwen · DeepSeek · Hugging Face ·
OpenRouter · Kimi · Z-ai · Other (any OpenAI-compatible endpoint)

Setup:
1. AI Setup → **+ Add configuration** → pick provider, model name, agent
   role.
2. Paste the provider **API key** — stored encrypted, shown masked
   (`sk-1••••••••ab90`) forever after; the full key is never redisplayed.
3. Activate the configuration.

Notes:
- This module is a *configuration surface* — it stores which provider/model/
  key powers each agent. Wiring it into the live Inbox conversation is the
  platform's job afterwards.
- Keys are AES-256-GCM encrypted per tenant; rotating the platform's
  encryption key would orphan them (platform-level operation, not your fault).
- Cost: AI usage is billed by *your provider account* directly; hotels on an
  AI add-on plan see it reflected in Billing & Plan.

---

## 2. API Integrations module (🔌 API Integrations)

The general-purpose drawer for **outbound credentials** the hotel wants the
platform to hold: SMS gateways, email relays, storage, analytics — anything
with an API key. Same encryption + masking rules as AI keys.

- **+ Add integration** → name, kind, credentials (key/secret JSON).
- **Test** button verifies the credential with a live ping where the provider
  supports it.
- Per-tenant isolation: integrations never cross hotel boundaries.

> What belongs here vs Settings? One-off provider credentials → API
> Integrations. Hotel behavior (WhatsApp, currency, branding) → Settings /
> the dedicated module for it.

---

## 3. Printers (🖨️ Printers module)

Three supported printer types:

| Type | Use | Typical device |
|---|---|---|
| `thermal_80` | POS receipts, settlement receipts | 80mm ESC/POS thermal printer |
| `thermal_58` | compact bar tickets | 58mm ESC/POS thermal printer |
| `a4` | folios, registration forms, invoices | any network/USB A4 printer via a print server |

Setup: **Printers → + Add printer** → name, type, department (routes which
module defaults to it), connection (network address / print-server URL), and
optionally **set as default** for its department.

**Test print** confirms reachability before the first guest uses it.
Settlement and POS flows auto-open the print dialog; a physical printer that
accepts ESC/POS over the network prints without the dialog.

---

## 4. The developer API surface (for your own integrations)

Every module is REST, JSON, session-cookie auth (`https://staychatos.com/api/…`).
The web app itself is just a client of this API — anything it does, your
integrations can too:

| Area | Endpoints (examples) |
|---|---|
| Rooms & setup | `/api/rooms`, `/api/room-setup` (floors, categories, rates) |
| Bookings | `/api/bookings` (+ `/checkin`, `/checkout`, transfer) |
| Guests | `/api/guests`, `/api/blocklist` |
| Public booking engine | `/api/booking-engine/config|availability|book?subdomain=…` — **no auth**, hotel resolved by subdomain |
| Payments | `/api/payments` (transactions, balance, settle, links, vouchers) |
| POS & menu | `/api/pos`, `/api/menu` |
| Accounting | `/api/accounting` (journal, ledger) |
| Ops | `/api/pool`, `/api/halls`, `/api/orders`, `/api/misc-services`, `/api/housekeeping`… via rooms/maintenance routes |
| Webhooks inbound | `/api/webhooks/whatsapp/<subdomain>`, `/api/webhooks/platform/*` |

Rules of the road:
- Authenticated calls need a logged-in session (the same JWT cookies the app
  uses) — automate by POSTing `/api/auth/login` and keeping the cookies.
- **Every write is idempotent-safe**: send an `Idempotency-Key` header on
  POST/PATCH and replays can't double-execute (this is how the offline
  front-desk sync stays exactly-once).
- Rate limits: global per-IP limiter applies (default 200 req/min); raise
  `RATE_LIMIT_GLOBAL_MAX` on the server if a busy office shares one IP.
- Tenant isolation is automatic: your session's hotel scopes every query —
  there is no cross-hotel access to request in the first place.

> The **public booking-engine API** is the intended channel for OTA-style
> automations: check availability and push reservations from a channel
> manager or your own website widget — see
> [09-ota-booking-engine.md](09-ota-booking-engine.md).

---

## Back → [README.md](README.md) · Next: [05-receptionist-front-desk.md](05-receptionist-front-desk.md)
