# ADR 0019, Cash basis is a derived view; year-end close is one balanced entry

Date: 2026-08-23
Status: Accepted

## Context

The accounting module is GA except for a cash-basis view and a formal year-end
close. Both touch the ledger, which is append-only and invariant-guarded, so
both must be derived or additive, never a second set of books.

## Decision

**Cash basis** (`computeCashBasis` in `erp-core`) is a pure projection of
accrual entries: an entry contributes only if it moves a cash account, and its
income/expense attribution follows the cash leg. The identity enforced by
construction and property tests: `netCash = cashIn − cashOut = Δcash` for the
window. Credit sales appear in the accrual comparison and the uncollected gap,
not in cash-basis revenue.

**Year-end close** (`accounting.closeYear`, destructive class) posts exactly one
balanced closing entry computed by `computeYearEndClose`: income accounts are
debited their balance, expense accounts credited theirs, and the difference,
net income or loss, lands on Retained Earnings (3100). December is sealed in
the same transaction. The declared inverse is `accounting.reverseEntry`, so even
a year-end close is reversible through the normal correction path with approval.

## Consequences

- No new tables, no parallel ledgers; both features reuse the existing
  immutability and conformance machinery.
- After a close, P&L accounts read zero for that year and equity carries the
  result, standard bookkeeping expectations.
- Cash-basis reporting never requires re-posting history.
