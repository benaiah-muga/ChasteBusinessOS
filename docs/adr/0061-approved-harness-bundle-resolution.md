# ADR 0061: Resolve approved harness bundles through explicit adapters

Status: accepted

## Context

The profile-aware coordinator initially mounted one hardcoded Chaste ERP bundle.
Persisted compositions already carried bundle manifests and configuration
patches, but arbitrary manifests could not be turned into lifecycle services
without weakening the fail-closed boundary or creating a second execution
authority.

## Decision

`createChasteHarness` accepts an explicit list of bundle resolvers. Each
resolver receives a persisted manifest and the existing profile, registry,
executor, and capability bridge context. It may return a matching
`HarnessBundle`; the adapter verifies that the returned manifest is byte-for-
byte canonical-equivalent to the persisted manifest before mounting it.

The built-in ERP bridge remains the default resolver. Additional bundles must
be registered by the caller, and an unknown manifest fails before runtime
creation. Persisted configuration patches are passed to the harness runtime;
inspection continues to expose only their keys. The coordinator passes the
resolver list through when it starts a durable run, so live and persisted
composition digests remain identical.

Resolvers provide lifecycle services only. They do not bypass the
`KernelExecutor`, mutate the registry, execute arbitrary source, or establish
a composition approval authority.

## Consequences

The adapter can grow through reviewable, testable bundle registrations while
remaining honest about what is executable. Approval state and arbitrary plugin
installation still need a separate governed workflow before they become
production inputs.
