# ADR 0059: Persist approved harness identity and inspect it by metadata

Status: accepted

## Context

The harness composition boundary now produces deterministic profile and
composition digests, but those identities only lived in the process. A
durable run or operator could not prove which approved profile and bundle set
it used, and persisting raw configuration would make inspection an accidental
secret-disclosure surface.

## Decision

Persist one immutable `harness_compositions` snapshot per organization and
composition digest. The snapshot stores the validated profile, bundle
manifests, configuration patches, and their profile/composition digests.
Registration is idempotent for the same organization and digest, and the
table is protected by the same tenant RLS contract as the rest of the ERP.

When a durable run opts into a composition, it must reference an existing
tenant-owned snapshot. The run also stores the profile id/version and
composition digest so the identity remains visible even if a future read
does not join the snapshot.

Inspection validates both stored digests and returns profile metadata, bundle
metadata, patch ids/versions, and configuration keys only. Patch values and
other configuration contents never cross the inspection boundary.

## Consequences

Runs can now be audited and later replay decisions can be made against an
explicit composition identity. The record is intentionally not a mutable
profile registry or a signed delivery mechanism; approval workflows and
profile-aware run orchestration remain separate follow-up decisions.
