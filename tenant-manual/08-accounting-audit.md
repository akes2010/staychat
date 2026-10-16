# 08 — Accounting & Audit

The manual for **`accountant`** (Accounting manage, Payments use, Analytics,
Dashboard) and **`auditor`** (read-only: Dashboard, Accounting view,
Analytics).

---

## 1. Where money lives in the system

Every currency event ends up in exactly one of:

| Source | Written by | Flows to |
|---|---|---|
| Room bookings (nightly rates) | reception | guest folio → settlement |
| Settlements (cash/card/mobile) | reception (Payments) | payment transactions + folio cleared |
| POS tickets (restaurant/bar) | cashier/barman | outlet revenue → EOD |
| Pool / Hall bookings | reception/admin | folio or direct payment |
| Room service / Other services | reception/staff | guest folio |
| Refunds / adjustments | **admin only** | recorded against the original transaction |

The **accountant's job**: make the books agree with reality. The
**auditor's job**: verify that claim without the ability to change anything.

---

## 2. Accounting module (accountant: manage · auditor: view)

Double-entry style **journal**: every posting is dated, categorized
(room revenue, F&B, other services, adjustments), and attributable to the
staff member who created it.

- **Journal** — chronological entries; filter by date/category
- **+ Journal entry** (accountant) — record accruals, external invoices,
  corrections. Each entry carries a description; nothing is anonymous.
- **Ledger views** — by category/period; the numbers reconcile against
  payment transactions and EOD sheets by construction (they're computed
  from the same records).

The auditor sees the identical screens minus every write control.

---

## 3. Payments (accountant: use)

- **Transactions** — every settlement across the hotel: filter, drill into
  the guest/booking/ticket behind it, export CSV
- **Balances** — outstanding guest folios (who owes what, for how long)
- **Vouchers** — issued/redeemed tracking
- **Payment links** — remote payments shared with guests; the accountant
  sees when they were paid

Refunds are *not* in this role — they stay admin-only, deliberately.

---

## 4. Analytics & reports (both roles)

- **Analytics** — occupancy, revenue by department (rooms vs F&B vs other),
  ADR/RevPAR-style views, period comparisons
- **Report Management** — the formal report set: daily revenue, outlet
  performance, outstanding balances, payment-method splits; date-ranged and
  printable

Auditors: every report is generated from immutable operational records —
you're reading the source, not a spreadsheet someone edited.

---

## 5. End of Day (admin's overview lens)

Per-shift **EOD sheets**: staff declare cash/card/mobile totals at shift
close; the admin's **EOD overview** compares declarations against system
records. Discrepancies surface with the shift, staff member and amount —
the accountant follows up from there.

Reopening a closed EOD is admin-only and logged.

---

## 6. The monthly rhythm

1. **Period close** — run Report Management for the month; archive the PDFs
2. **Reconcile** — payment-method totals vs bank/mobile-money statements
   (the Transactions CSV export is built for this)
3. **Investigate** — any EOD discrepancy unexplained → audit trail in
   Settings shows who/what/when
4. **Hand to tax** — the revenue-by-category report maps cleanly to filing
   categories

---

## Note on the plan bill

The hotel's own subscription (Billing & Plan) is an *expense* of the
property, managed by the owner/admin — it does not appear in this ledger.

## Back → [README.md](README.md)
