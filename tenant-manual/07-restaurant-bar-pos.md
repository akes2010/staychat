# 07 — Restaurant & Bar (POS)

The manual for **`cashier`** and **`barman`** (Point of Sale + End of Day —
their entire surface), plus the admin's Menu Manager that feeds it.

Two **outlets** exist: `restaurant` and `bar`. A user's department decides
their default till (`Restaurant POS` → restaurant, `Bar POS` → bar); both
roles can operate either till if policy allows.

---

## 1. The till loop (Point of Sale module)

### Open a ticket
**POS → New ticket** → pick the table/seat or "Takeaway". The ticket opens
live — the kitchen/bar sees it.

### Add items
The menu is grouped by category (Starters, Mains, Drinks, Cocktails…):

- tap items to add — quantity steppers on the line
- modifiers/notes per line ("no onions", "extra ice") — free text goes to
  the outlet's screen
- the **cart total updates live**; prices come from the Menu Manager — cash
  staff cannot type a price

### Service modes
- **Eat-in / room charge:** charging to a room attaches the line to the
  guest's folio — settle happens at the hotel desk, not the till
- **Cash/card/mobile at the till:** take payment, ticket closes, receipt
  prints (thermal 80/58 per outlet config)

### Hold, transfer, void
- **Hold** a ticket (guest stepped away) — it stays open, listed by table
- **Transfer** a ticket between tables
- **Void a line or whole ticket** — possible for the operator, always
  recorded; totals reconciled at EOD
- **Switch terminal** when one till is busy — open tickets are per-outlet,
  not per-machine

### Close & cash up
**Close ticket** at payment. At shift end: **End of Day → Close my
session** — declare cash/card/mobile totals; the admin's EOD overview
reconciles against ticket records; discrepancies are visible, not hidden.

---

## 2. Menu Manager (admin only, `menu.manage`)

The catalog behind the tills:

- **Categories** — sections of the till screen (order = screen order)
- **Items** — name, price, category, availability toggle (86'd items vanish
  from the till instantly), optional image, outlet assignment (restaurant /
  bar / both)
- **Outlets** — restaurant and bar are pre-created; each has its own
  categories/items/reports

Daily ritual: 86 an item when it runs out, un-86 when the kitchen restocks —
no more "sorry, we just sold the last one" tickets.

---

## 3. What this role never sees

By design (the narrowest surface in the system): bookings, guests, rooms,
payments module, analytics, settings, users, prices-editing. The till is
their whole world — which is exactly why till fraud is structurally hard:
the same records the cashier creates are the ones the accountant and auditor
reconcile ([08-accounting-audit.md](08-accounting-audit.md)).

---

## Tips

- One ticket per guest/table — merging later is more work than splitting at
  the start.
- Room-charge lines must name the room/guest correctly at creation; the desk
  can't guess which "Mr. Smith in 204" a stray line belongs to.
- Void reasons in the note field — the auditor reads them.

## Back → [README.md](README.md)
