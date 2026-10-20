# 01 — Tenant Setup (owner/admin)

From zero to a fully operable hotel workspace. Done once, by the owner —
takes ~30–45 minutes for a small property.

---

## 1. Create the hotel account

Open **`https://staychatos.com/signup`** and fill in:

| Field | Notes |
|---|---|
| Hotel name | e.g. `Grand Palace Hotel` — becomes your subdomain base (`grandpalace`, numbers/dashes handled automatically; duplicates get a suffix) |
| Your name | becomes the **hotel_admin** (owner) account |
| Email | your login forever — also where plan invoices go |
| Password | 8+ chars with upper + lower + digit + special character |
| Plan | pick the tier you want; you start on a **30-day full-feature trial**, no card required |

On submit the platform provisions your workspace **instantly and
automatically**:

- your tenant + the `hotel_admin` user
- booking engine enabled
- a **starter workspace**: 1 floor, room categories with tiered rates, and
  **8 real bookable rooms** (2 suites, 4 standard, 2 deluxe)

You land directly in your dashboard — the hotel is *already* operable (you
can book, check in and settle on day one). The rest of this file makes it
*yours*.

---

## 2. Property settings (Settings module, admin only)

**Settings** (⚙️, requires `settings.manage` — admin only):

- **Currency** — every price, report and receipt uses it
- **Timezone** — shift times, EOD cutoffs and reports follow it
- **Hotel name / details** — shown on receipts and the booking engine

Do this **before** entering rates — prices are stored in your currency units.

---

## 3. Build the property (Rooms module)

The starter workspace gives you 8 rooms to try the flows. Replace/extend it
with your real inventory:

### 3a. Floors
**Rooms → Floors** — add each floor (`Ground`, `First`, …). Floors group
rooms in every view and report.

### 3b. Room categories + rates
**Rooms → Categories** — one per room type (`Standard`, `Deluxe`, `Suite`):

- nightly **rate** (the default price)
- capacity (adults/children)
- description/amenities shown on the booking engine

**Rates & pricing** (`pricing.manage`, admin):

- base rate per category
- **holiday / festive dates** — automatic surcharge on specific dates
  (define them once a year; every booking engine and desk booking picks them
  up automatically)

> The `.use` vs `.manage` split: reception can *use* prices when booking but
> can never *change* them — only admin touches pricing.

### 3c. Rooms
**Rooms → Add room** — for each physical room: number, floor, category,
status. Repeat (or copy) until inventory matches reality.

**Blocklist** — mark rooms out of inventory temporarily (renovation, VIP
hold) without deleting them.

---

## 4. Create your staff (Users module)

See [02-users-and-roles.md](02-users-and-roles.md) — the full recipe for
each role. Minimum viable team on day one:

1. **Receptionist** ×1–2 → front desk
2. **Staff** (housekeeping) ×1–2 → cleaning + maintenance reporting
3. Later: cashier/barman (F&B), accountant, auditor

---

## 5. Connect WhatsApp (your guest channel)

See [03-whatsapp-meta-setup.md](03-whatsapp-meta-setup.md) — needs a Meta
app and the hotel's WhatsApp Business number. This powers the **WhatsApp
Inbox** (guest chat), booking confirmations and the AI receptionist option.

---

## 6. Enable the online booking channel

Your public channel is live the moment the hotel exists:

```
https://staychatos.com/book.html?subdomain=grandpalace
```

**Booking Engine** module (admin) shows the exact link + QR poster, branding,
and the notices guests see. Test it yourself in a private window — book a
room end-to-end; it appears in **Bookings** instantly. Full guide:
[09-ota-booking-engine.md](09-ota-booking-engine.md).

---

## 7. Money & hardware (optional but recommended)

- **Payments module** — cash/card/mobile-money settlement, payment links,
  balances per guest ([08-accounting-audit.md](08-accounting-audit.md))
- **Printers** — thermal receipt printers (80mm/58mm) for the desk/POS and an
  A4 for folios ([04-apis-and-integrations.md](04-apis-and-integrations.md))
- **Plan & billing** — **Billing & Plan** module (admin only) shows your
  trial countdown; after the trial pick a plan so the hotel keeps running

---

## 8. Verify the setup (10 minutes)

- [ ] Book a room at the desk (reception flow) → check in → Wi-Fi provisioned → settle → check out
- [ ] Book through `book.html?subdomain=…` in a private window → appears in Bookings
- [ ] WhatsApp test message (after step 5) → shows in Inbox
- [ ] Add a POS ticket at the bar → close it → see it in the bar's EOD
- [ ] Log in as your receptionist account → only the pages they should see appear
- [ ] Rates changed as admin → booking engine price updates

---

## You're operational 🎉

Next: onboard the team with the role chapters — reception
([05](05-receptionist-front-desk.md)), housekeeping
([06](06-housekeeping-maintenance.md)), F&B ([07](07-restaurant-bar-pos.md)),
finance ([08](08-accounting-audit.md)).

## Back → [README.md](README.md)
