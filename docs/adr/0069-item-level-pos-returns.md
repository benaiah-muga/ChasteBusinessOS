# ADR 0069: Item-level POS returns

Date: 2026-09-26
Status: Accepted

## Context

ADR 0040 limited register returns to full-sale reversals. That prevents cashiers
from returning one damaged item from a multi-item sale and cannot safely record
which quantities have already come back.

## Decision

- A POS return accepts one or more original invoice lines and returned
  quantities. Omitting the line list remains the compatibility path for a full
  remaining return.
- The capability locks the invoice, rejects quantities beyond each line's
  remaining quantity, and writes immutable return and return-line records in
  the same transaction as the balanced journal entry, invoice credit, cash
  drawer adjustment, and stock restoration.
- Subtotal and tax refunds use cumulative rounding against the original line
  totals. Repeated partial returns therefore sum to the original invoice line
  amount without losing or creating a minor currency unit.
- Only sale lines tied to the original stock movements restore inventory.
  Older sales without reliable line-to-stock links remain eligible for a full
  return that restores their original stock legs. They cannot use line-level
  quantities.
- A prior credit without matching item-return history fails closed. The UI
  directs the cashier to accounting to resolve the existing credit before
  another POS return.
- Both full and item-level returns keep the existing always-human-approval
  gate, use the shared accounting posting capability, and preserve the
  original invoice and sale entry.

## Consequences

- `invoice_lines.item_id`, `pos_returns`, and `pos_return_lines` preserve the
  item and quantity provenance needed for safe repeat returns.
- POS return history is tenant-isolated. Database checks reject invalid
  quantities, amounts, and refund methods.
- Older return entries remain visible in the journal. Their item quantities
  are not inferred because prior stock-to-line links were not stored.
