# ADR 0014: Payroll as one gated ledger entry

Date: 2026-08-22 · Status: accepted

## Context

M4 adds employees, leave and a simple payroll run. Payroll is the most
regulator- and trust-sensitive money path in an ERP after the GL itself. The
design question: how does payroll post without either a per-payslip approval
storm or a single unreviewable bulk write?

## Decision

- **One run = one balanced journal entry**: DR salary expense (gross),
  CR cash (net), CR Payroll Liabilities (withheld tax). Payslips are
  computed at draft time and stored; execution posts only the summary.
  Per-employee payment runs are out of scope until direct deposit exists.
- **Pure math first** (`erp-core/payroll.ts`): proration, withholding,
  summaries and leave-overlap are deterministic integer functions with
  property tests (`net + tax == gross` for any input; summaries are exact
  sums; corruption throws). The module wires, it does not calculate.
- **Integrity check at the gate**: `executePayrollRun` takes
  `expectedTotalNetMinor`, which must match the drafted total. This gives
  the policy engine an amount to threshold on (agents are always gated;
  `moneyThresholdMinor: 0`) *and* makes "pay what was reviewed" explicit,
  a tampered caller payload refuses before touching the ledger.
- **Leave reduces pay only when approved *and* unpaid**, by calendar-day
  overlap with the run's month, clamped to the month's length.
- **Executed runs reverse via the ledger** (`accounting.reverseEntry`),
  never by mutation; drafts void cleanly. One run per org per month
  (unique index).

## Consequences

- Approval is per-run, not per-person, a human signs off once on a reviewable
  total; the audit trail still carries every payslip.
- Withholding sits in a visible liability account (2200) rather than vanishing
  into net; remitting it is a future bill-payment flow against that account.
- Adding benefits, bonuses, or multiple pay components means extending
  `PayslipLine` + the entry builder together, the invariant tests force them
  to stay balanced.
