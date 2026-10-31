# ADR 0085: Creator Mode scaffolds Go capability artifacts

Status: accepted

## Context

Creator Mode's `creator.scaffoldCapability` generated a TypeScript capability
module under `modules/<module>/src/`, a Vitest skeleton, and a risk document.
That design predates the runtime cutover: the Go capability executor now owns
every capability, the TypeScript kernel and module packages are retired in the
same change set, and a scaffold that imports `@chaste/kernel` or
`modules/<module>` shows reviewers a file that can never be wired into the
running product. A proposal whose generated source is dead on arrival is worse
than no scaffold, because it reads as executable evidence.

## Decision

- Render the scaffold as Go artifacts in the Go capability package:
  `apps/api/internal/capability/generated_<module>_<action>.go` for the
  capability and the matching `_test.go` skeleton, plus the existing
  `docs/proposals/<module>-<action>-risk.md` risk document.
- The generated file contains the capability id constant, a
  `capabilitySpec` entry function, a typed input struct with JSON tags, a
  `Parse<Name>Input` function that reuses the package's existing validation
  helpers, and a handler stub that returns an explicit not-implemented error.
  A header comment lists the three wiring points the reviewer must complete:
  the spec table in `executor.go`, the input dispatch, and the handler switch.
- Format rendered Go with `go/format` and validate it in tests with
  `go/parser`, so a scaffold that cannot compile fails the renderer test
  rather than reaching a proposal.
- Keep the risk document's structure, restated in Go terms
  (`claims.OrganizationID` org scoping, integer minor units for money).

## Consequences

Generated proposals now point at the package that actually executes
capabilities, and reviewers see the exact wiring deltas a merge needs. The
renderer no longer mirrors the TypeScript module layout, so the retired
`modules/*` tree has no remaining consumer. The scaffold remains advisory:
wiring is manual and human-reviewed, and the handler stub refuses to run until
implemented.
