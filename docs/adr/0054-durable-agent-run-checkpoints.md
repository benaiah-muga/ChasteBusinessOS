# ADR 0054: Durable agent runs checkpoint through the governed queue

## Status

Accepted

## Context

The capability kernel already makes individual effects idempotent through
intent-keyed action receipts, and the worker queue already fences expired
leases. An agent task still needs a durable identity that connects its goal,
version-pinned steps, approvals, queue delivery, and receipt after a process
dies between effect commit and acknowledgement.

## Decision

Persist an `agent_runs` row and unique `(run_id, step_index)` checkpoints.
Queue rows may reference a run step and an approval. The worker records the
step as running before invoking the kernel and committed after the governed
result, linking the receipt row by the queue intent. A redelivery keeps the
same queue intent, so the kernel returns the stored receipt instead of
executing the business capability again. Run completion remains an explicit
coordinator transition, allowing multi-step runs to add later checkpoints.

## Consequences

- A crashed worker can be replaced without duplicating a purchase order or
  losing the approval handoff.
- Step inputs and registry versions are durable evidence for later replay.
- Multi-step orchestration must explicitly mark the run completed after its
  final checkpoint; a successful queue row alone does not imply the whole goal
  is complete.
- Existing non-durable jobs remain compatible because the run linkage is
  nullable.
