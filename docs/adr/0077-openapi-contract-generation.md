# ADR 0077: Generate Go and TypeScript models from OpenAPI

Date: 2026-09-28
Status: accepted for the React and Go migration

## Context

The migration requires versioned HTTP contracts shared by the Go business API
and React clients. Mirroring response interfaces by hand allows field names,
required fields, and status behavior to drift. The private Go policy read is a
small existing boundary with stable response semantics and signed session
assertions.

## Decision

- Define each migrated HTTP contract in OpenAPI 3.1 and generate Go and
  TypeScript models from that source.
- Pin the generators, commit their outputs, and check generated output for
  drift in CI.
- Keep runtime validation at untrusted TypeScript and Go boundaries. Generated
  types do not replace Zod parsing, assertion verification, or Go input
  validation.
- Keep the signed session assertion protocol separate from ordinary HTTP DTOs;
  describe the assertion as a required header security scheme.
- Add existing endpoints to the versioned contract without changing their
  paths. Expand coverage incrementally as Go endpoints become part of the
  migration.
- Preserve open-ended JSON fields explicitly when the existing API allows
  arbitrary JSON values.

## Consequences

The contract toolchain adds pinned development dependencies in both workspaces.
Generated files are reviewable source artifacts, and the drift check catches
stale bindings. Existing endpoint paths, JSON field names, response statuses,
and authentication behavior remain the compatibility contract. The first
versioned spec covers only the Go policy read; the remaining internal and
public APIs must be added before migration cutover.
