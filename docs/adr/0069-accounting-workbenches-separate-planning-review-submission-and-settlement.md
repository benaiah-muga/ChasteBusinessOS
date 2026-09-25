# ADR 0066: Accounting workbenches separate planning, review, submission, and settlement

Status: accepted

## Context

Budget planning, period close, tax filing, and supplier payment each combine
several decisions with different consequences. A forecast assumption should
not change a posted ledger. An accountant's review should not silently close a
period. Recording a tax return in the ledger is not the same as sending it to
an authority. Preparing a bank schedule is not confirmation that funds moved.

The application has no connected tax authority or bank provider, and supplier
bank coordinates are not configured. The accounting experience still needs
clear, auditable workflows that can be used now without implying that those
external actions happened automatically.

## Decision

- Save budgets as named, immutable versions. Compare each plan with posted
  income and expense and remaining purchase order net value. Exclude foreign
  journal entries from the comparison until they are converted; report their
  count when they affect income or expense accounts. Cash assumptions are
  inputs to the forecast, not ledger postings.
- Gate month close on bank reconciliation, required FX revaluation, and explicit
  review sign-offs for journals, receivables, payables, and tax. Keep close and
  reopen as separate approval-governed actions.
- Snapshot tax calculations from transaction-line rate and inclusive-price
  fields, then preserve jurisdiction, code-level totals, submission references,
  evidence, and acknowledgments with the return. Treat external submission and
  ledger settlement as separate steps. Show manual portal recording when no
  provider adapter is configured.
- Build supplier payment runs from same-currency open bills. Revalidate every
  bill under lock at approval, post settlements in one journal entry, and
  retain line-level remittance details. Mark the run bank-confirmed only when
  its consolidated debit matches the bank statement. Allow reversal only before
  that confirmation.

## Consequences

The accounting screens show which facts are ledger-backed, which are forecasts
or human reviews, and which depend on an external portal or bank. Existing
capability permissions and audit records govern every state change. A real tax
submission or payment initiation still requires a jurisdiction or banking
provider integration, and payment schedules cannot contain supplier bank
coordinates until those are configured. Supplier bills currently use the
organization's base currency, so foreign payable revaluation also needs a
complete bill, FX snapshot, payment, and settlement flow before it can be
represented accurately in month-end close.
