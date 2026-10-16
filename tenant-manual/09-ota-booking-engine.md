# 09 — OTA & Online Booking Engine

Your hotel's public sales channel — the "OTA" side of the system. Guests
book online exactly like they would on Booking.com, but on *your* channel,
commission-free.

---

## 1. What exists out of the box

The moment the hotel was created, a public booking page went live:

```
https://staychatos.com/book.html?subdomain=grandpalace
```

- **No login, no commission** — every booking lands directly in your
  Bookings module as a `confirmed` reservation with a reference
- **Live availability** — it only sells rooms that are actually free,
  honoring your rates, holiday pricing, blocks and maintenance states
- **Group-aware** — multi-room selections become group bookings on one folio
- Works on phones (most guests will use one)

The **Booking Engine** module (admin/reception, `bookings.manage`) shows the
exact link, a printable **QR poster** for the lobby/reception desk, and the
branding/notices guests see.

---

## 2. Make it sell like your hotel

**Booking Engine module:**

- **Branding** — hotel name, description, the impression guests get
- **Notice text** — policies shown before booking (check-in times,
  deposit terms, cancellation)
- **Availability window** — how far ahead guests can book

**Rates do the selling** (Rooms → Categories / Pricing, admin):
- seasonal and holiday rates apply **automatically** on the public page —
  set them once a year
- closing a category (0 sellable) removes it from the public page instantly

Test before you promote: open the link in a private window and complete a
real booking — it must appear in Bookings within seconds (it will).

---

## 3. The flow, end to end

| Step | Where it shows up |
|---|---|
| Guest picks dates/rooms on `book.html` | availability from your live inventory |
| Guest completes booking (name, contact, payment terms per config) | instant `confirmed` reservation + reference |
| Confirmation | booking reference + details (email/WhatsApp per setup) |
| Arrival day | normal **check-in** at the desk ([05](05-receptionist-front-desk.md)) |
| Stay | room charges/folio as usual |
| Departure | settle + check out |

Cancellations/changes on online bookings follow the same rules as desk
bookings (override-reason auditing included).

---

## 4. Automating it (channel-manager / API)

The same engine is exposed as a **public API** resolved by subdomain — no
session needed (rate-limited):

```
GET  /api/booking-engine/config?subdomain=grandpalace        # branding + policy
GET  /api/booking-engine/availability?subdomain=…&dates=…    # sellable rooms + rate-card prices
POST /api/booking-engine/book?subdomain=…                    # push a reservation
```

Use cases: your own website's "Book now" button (the page *is* the widget),
a channel manager pushing OTA reservations (Booking.com/Airbnb sync tools),
or a corporate-booking script. Every push is **idempotent** — send an
`Idempotency-Key` header and a retry can never create a duplicate
reservation ([04](04-apis-and-integrations.md) §4).

---

## 5. If you also list on real OTAs (Booking.com, Airbnb…)

StayChat is your **system of record**: keep taking direct bookings here
(commission-free), and either:

- enter OTA reservations manually at the desk (source = the OTA name, so
  analytics attribute them correctly), or
- use a channel manager that can push/pull via the API above (step 4) —
  point it at the availability/book endpoints

Whichever route: **one source of truth for availability** — always update
StayChat first, or you risk overselling.

---

## 6. Channel hygiene checklist

- [ ] QR poster printed and displayed (lobby, reception, room cards)
- [ ] Policy notice written (cancellation terms guests see *before* booking)
- [ ] Holiday rates set for the coming year
- [ ] Test booking completed and cancelled once — you know the flow
- [ ] Website "Book now" button links to the engine (or embeds it)

## Back → [README.md](README.md)
