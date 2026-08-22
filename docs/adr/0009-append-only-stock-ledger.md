# ADR 0009 — Append-only stock ledger, GL integration deferred

Date: 2026-08-22 · Status: accepted

## Context
Selling and buying must move quantities somewhere trustworthy, but wiring
every movement to journal entries doubles the correctness surface before
valuation policy is settled.

## Decision
`stock_movements` mirrors the event-ledger discipline: append-only rows,
each with a reason (`purchase`, `sale`, `adjustment`, `production`), a
reference to its source document, and an actor. On-hand is always the derived
sum. All writers go through one shared `recordStockMovement` helper, so POS,
purchasing receipts, and manual adjustments land in one ledger.

GL integration (inventory asset account, COGS relief at sale) is deliberately
deferred until valuation policy is proven. Bills currently post to whatever
expense/inventory code their lines carry.

## Consequences
- Oversell is impossible: availability checks read the same ledger inside
  the same transaction as the sale.
- Stock quantities are operational truth today; financial inventory valuation
  is a future ADR.
