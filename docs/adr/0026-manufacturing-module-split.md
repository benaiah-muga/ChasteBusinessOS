# ADR 0026: Manufacturing module split and full production lifecycle

Date: 2026-08-24
Status: Accepted

## Context

Manufacturing began as "BOM-lite" folded into the inventory module: three
capabilities (`defineBom`, `produceFromBom`, `bomReport`) over a flat
component list. That was honest about scope but conflated two concerns that
organizations govern differently — stock custody (what do we have, where,
counted how) and transformation (what do we build, in what order, at what
cost). It also had a real correctness gap: `produceFromBom`'s declared
inverse only reversed the finished-goods side of a run, leaving consumed
components permanently gone.

## Decisions

### 1. Separate modules, one ledger

`modules/manufacturing` becomes its own workspace package with its own
capability namespace (`manufacturing.*`), permissions
(`manufacturing.read/write`), module toggle, nav entry, and UI page. It does
**not** keep its own stock records: every quantity change it causes flows
through `@chaste/module-inventory`'s exported ledger primitives
(`recordStockMovement`, `stockOnHand`, `getOrCreateLot`). One append-only
stock ledger, many writers — the same discipline as the shared GL posting
service (ADR 0020). The split is along governance seams, not data seams.

### 2. Work orders as governed plans

Production moves from one instantaneous click to a lifecycle:
`createWorkOrder` (draft, validates BOM + yield) → `releaseWorkOrder`
(refuses when exploded requirements incl. scrap are short) →
`completeWorkOrder` (posts consumption + finished goods atomically; money-
class gated like any valuation-moving write via policy) → terminal
`completed`/`cancelled`. Partial completions are allowed; over-completion is
refused by availability checks.

### 3. Reversal mirrors reality, not intentions

`manufacturing.reverseProductionRun` takes a run reference and posts exact
opposite movements for everything the run wrote — components return at their
recorded unit costs, finished units leave. It refuses double reversal
(idempotency via `production_reversal` marker movements) and refuses to drive
stock negative. Inverses that would silently revalue (re-running produce at
today's moving average) were rejected on purpose.

### 4. Scrap, yield, lots, locations

BOM lines carry per-component scrap allowances (ceil-rounded so fractional
parts never understate demand); work orders carry expected yield for planning
previews. Movements optionally carry lot and location references; production
outputs can be tagged with a lot code, and `manufacturing.lotTrace` walks the
consumption graph upstream through work-order references for recall tracing.
Cycle counts snapshot expected quantities at open time and refuse to post if
stock moved since the snapshot — variance must never absorb unrelated
movement.

### 5. Consequences

- Existing orgs with explicit `enabled_modules` lists must add
  `"manufacturing"` to keep the page visible (null = all modules keeps
  working).
- Cross-module inverses remain legal; today all manufacturing inverses stay
  intra-module.
- The inventory page narrows honestly to stock custody: items, movements,
  reservations, counting, locations, lots.

