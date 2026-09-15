# ADR 0049: Order-line budgets for receipts, returns, and bills

Status: Accepted

Date: 2026-09-15

## Context

Receiving treated each request row independently: nothing bounded a receipt
by the ordered quantity, so goods could arrive that were never ordered, and
service lines silently vanished from the receiving contract — a mixed or
service-only order could never reach `received`. A vendor bill validated
each line against the prior-bill allowance, so two references to the same
order line inside one bill each saw the full remaining quantity, and a bill
was accepted from any vendor regardless of who held the order. Returns were
bounded by net receipt history alone, so goods already shipped to customers
could be "returned" to the vendor, and a return left a fully-received order
claiming completion.

## Decision

Every command that moves quantity against a purchase-order line aggregates
its own demand per line first, then spends one budget — receipts, returns,
and in-bill references all consume the same per-line allowance within the
command, on top of what earlier committed commands already used. Receipts
refuse to exceed the ordered quantity; overreceipt needs an amended order,
not a bigger receipt. Service lines participate through an explicit accepted
milestone (`po_lines.service_accepted_thousandths`) instead of fake stock,
so mixed and service-only orders complete honestly. Vendor bills are only
valid from the order's vendor. Returns require the goods to still be on
hand — shipped goods need a customer return — and a return that drops a
line below its ordered quantity demotes the order from `received` back to
`partial`.

## Consequences

- The audit's N16 negatives hold by construction: no overreceipt, no
  overbilling within one bill, no foreign-vendor bills against an order, no
  returning consumed stock, and order status always reflects the goods.
- Service acceptance is visible on the order line, giving service POs a
  real completion state without inventing stock movements.
- Full receipt-header/line modeling (accepted/rejected/returned/remaining
  with explicit positions), receipt-quantity tolerance with authority, and
  returns linked to their original receipt remain the deeper N16 model.
