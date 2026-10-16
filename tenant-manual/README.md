# StayChat OS — Tenant & User Manual

**The complete operator's manual for one hotel (tenant):** how to set the
property up from scratch, connect WhatsApp/Meta and APIs, and exactly how
each staff role — admin, receptionist, housekeeping, maintenance,
restaurant/bar, accountant, auditor — works the system day to day.

> Written against the actual capability matrix in the code
> (`server/utils/permissions.js`) — every permission claim here is enforced by
> the server, not just hidden in the UI. Examples use
> `https://staychatos.com` and a demo hotel with subdomain **`grandpalace`**.

---

## The mental model

| Concept | Meaning |
|---|---|
| **Tenant** | One hotel property. Its own isolated workspace: rooms, guests, bookings, menu, staff, money. Hotels can never see each other's data. |
| **Subdomain** | The tenant's public identity, chosen/generated at signup (`grandpalace`) → its booking engine lives at `https://staychatos.com/book.html?subdomain=grandpalace` |
| **User** | A staff account *inside* one hotel, with a **role** that decides what it can do |
| **Superadmin** | Platform operator (not a hotel user) — manages hotels and platform billing from the Super Admin console |

---

## Read in this order

| # | File | For whom |
|---|---|---|
| 01 | [01-tenant-setup.md](01-tenant-setup.md) | Owner: signup → fully operable property (floors, categories, rates, rooms, settings) |
| 02 | [02-users-and-roles.md](02-users-and-roles.md) | Admin: creating every staff account, the real permission matrix, custom permissions |
| 03 | [03-whatsapp-meta-setup.md](03-whatsapp-meta-setup.md) | Admin: connecting the hotel's WhatsApp number via Meta (app → tokens → webhook → test) |
| 04 | [04-apis-and-integrations.md](04-apis-and-integrations.md) | Admin: AI provider keys, API Integrations module, printers, developer API surface |
| 05 | [05-receptionist-front-desk.md](05-receptionist-front-desk.md) | Receptionist: reservations, check-in/out, guests, payments, Wi-Fi, room service |
| 06 | [06-housekeeping-maintenance.md](06-housekeeping-maintenance.md) | Housekeeping & maintenance staff: room states, cleaning, issues |
| 07 | [07-restaurant-bar-pos.md](07-restaurant-bar-pos.md) | Cashier & barman: POS tills, tickets, menu manager, outlets |
| 08 | [08-accounting-audit.md](08-accounting-audit.md) | Accountant & auditor: ledger, journal entries, payments, EOD, reports |
| 09 | [09-ota-booking-engine.md](09-ota-booking-engine.md) | Everyone: the public online-booking channel (your "OTA") and how bookings flow in |
| 10 | [10-modules-reference.md](10-modules-reference.md) | All: pool, halls, other services, shifts/attendance, reports, offline queue |

---

## Role → capability at a glance (the real matrix)

`.use` = operate day-to-day · `.manage` = change prices/config/refunds
(only managers get `.manage` by default — a front-desk operator can never
quietly alter a rate or mark a bill paid):

| Capability | Admin | Receptionist | Staff (HK/Maint) | Cashier | Barman | Accountant | Auditor |
|---|---|---|---|---|---|---|---|
| Dashboard | ✅ | ✅ | ✅ | – | – | ✅ | ✅ |
| Rooms (status) | ✅ | ✅ | ✅ | – | – | – | – |
| Bookings / Wi-Fi / Booking engine | ✅ | ✅ | – | – | – | – | – |
| WhatsApp Inbox | ✅ | ✅ | ✅ | – | – | – | – |
| Room service / Other services | ✅ | ✅ | ✅ | – | – | – | – |
| Point of Sale | ✅ | – | ✅ | ✅ | ✅ | – | – |
| Pool / Halls (use) | ✅ | ✅ | – | – | – | – | – |
| Housekeeping / Maintenance | ✅ | ✅ | ✅ | – | – | – | – |
| Guests | ✅ | ✅ | – | – | – | – | – |
| Analytics / Reports | ✅ | ✅ | – | – | – | ✅ | ✅ |
| Payments (use) | ✅ | ✅ | – | – | – | ✅ | – |
| Accounting | ✅ | – | – | – | – | ✅ manage | ✅ view |
| Shifts & Attendance | ✅ | clock in/out | clock in/out | clock in/out | clock in/out | – | – |
| End of Day | ✅ | ✅ | ✅ | ✅ | ✅ | – | – |
| Menu manager / Pricing / Refunds (manage) | ✅ | – | – | – | – | – | – |
| Users / Staff / Settings / Billing | ✅ | – | – | – | – | – | – |

**Every cell is enforced server-side** (403 on the API, not just a hidden
menu item). Admins can also give any user a fully custom permission set per
person — see [02](02-users-and-roles.md).

---

## The module map (sidebar, top to bottom)

| Section | Modules |
|---|---|
| Front of house | Dashboard · Rooms · Bookings · Guest Wi-Fi · Booking Engine |
| Guest comms | WhatsApp Inbox |
| F&B | Room Service · Point of Sale · Other Services · Menu Manager |
| Facilities | Pool Bookings · Halls & Events · Housekeeping · Maintenance |
| People & money | Guests · Payments · Accounting · Analytics · Report Management · End of Day · Shifts & Attendance · Staff |
| Admin | Users & Permissions · AI Setup · Printers · API Integrations · Settings · Billing & Plan |

Modules only appear for roles whose capability grants them.

---

## Start here → [01-tenant-setup.md](01-tenant-setup.md)
