# Contributing to ChasteBusinessOS

Thank you for helping build an AI-native Business OS that prioritizes integrity,
modularity, and trust.

## Before you start

1. Read [VISION.md](./VISION.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).
2. Follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
3. If you are an AI coding agent, also read [AGENTS.md](./AGENTS.md).

## Development setup

Requirements:

- Node.js 22+ (LTS preferred; CI targets current LTS)
- pnpm 9+
- Docker (PostgreSQL + Redis)

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm db:migrate
pnpm dev
```

- API: `http://localhost:3001`
- Web: `http://localhost:3000` (talks to the API over HTTP only)

## Project layout

| Path | Role |
|---|---|
| `apps/api` | HTTP API gateway (only process that loads kernel + modules for requests) |
| `apps/web` | Next.js UI -- **consumes REST APIs only** (no kernel/db imports) |
| `apps/worker` | Outbox, jobs, async AI workflows |
| `packages/*` | Shared libraries (kernel, db, ai-core, schemas, api-client) |
| `modules/*` | Installable business modules |
| `docs/` | Architecture, ADRs, module rules |
| `skills/` | Agent skills for contributors |

## Coupling rules (enforced by review)

- **`apps/web` must not import** `@chaste/kernel`, `@chaste/db`, `@chaste/ai-core`, or module packages.
- Web may import **`@chaste/api-client`** and **`@chaste/ui-schema`** (HTTP types + generative UI schemas only).
- Business mutations live in **commands**; AI tools wrap commands -- never raw SQL.
- Modules do not reach into other modules’ private tables.

## Pull requests

1. Create a focused branch.
2. Add/adjust tests for behavioral changes.
3. Run `pnpm lint && pnpm typecheck && pnpm test`.
4. Fill out the PR template.
5. Link an issue when applicable.
6. For architectural changes, add or update an ADR.

## Commit style

Prefer [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`

## Module contributions

See [docs/module-development.md](./docs/module-development.md).

## Security

See [SECURITY.md](./SECURITY.md). Never open public issues for vulnerabilities.
