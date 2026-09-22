# ADR 0058: Harness composition stays above the capability kernel

Status: accepted

## Context

The Cordis-like plan calls for profiles, bundles, services, lifecycle events,
and runtime inspection, but the ERP already has a working capability registry
and `KernelExecutor`. A second execution path would split policy, approvals,
receipts, inverses, audit, and tenant/module checks.

## Decision

Add `@chaste/harness` as a pure composition boundary above the kernel. It owns:

- validated, versioned environment profiles with fail-closed authority rules;
- ordered bundle and configuration-patch manifests with deterministic digests;
- dependency-ordered service mounting, reverse unmounting, rollback on partial
  mount failure, and live runtime events;
- inspection that exposes profile metadata and service/config keys without
  returning configuration values or secrets.

The capability bridge may discover capabilities from a scoped registry, but its
`execute` method delegates only to a supplied `KernelExecutor`. It does not
call a capability's implementation directly. The web adapter composes the
existing `composeRegistry` and `buildExecutor` into this boundary.

Profiles are declarative authority descriptions, not a sandbox. In particular,
`erp-prod`, `erp-review`, and `erp-worker` reject source writes, process launch,
code execution, and registry mutation. A future Creator worker still needs the
separate isolated sandbox and verifier controls already specified by ADR 0057.

## Consequences

This gives the runtime a Cordis-like mount/recompose seam without changing the
ERP's authority model. Runtime events are currently live process events; durable
facts continue to be recorded by the existing run, receipt, and event-ledger
paths. Profile persistence, signed profile delivery, and UI inspection remain
follow-up work and are not implied by this adapter.

The composition digest can be pinned by later durable runs and replay records,
so a profile change becomes an explicit compatibility decision rather than a
silent change in agent behavior.
