# 05 — Receptionist (front desk)

The daily driver's manual. Your role: `receptionist` — Rooms, Bookings, Guest
Wi-Fi, Booking Engine, WhatsApp Inbox, Room Service, Other Services,
Housekeeping/Maintenance, Guests, Payments, Analytics, Shifts, EOD.
**Not** the POS till (that's cashier/barman), never prices or refunds.

---

## 1. Start and end your shift

**Shifts & Attendance** → **Clock in** when you arrive, **Clock out** when
you leave. Your hours feed payroll reports; the admin can see corrections.

---

## 2. The reservation lifecycle (Bookings module)

### Take a booking
**Bookings → + New reservation** (or the global 🔍 search first — an
existing guest's history follows them):

1. Guest details — surname + first name (minimum), phone/email for
   confirmations
2. Dates + room picks — availability filters out sold/blocked rooms; rates
   auto-fill from the category's rate card (**holidays/festive dates apply
   automatically** — you never type a price yourself)
3. Source (direct / walk-in / online) + notes
4. Save → the booking gets a **reference** (quotes, confirmations, Wi-Fi
   self-serve all use it)

**Group bookings:** toggle group mode to attach multiple rooms to one
reservation — one folio, one checkout, per-room Wi-Fi credentials.

**Editing / cancelling:** you can edit dates/rooms and cancel per your
hotel's rules. A **paid** booking or one inside a cancellation window needs
an override reason (recorded). Prices themselves are locked to admin.

### Check-in (the 30-second ritual)
1. Find the booking (reference, name, or the Arrivals list)
2. **Check In** → room turns `occupied`, guest appears on the floor
3. The system offers **Wi-Fi provisioning** — one click issues per-room
   credentials; print them (or they're on the key sleeve with the reference)
4. Any outstanding balance shows on the guest's folio from here on

Walk-in with no booking? Create the booking first (source = walk-in), then
check in — the two steps chain.

### Check-out
1. Open the booking → **Settle Balance** if anything is owed (cash/card/
   mobile money — receipt auto-prints; the balance must reach 0)
2. **Check Out** → room turns `dirty` and lands on the housekeeping board
   instantly (force check-out with a reason is possible for disputed stays —
   it's recorded)

---

## 3. Guests module

Every guest who ever stayed: profiles, contact details, stay history,
loyalty points, notes ("allergic to feathers — top floor room"). Registering
a guest at the desk creates/updates the profile automatically. Repeated VIP?
Notes here surface at their next booking.

---

## 4. Payments (use, not manage)

**Payments** — record what the guest pays at the desk (cash/card/mobile),
print receipts, share payment links, issue a **voucher** where hotel policy
allows. **Refunds are admin-only** — escalate.

Room charges from room service, POS (charged to room), pool/hall bookings
and other services all land on the guest's **folio/balance** — the number
you see in Settle Balance is everything outstanding.

---

## 5. Guest Wi-Fi module

Beyond provisioning at check-in: extend a session for a late checkout,
revoke on early departure, re-print credentials. Guests can also self-serve
with **room number + booking reference** (both on the key sleeve).

---

## 6. Live comms: WhatsApp Inbox + Room Service

- **WhatsApp Inbox** — guest messages land here in real time; answer from
  any desk terminal. Bookings created from a chat stay linked to the
  conversation.
- **Room Service / Other Services** — take the order (laundry, shoe shine,
  transport…), route it to the right outlet, charge to the room. Statuses
  update live for housekeeping/F&B.

---

## 7. The board you live on

**Dashboard** (your landing page): arrivals, in-house, departures, room
states across floors, outstanding balances — everything updates live via
WebSocket; never refresh manually.

**Offline desk rule:** if the internet drops mid-shift, reservations and
check-ins are **queued on the device and sync automatically** when it
returns — exactly-once, never duplicated. A "⏳ waiting to sync" badge
appears; a rare conflict is flagged "needs review" for you to resolve — the
system never silently guesses.

---

## 8. Shift close (End of Day)

**End of Day → Close my session** at shift end: declares your cash/card
totals; the admin sees discrepancies in overview. Quick, but do it — the
accountant reconciles against it.

---

## You can't (by design) — escalate instead

| Blocked for you | Who |
|---|---|
| Changing any price/rate | admin |
| Refunds | admin |
| POS till (restaurant/bar) | cashier/barman |
| Adding users, editing settings, the plan | admin |

## Back → [README.md](README.md)
