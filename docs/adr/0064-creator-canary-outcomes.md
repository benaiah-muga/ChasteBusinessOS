# ADR 0064: Record Creator canary outcomes as release evidence

Status: accepted

## Context

The controlled Creator release handoff can stage, promote, and roll back an
exact isolated-candidate digest, but a promoted artifact needs an explicit
measurement seam before a later deployment adapter can be trusted. The
measurement must remain tied to the capability gap that motivated the
candidate, and it must not silently become production deployment authority.

## Decision

Persist the originating `capability_gap` ticket on Creator proposals and
releases. A promoted release may receive one `canary` outcome through the
`creator.recordCanaryOutcome` capability, which requires the distinct
`platform.creator.release` permission and records the exact release digest,
gap ticket, pass/fail verdict, evidence reference, and small scalar metrics.

The capability rejects outcomes for a different ticket, digest, or release
state. Pass and fail are durable evidence only: recording either verdict does
not promote, roll back, install, or execute the artifact. A future deployment
adapter must remain a separate authority and may consume this evidence only
through an explicitly governed contract.

## Consequences

Creator evolution now has a durable link from capability gap to candidate to
canary evidence, with a release-only principal boundary and fail-closed
identity checks. The runtime can prove both successful and failed observations
without pretending that it has a production deployer. Automatic rollback,
deployment orchestration, and executable tenant plugins remain future gaps.
