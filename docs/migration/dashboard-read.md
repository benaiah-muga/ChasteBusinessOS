# Dashboard read parity specification

Status: legacy remains the public owner. This document records the behavior to
preserve while `GET /api/dashboard` is ported. The source is
[`apps/web/src/app/api/dashboard/route.ts`](../../apps/web/src/app/api/dashboard/route.ts),
and the current browser consumer is
[`apps/web/src/app/(app)/home-dashboard.tsx`](../../apps/web/src/app/%28app%29/home-dashboard.tsx).

## Access and failure behavior

- A request without a resolved organization returns HTTP 401 with
  `{ "error": "unauthorized" }`.
- The handler has a 428 `onboarding required` branch after the no-org check;
  with the current `getResolvedUser` contract that branch is unreachable.
- Income statement, balance sheet, and trial balance capability errors are
  converted to default values. Income and expense become zero, balance sheet
  totals become zero, `balanced` becomes null, and cash becomes null only when
  trial balance fails. If trial balance succeeds without account code `1000`,
  cash is zero.
- Capability reads and direct queries can fail independently: an uncaught
  database failure can fail the request, while report capability failures can
  leave default fields in a successful response.
- Permission behavior is uneven. Report capabilities and `signals.list`
  enforce their registered permissions; direct SQL aggregates do not filter
  by module permission. For a member without `accounting.read`, keep direct
  aggregates visible but return zero revenue, expense, net income, assets,
  liabilities, and equity; return null for `balanced` and `cashMinor` when the
  corresponding report reads fail. Never serialize the internal Go
  dashboard payload until the HTTP adapter has populated its `ReportReadAccess`
  from the corresponding capability results. The Go reader applies these
  report-capability defaults. Preserve this response unless a separately
  reviewed behavior change is approved.

## Projection rules

| Section | Legacy calculation |
|---|---|
| `money` | Income statement excludes `year_end_close` entries and uses the organization's base currency. Balance sheet includes closing entries. Cash is account code `1000`, summed as debit minus credit across currencies. |
| `workingCapital` | AR excludes void invoices and rows with `voided_at`; AP excludes void bills. Outstanding is `max(0, total - credited - paid)`. AR is overdue when `dueAt ?? issuedAt` is strictly more than 30 days old and outstanding is positive. |
| `pipeline` | Six fixed stages: lead, qualified, proposal, negotiation, won, lost. `openCount` excludes won and lost. Forecast weights are 0.1, 0.3, 0.5, 0.7, 1, and 0; each deal contribution is rounded before summing. |
| `ops` | Active employees, pending leave requests, any open POS register, items at or below a positive reorder point, pending approvals, parsed documents, and open document suggestions. Only the register name is returned for POS. |
| `trend` | Six UTC calendar months, zero-filled, sorted oldest to newest. Income is credit minus debit; expense is the negated credit minus debit. All currencies and year-end close entries are included. |
| `activity` | Latest eight ledger events by descending sequence, projected to sequence, kind, capability ID, actor type, and occurrence time. |
| `signals` | `signals.list` output is already severity/module/id sorted and deduplicated. The route returns its first eight entries, including any evidence and suggested action fields. |

## Required parity fixtures

- Inject a fixed `now` to test the strict 30-day overdue boundary and six-month
  UTC window deterministically.
- Include a void invoice, a voided timestamp, a credited invoice, an overpaid
  invoice, and a partially paid vendor bill.
- Include year-end close entries and foreign currency lines to lock the
  intentional difference between P&L, balance sheet, cash, and trend.
- Include all deal stages and values that prove per-deal rounding.
- Include active and deactivated employees, pending and completed leave,
  open and closed POS sessions, stock above/equal/below reorder point, and
  entries from another organization.
- Check report-capability failures separately from direct query failures and
  preserve the response defaults for each.
- Keep `signals` legacy-owned until its Go producers have equivalent sorting,
  deduplication, failure degradation, evidence, and suggested-action behavior.

The Go read-model work is an internal slice only. It does not change the
manifest owner for `/api/dashboard` or the home page. The route changes owner
only after the complete response, session boundary, browser result, and existing
demo proofs pass their gates.
