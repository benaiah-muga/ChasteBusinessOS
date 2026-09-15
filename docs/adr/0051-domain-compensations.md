# ADR 0051: Domain compensations, not generic journal reversal

Status: Accepted

Date: 2026-09-15

## Context

`accounting.reverseEntry` mirrored journal lines and declared itself the
inverse of half the ledger: POS sales, payroll executions, vendor bills and
payments all pointed their `inverse` at it. A mirror is only the money leg
of an undo. Reversing a payment's entry left `paid` inflated — the invoice
kept collecting on money already returned; reversing a payroll posting left
the run marked `executed` while its GL leg vanished; reversing a register
sale restored neither stock nor the drawer; a foreign-currency entry was
mirrored into the base currency, silently converting it. Worse,
`pos.completeSale` built its inverse input from `output.entryId` — a key its
output never returned — and nothing caught it: `InverseSpec` typed the
output as `unknown`, so every `buildInput` cast its way past the compiler.

## Decision

A generic journal mirror is not a business undo. Source types that own
subledger or lifecycle state get a **domain compensation**, and the generic
path refuses them with the route named:

- `accounting.reversePayment` — mirrors the payment's entry (and, for a
  cross-currency settlement, the foreign clearing entry too) each in its
  original currency, releases the amount from the invoice through the one
  balance contract (N11), demotes `paid` status honestly, and refuses a
  second reversal. Uniqueness is checked at the business-operation level —
  by the payment id, not by hoping nobody retries.
- `hr.reversePayrollPosting` — mirrors the run's posting and flips the run
  to `reversed`, so the lifecycle and the ledger agree again. Draft runs
  keep `void`; a run cannot be reversed twice.
- Register sales undo through `pos.returnSale`, which now also drops the
  drawer's expected cash when the refund is cash — closeSession would
  otherwise flag an "overage" that is really money already handed back.
- Invoices are never posting-reversed: how much to concede is a business
  decision, so `createInvoice` declares no mechanical inverse and the
  generic path routes to `accounting.creditNote`.
- `reverseEntry` itself keeps its honest job — manual and unsupported
  entries — and now preserves the original entry's currency.

The kernel change that makes this hold: `InverseSpec<I, O>` is typed against
the capability's validated output, and every `buildInput` cast is gone. An
inverse that reads a key the output never returns is now a compile error —
the POS bug this started from cannot be written again.

## Consequences

- Pay→reverse→pay converges: GL, invoice balance and payments agree at
  every step, and a replayed reversal has no second effect.
- Cross-currency settlements reverse as a coherent pair; a foreign
  reversal retains its currency (ADR 0021 holds through corrections).
- The web journal's "undo" button now surfaces routing errors for
  protected types instead of silently desynchronizing documents — the
  error names the workflow that actually undoes the thing.
- Capabilities whose undo is genuinely a business decision (invoices) no
  longer claim a mechanical inverse; that is declared debt, not a lie.

## Verification

Live-DB tests: pay→reverse→pay with GL netting to zero and a replay
refused; FX-settlement pair reversal with per-entry currencies; protected
source types routing with named guidance; POS inverse exercised against the
actual output through schema validation and executed end-to-end (stock,
drawer, money together); payroll reversal with lifecycle repair and second-
reversal refusal.
