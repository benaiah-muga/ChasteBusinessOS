# ADR 0046: The shared posting service owns the closed-period guard

Status: Accepted

Date: 2026-09-15

## Context

Sealing an accounting period was enforced by convention: `postEntry`, the one
shared path into the general ledger, did not check the period at all. Each
capability was expected to call `assertPeriodOpen` first, and some did not —
expense reimbursement and the inventory valuation reversal posted into closed
months, and correctness depended on every future producer remembering an extra
step. Close/reopen also wrote the `periods` row outside any transaction, so a
posting racing a close had no defined serial order: both could pass their
checks against the old state and commit interleaved.

## Decision

`postEntry` now owns the guard. The posting command carries a mandatory
effective posting time (`postedAt`), the service takes a per-org
transaction-scoped advisory lock shared with `closePeriod`/`reopenPeriod`, and
it refuses to post when that instant falls in a sealed month. The guarded
instant and the stored `postedAt` are the same value, so a caller cannot check
one date and silently post under another. Close and reopen run inside a
transaction that takes the same lock first.

Consequences of one clock basis: every entry carries an explicit posting time,
and same-instant business rows are normal. Consumer surfaces order ties by
business sequence, not wall-clock luck (customer statements order invoice →
payment → credit note), and subledger timestamps (`payments.received_at`,
`vendor_payments.paid_at`) are stamped from the actor's `now` instead of a
second database clock read.

## Consequences

- Every posting producer — invoices, payments, FX settlements, expense
  claims, POS sales/returns, vendor bills/payments/credits, payroll,
  valuation summaries and their reversals — refuses a closed period by
  construction; new producers inherit the guard for free.
- A synchronized close and post commit in exactly one serial order: either
  the posting landed first (the close seals the month with it on the books)
  or the close committed first and the posting refuses.
- Payroll now posts at execution time like every other producer; executing a
  past-month run after that month's close posts into the current open month
  instead of being refused by a mid-month approximation of the run's period.
- The guard is two statements per posting (one lock, one indexed read) inside
  a transaction that already writes to the ledger; no measurable overhead.
- DB-enforced immutability for posted documents (N09) remains follow-up work;
  this ADR only moves the application-level guard into the one shared path.
