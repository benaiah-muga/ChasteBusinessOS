# ChasteBusinessOS

Agentic ERP. Every human action is also an AI-agent action through the same
capability pipeline — governed, auditable, reversible.

Read `ARCHITECTURE.md` first, then `ROADMAP.md`. Design decisions live in
`docs/adr/`; user-facing changes are recorded in `CHANGELOG.md`.

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

## Verification gate — run before declaring any work done

```sh
pnpm typecheck && pnpm lint && pnpm test
```

Live behavior proofs: `pnpm demo:slice`, `demo:m2`, `demo:m3`, `demo:m4`, `demo:m5`.
A change that breaks a demo is not done.

## For coding agents

- New capabilities must pass conformance (`assertWellFormedCapability`):
  valid `module.action` id, intent ≥ 20 chars (it gets embedded), and an
  inverse declared for state changes unless you can justify the warning.
  The registry self-validates at boot — broken inverses refuse to boot.
- Domain math lives in `packages/erp-core` as pure functions — keep IO out,
  and add property tests for financial invariants.
- No `any` without an adjacent eslint-disable comment explaining *why* the
  hole is unavoidable. `pnpm lint` fails on unexplained ones.
- Significant design decisions get an ADR (`docs/adr/`, next number, never
  delete old ones). If you argued for a choice that others will live with,
  write it down.
- Update `CHANGELOG.md` under `[Unreleased]` for every user-visible or
  behavioral change — Added/Changed/Fixed/Removed.
- Do not add comments explaining obvious code; explain *why*, not *what*.
