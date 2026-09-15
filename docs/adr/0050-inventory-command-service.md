# ADR 0050: One inventory command service with item locks and count watermarks

Status: Accepted

Date: 2026-09-15

## Context

The stock ledger is append-only and on-hand is a derived sum, so nothing
stopped two writers from interleaving. Inventory's own commands —
adjustments, reservations, transfers, cycle counts — read on-hand, checked
it, and wrote, all without a lock. POS and purchasing inserted movement rows
directly, bypassing even the shared insert helper (the module-boundary lint
rule steered them there), and manufacturing checked availability unlocked
before consuming. Two concurrent commands could both pass the same check and
drive the balance negative. Lot IDs were accepted unvalidated: a lot of item
A could move item B's stock. And the cycle-count drift guard compared total
on-hand at post time against the snapshot, so a receipt plus a sale during
counting — net zero — silently validated a stale sheet.

## Decision

One command service (`modules/inventory/src/service.ts`) owns every quantity
change:

- **Ordered item locks.** Every writer locks the touched `items` rows in
  stable id order (`SELECT … FOR UPDATE`) before reading balances, so
  concurrent commands serialize instead of racing, and a fixed lock order
  cannot deadlock. POS, purchasing, sales, manufacturing, transfers, and
  inventory's own commands all converge on the same lock.
- **Guarded writes.** `applyStockDelta` re-checks the serialized state:
  a lot must belong to the item being moved, and the resulting on-hand may
  never go negative — org-wide, and at the movement's location when one is
  given — then appends the movement.
- **Count watermarks.** Each cycle-count line snapshots its item's movement
  count (`cycle_count_lines.expected_movement_count`). Posting refuses when
  the count has changed, even if net quantity landed back where it started:
  a variance must explain one stock state, not absorb whatever happened in
  between. A drifted sheet is refused permanently and can be cancelled; a
  fresh count posts cleanly.

The module boundary widens deliberately: POS and purchasing now import
`@chaste/module-inventory`'s command service, joining sales and
manufacturing as sanctioned consumers of the stock-ledger seam. A shared
invariant needs a shared owner; keeping them "decoupled" only produced
unchecked duplicates of the write path. The eslint boundary configuration
documents the exception.

Alternatives considered: database triggers or exclusion constraints on the
derived balance (rejects belong in the command service where the actor gets
a meaningful error and the audit trail records intent); a materialized
level table with row locks (an extra projection to keep true, when the
append-only sum under a row lock is already correct and replayable).

## Consequences

- Concurrent reserve/sell/transfer/produce operations can no longer produce
  impossible balances; the guarantee is enforced in one place rather than
  five copies of read-check-write.
- Cross-item lot movement fails loudly instead of corrupting lot genealogy.
- Cycle counts got stricter: sheets that would have posted under the old
  net-quantity comparison are now refused. Operators re-count after any
  intervening movement, which is the honest behavior.
- Valuation replay is untouched: the service preserves unit-cost
  pass-through and transfer legs stay value-neutral.

## Verification

Live-DB tests in `modules/inventory/src/service.test.ts` (lot binding,
negative guards, location-scoped transfers, a concurrent take-everything
race where exactly one command wins, watermark detection of net-zero
movement during counting). Manufacturing's cycle-count suite now asserts
the stricter semantics. `pnpm demo:m6` through `demo:m13` stock paths pass
against the migrated database (migration 0044).
