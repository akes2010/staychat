# 03 — WhatsApp Setup (Meta Cloud API)

Connect the hotel's real WhatsApp number so guests can message the hotel and
see it all in the **WhatsApp Inbox**. Do this as `hotel_admin`
(Settings module, admin only). ~20 minutes if you already have a Meta
account; longer the first time (Meta business verification can take days).

---

## What you'll get

- Guests message the hotel's official WhatsApp number → lands in the
  **WhatsApp Inbox**, answerable by reception/any role with `inbox.use`
- Webhook path is **per hotel**: `https://staychatos.com/api/webhooks/whatsapp/<your-subdomain>`
  (e.g. `…/whatsapp/grandpalace`) — tenants can never read each other's
  messages
- A built-in **connection test** that verifies both halves (outgoing API +
  incoming webhook, including Meta's signature check) before you go live

---

## 1. Meta prerequisites

1. A **Meta account** (personal is fine) and a
   [business.facebook.com](https://business.facebook.com) **Business
   Manager** for the hotel (free).
2. A real phone number that can receive calls/SMS — it becomes the hotel's
   WhatsApp Business number. It must **not** already be active on WhatsApp
   Consumer (transfer it out first if it is).
3. A Meta **app** with the WhatsApp product. Free tier: 1,000 service
   conversations/month; marketing/template conversations are billed by Meta.

---

## 2. Create the app + WhatsApp product

1. [developers.facebook.com](https://developers.facebook.com) → **My Apps →
   Create App** → type **Business** → name it (e.g. `Grand Palace WhatsApp`) →
   Create.
2. Add the **WhatsApp** product to the app.
3. In the WhatsApp pane you now have a **test number** (Meta's sandbox) —
   useful for the whole setup: you can finish everything below with it, then
   attach the hotel's real number in step 6.

---

## 3. Collect the five values

From the WhatsApp → **API Setup** panel and App → **Settings**:

| StayChat field (Settings → WhatsApp) | Meta source | Example shape |
|---|---|---|
| **Phone Number ID** | API Setup panel → "From" number card | `102938475612345` |
| **Access Token** | API Setup panel → permanent token (or System User token for production) | long opaque string |
| **Verify Token** | **You invent this** — any secret word, e.g. `grandpalace-2026` | your word |
| **App Secret** | App Settings → Basic → App Secret | 32-char hex |
| **Phone** | the number in international format | `+233241234567` |

> **Production tokens:** the API Setup "temporary token" expires in ~24h.
> For a live hotel create a **System User token** (Business Settings → System
> Users → generate token with `whatsapp_business_messaging` +
> `whatsapp_business_management` scopes) — long-lived, revocable.

---

## 4. Register the webhook (Meta side)

In Meta's app → **Configuration → Webhook**:

1. **Callback URL** — paste the per-hotel path shown in StayChat Settings →
   WhatsApp:
   ```
   https://staychatos.com/api/webhooks/whatsapp/grandpalace
   ```
2. **Verify token** — paste the *same* word you put in the StayChat field.
   Meta now sends a GET challenge; StayChat answers it (this is what the
   handshake check verifies).
3. **Subscribe to the field** `messages` (that's the only one StayChat
   consumes).

---

## 5. Save + test in StayChat

1. Settings → WhatsApp → paste all five values → **Save**.
2. Press **Test connection**. It verifies, in one shot:
   - outgoing: a real Graph-API call with your Phone Number ID + token
   - incoming: a self-signed webhook round-trip — handshake **and** Meta
     signature validation
3. Green on both halves = done. Red? The test output names which half failed:
   - handshake failed → Callback URL or Verify Token mismatch (steps 3–4)
   - signature failed → App Secret wrong/missing
   - API call failed → expired token or wrong Phone Number ID

---

## 6. Attach the hotel's real number (when leaving the sandbox)

WhatsApp → **From** number → **Add phone number** (business profile: name,
category). Then repeat steps 3 & 5 with the new number's Phone Number ID.
Verify the number by SMS/voice call once. The test number stays for
experiments.

---

## 7. Day-to-day operation

- **WhatsApp Inbox** module — all guest conversations, answerable by any
  role with `inbox.use` (admin, receptionist, staff)
- Guests get the number from: booking-engine confirmations, key sleeves,
  the website — it behaves like normal WhatsApp to them
- Message templates (for proactive/outside-24h-window messages) are managed
  in Meta's console; StayChat handles the session (inbound) side
- **AI receptionist**: if you configured an AI provider
  ([04-apis-and-integrations.md](04-apis-and-integrations.md)), it can
  auto-answer; the Inbox always shows the conversation

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Test: handshake red | Callback URL path must include your exact subdomain; Verify Token must match character-for-character; then re-save in StayChat and re-test |
| Test: signature red | App Secret empty or outdated (Meta rotates it on display — copy fresh) |
| Messages arrive in Meta but not in Inbox | Webhook not subscribed to `messages` field (step 4.3) |
| Token dies after a day | You're using the temporary token — create a System User token (step 3 note) |
| Guests message but hotel can't reply | Replies must go from the same number the guest wrote to — check the conversation's "From" in the Inbox |

---

## Back → [README.md](README.md) · Next: [04-apis-and-integrations.md](04-apis-and-integrations.md)
