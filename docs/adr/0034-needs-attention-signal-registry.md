# ADR 0034, Needs-attention signal registry

Date: 2026-08-31 · Status: accepted

## Context

Every app grew its own "needs attention" list: the home dashboard derives a
needs-you queue, inventory shows reorder alerts, accounting shows aging,
CRM shows stalled deals. Four copies of the same idea, four places to
forget one. The owner-facing product goal is one answer to "what needs me?",
everywhere, with the arithmetic behind it.

## Decision

A shared signal contract in the kernel (`kernel/signals.ts`):

    { id, severity: red|orange|green, module, subject, detail,
      evidence?: { refType, refId }, suggestedAction?: { capabilityId, inputDraft } }

- **Producers are per-module functions** (`collect*Signals`), deterministic
  over live data. No model in the compute path — thresholds and arithmetic
  live in module or erp-core code.
- **Composition happens at the app layer**: `buildRegistry` injects the
  producers of whatever modules the process composes into
  `modules/signals`, whose read capability `signals.list` aggregates,
  filters, sorts (red first), and de-duplicates. Modules never import each
  other for signals.
- **A failing producer degrades to missing signals**, never a broken feed.
- **Invalid shapes are filtered** by a structural guard; one bad producer
  cannot poison the list.
- **Signals are advisory**: a suggestedAction names a governed capability
  with a draft input; execution still flows through policy, approvals, and
  the ledger like any human action.
- Consumers: `/api/signals` (the feed), the home dashboard's needs-you
  queue, and — via the same read capability — the agent and routines.

Inventory ships the first producers (reorder pressure, dead stock,
anomalous adjustments), accounting adds overdue receivables, CRM adds
stalled deals.

## Consequences

- New modules become visible to the owner by registering one producer.
- Thresholds are per-module code for now; moving them into org policy is a
  natural follow-up when routines tune themselves (ADR 0031 territory).
- Coverage honesty: a module without a producer contributes nothing rather
  than pretending; the dashboard shows what exists.
