# ADR 0055: Replay persisted observations without re-execution

## Status

Accepted

## Decision

Trajectory replay reconstructs the model-visible message stream from persisted
session events. Stored tool observations are returned as tool messages, while
no model, capability registry, permission check, or executor is invoked.
Corrupt sequence numbers or malformed tool observations fail closed rather
than being repaired with invented events.

## Consequence

Operators can inspect exactly what an agent saw after a run, including results
that are no longer readable under the viewer's current authority, without
creating a second business effect. Re-running a goal remains a separate,
explicit operation.
