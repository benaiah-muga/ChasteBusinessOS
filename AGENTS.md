# ChasteBusinessOS

Agentic ERP. Every human action is also an AI-agent action through the same
capability pipeline — governed, auditable, reversible.

Read `ARCHITECTURE.md` first, then `ROADMAP.md`.

## Quick start

```sh
pnpm install
cp .env.example .env        # fill NVIDIA_API_KEY + BETTER_AUTH_SECRET
docker start chaste-pgvector
turbo db:migrate            # from packages/db
pnpm dev                    # apps/web on :3000
```

## Conventions

- TypeScript strict everywhere; Zod for all boundaries.
- All state changes go through kernel capabilities (`packages/kernel`).
- Money = integer minor units; posted financial documents are immutable.
- Append-only event ledger; hash-chained audit entries.
- Never commit secrets. `.env` is gitignored.

## For coding agents

- Run `pnpm typecheck && pnpm test` before declaring work done.
- Domain math lives in `packages/erp-core` as pure functions — keep IO out.
- New capabilities must declare: risk class, permission ref, inverse (if state-changing),
  zod schemas, and a natural-language `intent` (it gets embedded for retrieval).
- Do not add comments explaining obvious code; explain *why*, not *what*.
