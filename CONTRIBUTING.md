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

### Stacked pull requests

Large milestones ship as a chain of PRs, one per milestone, each branching off
the one below it. A stacked PR is **not** independently reviewable: its diff is
the delta against its parent branch, not against `main`.

Rules that keep a stack from rotting:

- **Declare the stack.** In every PR body, list the full chain bottom-up and say
  which one is the base, e.g. `main <- os-phase3 <- m7 <- m8 (this PR)`.
- **Merge bottom-up, never out of order.** Merging a middle PR first silently
  reparents everything above it.
- **Re-sync after the PR below you lands.** Merge or rebase the new base into
  your branch and re-run `pnpm lint && pnpm typecheck && pnpm test` before
  asking for review.
- **`pnpm-lock.yaml` must be regenerated, never hand-edited.** If you add or
  bump a workspace dependency, run `pnpm install` and commit the lockfile in
  the same PR. CI installs with `--frozen-lockfile` and will fail otherwise.
- **CI passing on your branch does not mean `main` will pass.** Each PR is
  verified against its own parent; only the tip of the stack reflects the final
  combined state.

If a stack has drifted, the fix is to rebuild it as a true linear chain
(each branch's parent is the previous branch) rather than merging siblings
together at the end.

## Commit style

Prefer [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`

## Module contributions

See [docs/module-development.md](./docs/module-development.md).

## Security

See [SECURITY.md](./SECURITY.md). Never open public issues for vulnerabilities.
