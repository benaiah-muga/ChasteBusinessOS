# ADR 0002 — Append-only, hash-chained event ledger

Date: 2026-08-21 · Status: accepted

## Context
Enterprise trust requires tamper-evident history of everything the system
(and its agents) did. Post-hoc logging can be edited.

## Decision
All consequential events land in `ledger_events`: append-only, each row
hashing the previous (`sha256(prevHash + entry)`), written through
`LedgerStore`. No UPDATE/DELETE path exists in application code.

## Consequences
- Auditors can verify integrity independently.
- Corrections are new compensating events, never edits.
- Per-org chain tail lookup is O(1) via seq ordering; writes serialize on the chain.
