# ADR 0048: Bank matching reconciles money, not identities

Status: Accepted

Date: 2026-09-15

## Context

`matchBankTransaction` verified only that the referenced payment or journal
entry existed in the org before letting a statement line claim it. A 100
bank inflow could "reconcile" a 10 payment; a money-out line could absorb a
customer receipt; a USD statement could swallow a EUR payment; and two
statement lines could each claim the same payment, double-counting the cash
explanation while showing zero unmatched rows. The conditional claim on the
statement line prevented two decisions on one line, but nothing prevented
two lines on one decision.

## Decision

A match must be economically equivalent to the line it explains:

- Payments: the statement line must be money in, exactly the payment's
  amount, and in the payment's currency (a payment inherits its invoice's
  currency; the statement line carries its bank account's).
- Journal entries: the entry's currency must match the statement account,
  and the entry's net effect on the cash account must equal the line's
  signed amount (net debit for money in, net credit for money out).

One reconciled payment or entry belongs to exactly one statement line. The
claim is enforced in data - unique indexes on the matched-payment and
matched-entry columns, where unmatched/excluded lines carry NULL and never
conflict - with friendly in-transaction guards and a payment/entry row lock
so a racing pair gets a readable error instead of a constraint dump.
Unmatching releases the claim and the line returns to the unmatched queue.

## Consequences

- The audit's N14 negatives are refusals by construction: amount mismatch,
  direction mismatch, currency mismatch, and double claims all fail with
  actionable messages before any state changes.
- "Zero unmatched lines" now means something closer to reconciled, but a
  full reconciliation claim - statement opening/closing balances with an
  unexplained difference of zero - still requires the reconciliation
  workspace (P03). Fees, splits, grouped settlements, transfers and FX
  differences remain unmatchable by design until they have an explicit
  reviewed representation; they surface as amount-mismatch refusals rather
  than silent loose matches.
- Entry matching keys on cash account code 1000, the code every posting
  producer already uses for cash; a future multi-bank-account model must
  make the entry→account linkage explicit rather than inferred.
