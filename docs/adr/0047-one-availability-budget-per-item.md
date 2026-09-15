# ADR 0047: One availability budget per item identity, serialized on item rows

Status: Accepted

Date: 2026-09-15

## Context

Stock checking was per line, per reader. `sales.confirmOrder` re-read the
same availability for every line, so two order lines for the same item could
each claim the same stock (7 + 7 against 10 reserved 14), and the register
checked raw on-hand per line with the same shape. Nothing serialized readers
either: two concurrent orders — or an order and a register sale — could both
read the last unit as available, and the register did not see reservations at
all, so stock promised to a confirmed order was still sellable over the
counter.

## Decision

Every stock check aggregates demand by item identity first, then spends one
running availability budget per item, allocating back to the stable
`salesOrderLines.id` order. Availability means on hand minus open
reservations everywhere that sells stock: sales-order confirmation and the
register share the definition. Before checking, readers lock the touched
item rows (`SELECT … FOR UPDATE`) in ascending id order, so concurrent
orders, registers, and modules serialize on the same rows without deadlock;
whoever commits first owns the stock, and the loser re-reads the budget
inside its own transaction and refuses (or backorders, where the caller
asked for partial).

## Consequences

- The audit's N15 scenario is impossible by construction: repeated lines
  7 + 7 against 10 reserve at most 10, and per-line reservations reconcile
  to the aggregate budget.
- A sale refused mid-order leaves nothing behind: the check runs before any
  posting or movement write.
- POS now honors sales-order reservations; stock promised elsewhere is not
  sellable at the register. Register error messages state the available
  budget so a cashier sees what is actually left.
- Locking is row-level on `items` and scoped to the identities a command
  touches; unrelated items and unrelated tenants never contend. Aggregate
  consistency for locations/lots and cycle counts (N22) remains follow-up
  work on the shared inventory command service.
