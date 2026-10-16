# 06 — Housekeeping & Maintenance

The manual for role **`staff`** (Housekeeping / Engineering departments):
Rooms status, Housekeeping board, Maintenance tickets, plus the limited
surfaces this role also gets (POS for staff meals, Room Service, WhatsApp
Inbox, Shifts, EOD, Dashboard).

**What you don't have:** bookings, guest profiles, payments — the front desk
owns those. Your job is the *physical state* of the property, and the whole
hotel sees it live.

---

## 1. Clock in (Shifts & Attendance)

**Clock in** on arrival / **Clock out** at shift end — your hours feed
payroll; the admin manages shift schedules, you use them.

---

## 2. Room states (Rooms module) — the source of truth

Every room is exactly one state, visible to everyone instantly:

| State | Meaning | Who sets it |
|---|---|---|
| `available` | sellable, clean | housekeeping after cleaning |
| `occupied` | guest in house | system on check-in |
| `dirty` | checkout happened, needs cleaning | system on check-out |
| `maintenance` | broken, out of inventory | maintenance (you) |
| blocked | temporarily out (VIP hold/renovation) | admin |

Your loop: **dirty → (clean) → available**. Tap the room on the board, mark
it cleaned — the front desk sees sellable inventory appear the same second.

Also on the Rooms board: report an **issue** on any room (leaking tap,
broken AC) — it stays visible until cleared.

---

## 3. Housekeeping board (🧹 Housekeeping)

The purpose-built view: floors grouped, dirty rooms flagged, assignments
(when the admin uses room assignment), linen/status notes, and quick-clean
actions. Work top-down by floor; the board is designed for a phone/tablet
while walking.

**Room transfer note (group stays):** when a group booking transfers a guest
between rooms mid-stay, the target room's cleanliness is your call — the
board shows transfer-pending rooms.

---

## 4. Maintenance tickets (🔧 Maintenance)

1. **+ New ticket** — room/area, category (plumbing, electrical, HVAC,
   furniture…), severity, description. Photos of the problem beat words.
2. States: `open → assigned → in progress → resolved`. Admins/engineers
   assign; you update progress.
3. Rooms with an unresolved **critical** ticket sit in `maintenance` state —
   unsellable until you clear it.
4. **Resolved** → the room returns to the pool (mark cleaned if needed).

Housekeepers can *report*; engineering (also `staff` role, Engineering
department) *works* the tickets. Same role, different department lens.

---

## 5. The other surfaces you get

- **Room Service / Other Services** — incoming orders show live; accept,
  deliver, mark done. Charges go to the guest folio automatically — you
  never touch money.
- **WhatsApp Inbox** — if your hotel routes housekeeping requests ("extra
  towels, room 204") to this role, they arrive here.
- **POS (use)** — ring up staff meals at the outlet till (manager-authorized
  items only).
- **Dashboard** — today's housekeeping load at a glance.

---

## 6. Shift close (End of Day)

**End of Day → Close my session** — quick declaration at shift end; the
admin sees it in the EOD overview.

---

## Tips from the field

- Clean **top-down by floor**, not room-number order — fewer stair trips.
- Mark `available` *the moment* you finish a room — that's when it becomes
  sellable; a 5-minute lag is inventory the desk can't use.
- Anything structural (won't-fix-today) → `maintenance` state, not just a
  note — it prevents a sold-out-room disaster at 11 p.m.

## Back → [README.md](README.md)
