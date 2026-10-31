# ADR 0086: Replenishment planning is a read-only governed capability

Status: accepted

## Context

The M8 reorder demo called `buildReorderPlan` with supplied sample values and
then invoked purchasing. It proved the arithmetic and the governed write path,
but not that production planning gathers current demand, incoming supply,
reservations, and costs from live records. The advisory stock-reorder skill
also contained assumptions that no longer matched the Go runtime.

Models are good at choosing a tool and explaining its result. They are not a
reliable place to compute an order quantity, a safety buffer, or a commitment
cost. Those calculations need one deterministic implementation that humans,
Workmate, and routines all call.

The first workflow also needs a step that is safe to ship before the
proposal and commitment boundary is finished. A planning capability that
cannot create, reserve, or approve anything gives the workflow a real
deterministic core without widening authority.

## Decision

- Add `inventory.replenishmentPlan` as a read capability under the
  `inventory` module and the `inventory.read` permission.
- Read stock from the `stock_balances` projection, open reservations from
  `stock_reservations`, demand from net `sale` movements, incoming supply from
  open purchase-order lines, and cost from the latest recorded movement cost.
- Define demand as net `sale` movements, including returns, floored at zero
  per UTC day over the lookback window, and include zero-sale days in the
  standard deviation. Reservations reduce available stock; they are not
  counted again as demand.
- Define incoming supply with the purchasing close-check formula for orders
  in `ordered` or `partial`: order-line quantity minus accepted, minus
  rejected, plus returned. Returns reopen the supplier obligation and rejected
  goods count as delivered but unusable, so planning and order close agree.
- Use a configured lead time in this version, state that the value is
  configured rather than supplier-derived, and never invent a lead time from
  missing history.
- Use the configured reorder point as a floor when history exists and as the
  only signal when history is missing. A missing unit cost is reported as
  unknown, not as zero cost.
- Return action items by default, with a summary of evaluated, covered,
  sufficient, and history-insufficient items. The caller can request all items
  or one SKU.
- Expose the same closed input contract to Workmate and scheduled routines.
  The capability performs SELECTs only and never creates or reserves an order.

## Consequences

The inventory workflow now has a deterministic, auditable planning step that
can be tested against seeded live data and used in evaluation scenarios. The
planner is a point-in-time estimate, not a reservation: stock can change after
it returns. Supplier-derived lead times, transfers as an alternative, and
price comparison remain later work. The proposal and commitment boundary
still has to enforce authority before any order exists, and this capability
must never be treated as that authority.
