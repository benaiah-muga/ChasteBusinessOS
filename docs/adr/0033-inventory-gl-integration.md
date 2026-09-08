# ADR 0033, Inventory → GL integration: periodic valuation summary

Date: 2026-08-30 · Status: accepted

## Context

ADR 0009 deliberately deferred GL integration until valuation policy was
proven. That proof has landed: the append-only stock ledger replays a
moving-average value (`erp-core/inventory.ts`, property-tested), quantities
are integer thousandths, oversell is structurally impossible, and
manufacturing/POS/purchasing all write through the shared
`recordStockMovement` seam. The books, however, still do not see inventory:
account 1200 sits idle, and goods movements hit expense codes directly.

The options were:

1. **Perpetual posting** — every movement posts its COGS relief / asset
   increase at movement time. Correct in the limit, but it doubles the
   write surface of the hottest path in the system, forces cost-layer
   decisions at every inward movement, and makes reversals per-movement.
2. **Periodic valuation summary** — the ledger stays the operational
   truth; on demand (or at close) one balanced entry brings account 1200
   from its current GL balance to the replayed ledger value, counterpart
   on COGS (5000).

## Decision

Periodic, option 2. New governed capabilities:

- `inventory.postValuationSummary` — recomputes the replayed ledger value
  and the GL balance inside one transaction; posts the single adjustment
  (variance = ledger − GL; positive → DR 1200 / CR 5000, negative → DR 5000
  / CR 1200); explicit no-op when already reconciled (an empty entry must
  never exist). Risk class `money` with `moneyAmount → null`, which the
  kernel treats as fail-closed "always demand human approval".
- `inventory.reverseValuationSummary` — the declared inverse; mirrors the
  exact entry once (`reversal_of_id`), refusing double reversal.

Reconciliation math (`erp-core/gl.ts`) is pure and property-tested: lines
always balance, land the GL exactly on the ledger value, and vanish at zero
variance. Transfer legs (ADR 0009 ledger, reason `transfer`) are
value-neutral by definition — they relocate quantity, never acquire or
consume value, so valuation replay ignores them.

## Consequences

- The balance sheet finally sees inventory; the stock report and the GL
  agree by construction after every summary.
- COGS timing stays approximate between summaries (cash-basis era habit);
  perpetual COGS-at-sale remains deferred until cost layers/landed costs
  force the question.
- Summary recomputes variance at post time inside the caller's transaction;
  a concurrent movement mid-transaction is serialized by row locks on the
  ledger inserts. A dedicated advisory lock is unnecessary until summaries
  are scheduled (noted for the routines milestone).
- Retires the ADR 0009 deferral note "financial inventory valuation is a
  future ADR" — this is that ADR.
