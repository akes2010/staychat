# 10 — Modules Reference (the rest of the system)

Pool, halls, other services, shifts, reports, and the offline-desk behavior
— everything not covered in a role chapter.

---

## Pool Bookings (`pool.use` / `pool.manage`)

Sell pool sessions/lanes/time-slots:

- Admin defines pool **slots & pricing** (`pool.manage`) — day/time windows,
  capacity, price
- Reception books guests into slots (`pool.use`) — availability excludes
  already-sold capacity; charges land on the guest folio or pay-at-desk
- Cancel/refund is `.manage` (admin)

## Halls & Events (`halls.use` / `halls.manage`)

Event/wedding/conference space bookings:

- Admin sets up **halls** with capacity + pricing tiers (`halls.manage`)
- Reception books events: dates, guest count, package price, deposit vs
  balance tracking (`halls.use`)
- Overlap-safe: a hall can't be double-booked for the same period
- Cancel = admin, per policy, with reason

## Other Services (`orders.manage`)

The ad-hoc paid services catalog — shoe shine, laundry, car wash, spa,
airport transfer… (admin maintains the catalog; reception/staff sell):

- catalog of services by category with prices (admin)
- staff place orders → charge posts to the guest's **folio** automatically
- statuses flow live (requested → in progress → done)

## Room Service

Same order-flow pattern but for F&B to the room: takes the order, routes to
restaurant/bar outlet, charges to the room.

## Shifts & Attendance (`attendance.use` / `shifts.manage`)

- **Admin defines shifts** (name, times, which departments)
- **Everyone else clocks in/out** (Shifts & Attendance module) — the record
  feeds payroll reports; admins can mark/correct attendance (logged)
- Summary views: hours per person per period

## End of Day (`eod.use` / `eod.manage`)

- **Every operational role closes their own session** at shift end: declare
  cash/card/mobile totals (30 seconds)
- **Admin overview**: declarations vs system records per shift/outlet;
  discrepancies flagged with staff name + amount
- Reopening a closed EOD: admin-only, recorded

## Report Management (`analytics.view`)

The formal report set (daily revenue, outlet performance, outstanding
balances, payment-method splits) with date ranges and print/PDF export.
Analytics (the dashboard-style visual reports) sits next to it.

## Guest Wi-Fi

Per-booking provisioning at check-in ([05](05-receptionist-front-desk.md)),
extend/revoke during the stay, guest self-serve with room + booking
reference. Group bookings get per-room credentials.

## WhatsApp Inbox

All guest conversations, answerable by any role with `inbox.use`
(admin/receptionist/staff). Setup: [03](03-whatsapp-meta-setup.md). AI
receptionist config: [04](04-apis-and-integrations.md).

## The offline desk queue (built in, no setup)

Shared-desk reality: the internet drops. When it does:

- reservations, check-ins, check-outs, guest registrations and settlements
  are **queued on the device** (IndexedDB) — the operator sees honest
  "saved offline" confirmations, never fake receipts
- the queue **syncs automatically** when connectivity returns (also at next
  app start — the queue survives browser closes) — with exactly-once
  semantics, so a flaky connection can never double-book a room
- a rare conflict (e.g. the room was sold elsewhere while offline) is
  flagged **"needs review"** in the badge ledger for a human to resolve —
  never auto-forced
- logging out wipes the queue with the caches (shared-device hygiene)

No action needed — it's on. The badge at the top tells you the state.

## Global search (top bar)

Type 2+ characters: bookings, guests, rooms, transactions, menu items and
staff across the hotel in one query — click a result to jump straight to
its module.

---

## Back → [README.md](README.md)
