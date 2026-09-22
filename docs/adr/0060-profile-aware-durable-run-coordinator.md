# ADR 0060: Resolve approved profiles before creating durable runs

Status: accepted

## Context

Persisted composition identity is useful only if a durable run cannot silently
drift away from the approved runtime that it records. The current web adapter
can faithfully mount the Chaste ERP capability bridge, but it does not yet
mount arbitrary persisted bundles or configuration patches.

## Decision

Add a profile-aware durable-run coordinator that:

1. resolves the composition through the tenant-scoped persistence boundary;
2. validates an optional expected profile selector;
3. rejects compositions the current adapter cannot represent, including
   unknown bundles without an approved resolver;
4. mounts the existing `KernelExecutor` bridge using the persisted profile;
5. compares live profile/composition digests with the persisted record; and
6. creates the durable run only after those checks succeed.

The coordinator returns an explicit dispose function for the mounted runtime.
It does not create a second capability authority, mutate the persisted
composition, or claim that arbitrary future bundles are executable.

## Consequences

Every run started through this boundary is execution-ready and identity-pinned,
while unsupported composition shapes fail before a run row exists. ADR 0061
extends the adapter with explicit bundle resolvers and patch delivery without
changing this coordinator’s authority boundary; composition approval workflow
remains separate.
