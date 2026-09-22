# ADR 0063: Record controlled evolution release handoffs without executing Creator source

Status: accepted

## Context

The isolated Creator pipeline can produce a sanitized candidate in a detached
worktree and record independent verification evidence, but an `in_review`
proposal is not a releasable artifact. The enterprise evolution plan requires
an exact verified artifact to cross a human/CI boundary and a rollback drill,
while production must not gain source-write or package-install authority.

## Decision

Add a tenant-scoped `creator_evolution_releases` record with the proposal id,
candidate digest, immutable artifact reference, and lifecycle timestamps. The
Creator module exposes three capabilities:

- `creator.stageCandidate` validates an approved proposal's isolated-candidate
  evidence and records a `staged` handoff.
- `creator.promoteCandidate` conditionally advances the matching staged digest
  to `promoted`.
- `creator.rollbackCandidate` conditionally advances a matching staged or
  promoted digest to `rolled_back`.

All three actions use the existing kernel executor, policy engine, approvals
table, decision endpoint, audit ledger, and tenant scoping. The release row is
artifact metadata only: it does not contain or execute source, install a
package, mutate the production worktree, or imply that a signed manifest is a
safe executable plugin.

## Consequences

The exact-digest boundary and rollback state are now durable and testable, and
the approval inbox remains the single human authority. This establishes the
controlled-release seam needed for a later CI/canary adapter. Canary outcome
measurement, separate deployment principals, and executable tenant plugins
remain deliberately outside this slice.
