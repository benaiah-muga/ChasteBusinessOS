# ADR 0010 — Three-way matching on vendor bills

Date: 2026-08-22 · Status: accepted

## Context
Paying vendor invoices blindly is how businesses leak money: goods never
arrived, quantities padded, prices drifting from what was agreed.

## Decision
When a bill references a purchase order, every line is matched against the
order line and received quantities (from the stock ledger) before posting:
billed ≤ received, billed ≤ ordered (cumulative across bills via poLineId
links on bill lines), and price within ±2% of the ordered price. Violations
reject the whole bill with named violations; there is no override path yet —
fix the receipt or renegotiate the bill.

## Consequences
- Duplicate billing of the same PO line fails loudly (verified live).
- Legitimate partial bills work: match runs against remaining receivable.
- No tolerance override exists; emergency cases wait for a future approval-
  gated bypass capability rather than a silent one.
