# 02 — Users & Roles (admin)

How to create every staff account, what each role can do by default, and how
to hand-craft permissions per person.

---

## 1. Creating a user (Users module → + Add User)

| Field | Rules |
|---|---|
| Name | shown in the sidebar, receipts, audit trails |
| Email | the login (unique per hotel) |
| Password | 8+ chars, at least one upper, one lower, one digit, one special character — enforced |
| Role | one of the seven below — the starting point for permissions |
| Department | Front Desk, Housekeeping, Restaurant POS, Bar POS, Accounts, Engineering… — used in reports and printer routing |
| Phone | optional, shown in the staff directory |

The account is live immediately — the person logs in at
`https://staychatos.com` with that email/password. There is no email-invite
step; hand over the credentials out-of-band (or have them change the password
on first login).

**Admin-only controls** (Users module): reset password, deactivate/reactivate,
edit the permission checklist.

---

## 2. The seven roles (server-enforced defaults)

### `hotel_admin` — the owner/manager
Everything, including the admin-only surface: **Users, Staff, Settings,
Billing & Plan, Menu Manager, Pricing, Refunds, AI Setup, Printers, API
Integrations**, plus `.manage` on pool/halls/EOD and room status. 1–3
accounts per hotel is typical.

### `receptionist` — the front desk
**Rooms, Bookings, Guest Wi-Fi, Booking Engine, WhatsApp Inbox, Room Service,
Other Services, Housekeeping/Maintenance (view + update), Guests, Payments
(use), Analytics, Shifts (clock in/out), EOD.**

Notably **cannot**: use the POS till (that's F&B's), change any price,
refund, touch users/settings/billing, or manage the menu. They operate on
`.use` capabilities only.

### `staff` — housekeeping & maintenance
**Rooms (status), Housekeeping board, Maintenance tickets, WhatsApp Inbox,
Room Service, POS (use), Shifts, EOD, Dashboard.** No bookings, no guests
profiles, no money beyond ringing sales at the till.

### `cashier` — restaurant/breakfast till
**Point of Sale + End of Day.** That's it — a deliberately narrow surface:
open tickets, add items, take payment, close, cash-up.

### `barman` — bar till
Identical surface to cashier (`POS + EOD`), operating on the **bar** outlet.

### `accountant` — finance
**Accounting (manage), Payments (use), Analytics, Dashboard.** Can record
journal entries, reconcile payments, view every financial report — cannot
touch rooms, bookings, or users.

### `auditor` — read-only finance/compliance
**Dashboard, Accounting (view), Analytics.** Constructed to be *structurally*
read-only — never granted any `.manage` capability, so it cannot be tricked
into changing anything.

---

## 3. Custom permissions (per-user overrides)

Any user's checklist can be edited — once customized, **that list becomes
their complete capability set** (role defaults no longer apply):

1. Users module → pick user → **Edit permissions**
2. Tick exactly the capabilities they need (the same 31 the server checks)
3. Save — effective immediately on their next request

Use cases:
- Front-desk supervisor who should also see Analytics but not refunds
- Duty manager covering EOD overview (`eod.manage`) without full admin
- Seasonal worker: attendance + housekeeping only

> Tip: keep at least one `hotel_admin` with the **default** (full) set —
> don't customize the owner account, or a future feature's default capability
> may be missing from their hand-edited list.

---

## 4. Offboarding

**Deactivate** (never delete-and-recreate for leavers): the account stops
 authenticating instantly; their historical actions stay in audit trails and
 reports. Reversible if the person returns.

Reset the password immediately on any suspected sharing, and check
**Audit** trails in Settings if something looks wrong.

---

## Back → [README.md](README.md) · Next: [03-whatsapp-meta-setup.md](03-whatsapp-meta-setup.md)
