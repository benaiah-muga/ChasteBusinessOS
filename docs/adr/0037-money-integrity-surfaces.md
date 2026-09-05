# ADR 0037: Money integrity surfaces

Date: 2026-08-31
Status: Accepted (M10)

## Context

The suite promised "trustworthy money, memorable suppliers": a cash flow
statement that can be trusted, corrections that cannot silently rewrite
history, payment terms that drive real due dates, reminders that respect
people, supplier memory derived from what actually arrived, and foresight
that never posts.

## Decision

- **Cash flow is derived, never stored.** `erp-core/cashflow.ts` is a pure
  function over ledger lines; cash is a configurable code list (default
  1000); classification follows counter-accounts (trading cycle →
  operating, equity → financing, other assets → investing). The statement
  carries its own tie check: category nets must equal the raw cash-line
  movement. Property tests enforce conservation per entry and per bucket.
- **Credit notes are reversal-style, always gated.** `accounting.creditNote`
  and `purchasing.billCreditNote` post proportional mirror entries (revenue
  + tax ← AR; AP ← expenses), carry amounts on immutable `creditedMinor`
  columns, and declare `moneyAmount → null` so every credit waits for a
  human, whatever the size — same discipline as reverseEntry (M1).
  Documents are never edited; statements net gross documents with their
  credit lines.
- **Payment terms are counterparty defaults with per-document overrides.**
  `paymentTermDays` on customers and vendors; `dueAt` lands on invoices and
  bills at creation. Reminders are DRAFTED deterministically
  (`accounting.buildReminders`) with opt-out honored at drafting time;
  delivery rides the messaging seam and can be scheduled as a routine via
  the existing accounting template system.
- **Supplier memory is derived from receipts** (stock movements, refType
  `po_line`): average lead time (ordered → first receipt), fill rate,
  promised-date on-time rate, and price history from PO lines. Closing an
  order with unfilled quantities records a `backordered` flag; returns are
  negative purchase movements through the same ledger — no second truth.
- **Foresight never posts.** The 13-week forecast buckets open AR/AP by due
  week from current cash (property: bucket conservation, chained closes);
  duplicate-payment detection is a deterministic pairwise rule (same
  invoice, same amount, inside a window) surfacing orange signals with
  evidence — advisory, human decides.

## Consequences

- Corrections are visible, gated, and never rewrite history.
- Statements reconcile by construction: same ledger, same derivation.
- The forecast's honesty is bounded by due-date hygiene — terms that are
  entered truthfully produce forecasts worth trusting.
