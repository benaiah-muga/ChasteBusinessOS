# ADR 0003: Command layer and AI parity

## Status

Accepted

## Context

AI must operate the business without special privileges or parallel write paths.

## Decision

- All mutations go through a **command bus** with Zod schemas, permissions, and audit.
- HTTP command endpoints and AI tools both call `executeCommand`.
- Domain specialists are **profiles** over tool allowlists, not separate backends.

## Consequences

- Consistency and security by construction
- Slightly more ceremony for simple CRUD -- accepted for integrity
- Easier explainability and testing
