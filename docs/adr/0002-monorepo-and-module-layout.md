# ADR 0002: Monorepo and module layout

## Status

Accepted

## Context

We need installable business modules, shared kernel contracts, and multiple
deployable processes (api, web, worker) without tight UI–domain coupling.

## Decision

Use a **pnpm + Turborepo monorepo**:

- `apps/*` — deployables
- `packages/*` — shared libraries
- `modules/*` — installable business modules

`apps/web` depends only on `@chaste/api-client` and `@chaste/ui-schema`.

## Consequences

- Clear dependency graph and CI caching
- Modules evolve independently under one version control root
- Enforced boundary: UI cannot import kernel/db
