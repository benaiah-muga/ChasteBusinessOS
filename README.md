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

**Prerequisites:** Node.js 22+, pnpm 9+. PostgreSQL 16+ is recommended when you enable persistence (`DATABASE_URL`). Redis is optional until the worker/queue path is wired. Docker Compose is available if you prefer containers, but a system PostgreSQL install works fine.

```bash
pnpm install
cp .env.example .env
# Point DATABASE_URL at your local Postgres, e.g.:
# DATABASE_URL=postgres://chaste:chaste@localhost:5432/chaste
# Create the DB/user if needed, then:
# pnpm db:migrate

# Foundation demo API uses an in-memory store for customers (no DB required to try the UI)
pnpm --filter @chaste/api dev   # http://localhost:3001
pnpm --filter @chaste/web dev   # http://localhost:3000
# Or: pnpm dev  (turbo runs api + web + worker)
```

| Service | URL |
|---|---|
| Web | http://localhost:3000 |
| API | http://localhost:3001 |
| API health | http://localhost:3001/health |

Optional containers: `docker compose up -d` (Postgres + Redis). Default demo session is configured via `.env.example`.

## Design constraints

1. `apps/web` → HTTP → `apps/api` only  
2. Mutations → kernel commands (Zod + permissions + audit)  
3. AI tools wrap commands — never raw SQL  
4. Domain specialists are tool/profile scopes, not private backends  

## License

[Apache License 2.0](./LICENSE)

## Security

See [SECURITY.md](./SECURITY.md).
