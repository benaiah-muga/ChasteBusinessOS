# ADR 0004: HTTP API client boundary for frontends

## Status

Accepted

## Context

Tight coupling between Next.js and kernel/modules would block alternate clients
(mobile, third-party integrations) and blur security boundaries.

## Decision

- **`apps/web` consumes REST APIs only** via `@chaste/api-client`.
- Domain logic loads only in `apps/api` and `apps/worker`.
- Shared packages for the web are limited to DTOs and UI-part schemas.

## Consequences

- Loose coupling and multi-client readiness
- Extra network hop for web SSR (acceptable; can cache later)
- Review rule: reject PRs that import kernel/db into web
