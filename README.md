# ChasteBusinessOS

**AI-native Business Operating System** for SMBs — modular, open source, and built for trust.

> AI is how you operate the business. Manual UIs remain available.  
> AI never bypasses business rules.

[Vision](./VISION.md) · [Architecture](./ARCHITECTURE.md) · [Contributing](./CONTRIBUTING.md) · [Agents](./AGENTS.md)

## Status

**Pre-alpha foundation.** Kernel contracts, HTTP API boundary, demo CRM vertical slice, and AI confirm-path scaffolding.

## Highlights

- **Single command bus** for humans and AI
- **Installable modules** (Odoo-inspired modularity)
- **HTTP-first clients** — web UI consumes REST APIs only (no tight coupling to kernel/DB)
- **Explainable AI actions** and autonomy levels (recommend → full autonomous with warnings)
- **Zod-validated** intents, commands, and generative chat UI parts
- **TypeScript + Node.js LTS**, PostgreSQL, Fastify, Next.js

## Monorepo

```
apps/api          HTTP API (Fastify) — domain entrypoint
apps/web          Next.js — consumes API over HTTP only
apps/worker       Outbox & background jobs
packages/kernel   Commands, authz, audit, modules
packages/db       Drizzle schema & migrations
packages/ai-core  Orchestrator, autonomy, explanations
packages/ui-schema  Generative UI part schemas
packages/api-client Typed HTTP client + DTOs for frontends
modules/*         Business modules (e.g. demo-crm)
```

## Quick start

**Prerequisites:** Node.js 22+, pnpm 9+, **PostgreSQL** (system install is fine). Redis optional for later queue scale-out.

```bash
pnpm install
cp .env.example .env
# Edit DATABASE_URL for your local Postgres, e.g.:
# DATABASE_URL=postgres://$USER@/chaste?host=/var/run/postgresql
createdb chaste   # if needed
pnpm db:migrate
pnpm --filter @chaste/api dev   # http://localhost:3001
pnpm --filter @chaste/web dev   # http://localhost:3000
pnpm e2e                        # full API + Postgres verification
```

| Service | URL |
|---|---|
| Web | http://localhost:3000 |
| API | http://localhost:3001 |
| API health | http://localhost:3001/health |

Configuration & secrets: [docs/configuration.md](./docs/configuration.md).

## Design constraints

1. `apps/web` → HTTP → `apps/api` only  
2. Mutations → kernel commands (Zod + permissions + audit)  
3. AI tools wrap commands — never raw SQL  
4. Domain specialists are tool/profile scopes, not private backends  

## License

[Apache License 2.0](./LICENSE)

## Security

See [SECURITY.md](./SECURITY.md).
