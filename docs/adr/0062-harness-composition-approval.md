# ADR 0062: Govern harness composition approval through the existing approval path

Status: accepted

## Context

Persisted harness compositions now have stable tenant-scoped identities and
explicit bundle resolvers. A durable run must not treat persistence as
authorization, but adding a second approval table or policy engine would split
the system's authority and make the existing approval inbox incomplete.

## Decision

Register `harness.approveComposition` in the existing capability registry with
identity risk and the `harness.approve` permission. Its payload contains only
the tenant composition id and its exact 64-character composition digest.

Composition requests go through the existing `KernelExecutor` and `approvals`
table. Requests are idempotent for pending, executing, and executed approvals;
rejected or expired requests can be raised again. Human decisions go through
the existing `decideApproval` transition, including the existing permission
check, atomic claim, audit entry, and execution finalization.

The profile-aware durable coordinator requires an executed approval whose id,
tenant, composition id, and digest all match the persisted snapshot. Any
missing, rejected, cross-tenant, stale, or mismatched approval fails before
runtime mounting or durable-run creation.

## Consequences

The approval inbox and decision authority remain unified with every other
governed capability. Composition approval is visible and auditable through the
same ledger and status lifecycle, with no schema migration or parallel policy
engine. Arbitrary plugin installation and capability expansion remain separate
gaps; approval authorizes an immutable known composition, not new executable
source.
