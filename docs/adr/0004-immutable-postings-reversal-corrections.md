# ADR 0004, Posted financial documents are immutable; corrections are reversals

Date: 2026-08-21 · Status: accepted

## Context
Editing posted entries destroys audit trails. Classic ERP answer: reversal
entries.

## Decision
Journal entries are never modified or deleted. `accounting.reverseEntry`
posts an exact mirror (swapping debits/credits) referencing `reversalOfId`.
Reversals of reversals are blocked. Reversal risk class is `money`, so large
corrections hit approval gates.

## Consequences
- Books stay balanced by construction; trial balance proves it continuously.
- The balance sheet reports `balanced: false` if the ledger is ever corrupt,
  visible, not silent.
