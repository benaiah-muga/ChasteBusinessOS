# ChasteBusinessOS

Agentic ERP. Every human action is also an AI-agent action through the same
capability pipeline, governed, auditable, reversible.

The target runtime is a React app built with Vite and Go business APIs and
workers. During the migration, use the active commands documented in
[README.md](README.md) and the [migration plan](docs/REACT_GO_MIGRATION_PLAN.md).

Read `ARCHITECTURE.md` first, then `ROADMAP.md`. Design decisions live in
`docs/adr/`; user-facing changes are recorded in `CHANGELOG.md`.

## Quick start

```sh
pnpm install
cp .env.example .env        # fill NVIDIA_API_KEY + BETTER_AUTH_SECRET; generate GO_INTERNAL_AUTH_SECRET
docker start chaste-pgvector
pnpm --filter @chaste/db db:migrate
pnpm dev                    # Vite React app on :3000 and legacy compatibility app on :3001
# In another terminal, run the Go API on :8080: pnpm dev:api
```

## Conventions

- TypeScript strict in the React app; Go for business APIs and workers.
- Define API contracts once and generate TypeScript and Go types from them.
- Validate untrusted input at runtime at every API, database, and agent-tool boundary.
- All state changes go through the governed capability kernel. Human, agent,
  and worker actions use the same execution path.
- Money = integer minor units; posted financial documents are immutable.
- Append-only event ledger; hash-chained audit entries.
- Keep domain math pure and add property tests for financial invariants.
- Never commit secrets. `.env` is gitignored.

## Verification gate, run before declaring any work done

```sh
pnpm typecheck && pnpm lint && pnpm test
pnpm go:verify
```

During the migration, run checks for each language and app that exists in the
change. Keep the full gate above once the Go workspace is present.

Live behavior proofs - one per milestone, each an executable specification:
`demo:slice`, `demo:m2`, `demo:m3`, `demo:m4`, `demo:m4b`, `demo:m5`,
`demo:m6`, `demo:support`, `demo:m7` … `demo:m13`. See the list in
[README.md](README.md#demo-proofs). A change that breaks a demo is not done.

Every demo needs a migrated database; several also drive the real agent and
so need a provider key. CI skips the set when no key is configured, so a
missing key shows up as a skipped job rather than a failure - run them
locally before claiming a milestone works.

## For coding agents

- **Never write em dashes (the U+2014 character) anywhere**: not in code,
  comments, docs, UI copy, commit messages, or PR descriptions. Use commas,
  colons, parentheses, or plain hyphens instead.
- New capabilities must pass conformance (`assertWellFormedCapability`):
  valid `module.action` id, intent ≥ 20 chars (it gets embedded), and an
  inverse declared for state changes unless you can justify the warning.
  The registry self-validates at boot, broken inverses refuse to boot.
- Keep domain math in pure domain packages, keep IO out, and add property
  tests for financial invariants.
- Go org-scoped queries must run through `internal/dbx.WithOrgTx`, which sets
  `app.org_id` transaction-locally for PostgreSQL RLS.
- In TypeScript, do not use `any` without an adjacent eslint-disable comment
  explaining *why* the hole is unavoidable. `pnpm lint` fails on unexplained
  uses.
- Significant design decisions get an ADR (`docs/adr/`, next number, never
  delete old ones). If you argued for a choice that others will live with,
  write it down.
- Update `CHANGELOG.md` under `[Unreleased]` for every user-visible or
  behavioral change, Added/Changed/Fixed/Removed.
- Adding or bumping a workspace dependency means committing a **regenerated**
  `pnpm-lock.yaml` in the same change. CI installs with `--frozen-lockfile`,
  so a stale lockfile fails before lint, typecheck or tests ever run - which
  means it also hides real errors until it is fixed. Never hand-edit it.
- Do not add comments explaining obvious code; explain *why*, not *what*.

## Frontend runtime checks

After a UI change, start the active app using the command in `README.md` and
open the affected route in the in-app browser. Confirm the route loads, the
changed interaction works, and there are no new browser console or request
errors. If the in-app browser is unavailable, leave the runtime gate open and
report that limitation. Run a focused browser check for the changed flow, then
run the verification gate above.

## Performance work

Measure startup, edit-to-ready, production build, and representative browser
navigation before optimizing. Report frontend and Go build times separately.
Use repeatable runs on the same machine and data, and guard improvements with
the existing behavior proofs and browser checks.

<!-- graft:start -->
## Graft - repo context graph

This repo is indexed in `graft/`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here - understanding how something works, finding where code lives,
or scoping a change - get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run `graft map` first - a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run `graft ask "<your question>" --source` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; `--full` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer - cite its
  `covers:` file:line spans and edit straight from `--source`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete - run `graft grep "<literal>"` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw `grep -rn` only for unindexed files.
- `graft skeleton <file>` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- `graft callers <symbol>` gives precomputed, exact edges - who calls this.
  Add `--direction out` for what it calls, or `--depth N` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: `graft/INDEX.md` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects -
  hits carry `[scope/]` labels naming which one they're from. Narrow with
  `graft ask "<task>" --in <scope>/` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to - never
re-read whole files.

After big code changes, refresh the graph with `graft build` (deterministic,
no API key, $0).
<!-- graft:end -->
