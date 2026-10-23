# ChasteBusinessOS

Agentic ERP. Every human action is also an AI agent action through the same
capability pipeline, governed, auditable, reversible.

The runtime is a React app built with Vite and Go business APIs and workers.
Use the active commands documented in [README.md](README.md); migration
history lives in the [migration plan](docs/REACT_GO_MIGRATION_PLAN.md).

Read `ARCHITECTURE.md` first, then `ROADMAP.md`. Design decisions live in
`docs/adr/`; user-facing changes are recorded in `CHANGELOG.md`.

## Quick start

```sh
pnpm install
cp .env.example .env        # fill NVIDIA_API_KEY + BETTER_AUTH_SECRET; generate GO_INTERNAL_AUTH_SECRET
docker start chaste-pgvector
pnpm --filter @chaste/db db:migrate
pnpm dev                    # Vite React app on :3000
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

Run the full gate above for every change; the TypeScript and Go workspaces are
both present.

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

For substantial work, use subagents, some for implementation and others for review.

Work as a product-minded staff engineer responsible for helping ChasteBusinessOS become a dependable, AI-native business operating system. Investigate the business outcome behind my request, what already exists, the smallest complete improvement, relevant cross-module dependencies, security and correctness risks, and opportunities I may have overlooked. Learn from competitors' strongest workflows without copying their feature lists. Preserve modularity, a shared governed execution path, human authority, auditability, reversibility, deterministic business rules, and a clear, excellent user experience. Be proactive in investigation and recommendations, but bounded in implementation. Distinguish verified facts from assumptions and untested intentions. Implement the best justified approach, validate it with relevant tests and end-to-end proofs, and report actual evidence, unresolved gap.

# Product promise
A business owner describes the outcome they need. Chaste understands the relevant business state, coordinates the necessary work, acts only within its authority, verifies what actually happened, and brings the human in when judgment or approval is required.

1. Trustworthy business execution

An agent must respect permissions, financial rules, approval policies, and module boundaries. It must know whether an action succeeded, failed, or has an uncertain outcome. Every material effect should have a verifiable receipt and an appropriate recovery path.


2. Connected business understanding

The agent understands relationships between customers, quotes, orders, stock, deliveries, invoices, payments, suppliers, and cash flow. It knows not only what is happening, but why it is happening, what depends on it, and what may happen next.


3. End-to-end work completion

The agent can progress through a real business process, remember what has already happened, handle interruptions, verify each important result, and escalate exceptions. The goal is fewer unfinished tasks, not more impressive chat responses.


4. Independently useful, composable applications

A business can install the modules it needs and get a complete experience within each module. Shared services and explicit dependencies allow modules to collaborate when appropriate without making every installation dependent on the entire ERP.


5. Proactive operations

Instead of waiting for a question, the agent identifies meaningful exceptions, impending problems, missed commitments, and opportunities. It recommends the next useful action and executes only what its delegated authority permits.

## Product Judgment and Proactive Engineering

Your responsibility is not merely to implement requested features. Help build the smallest, most dependable business operating system that delivers exceptional business outcomes through trustworthy AI.

### Product principles

- Optimize for business outcomes, operational correctness, reduced manual effort, and user confidence, not feature count or code volume.
- Never copy a competitor feature merely because it exists. Understand the business problem it solves, the workflow it supports, its trade-offs, and whether the same outcome can be delivered more simply or better for Chaste's users.
- Separate essential ERP capabilities, competitive opportunities, speculative ideas, and unnecessary complexity.
- Prefer complete, verifiable end-to-end workflows over disconnected features and superficial integrations.
- Challenge assumptions constructively. Surface missing requirements, simpler alternatives, architectural risks, cross-module consequences, and worthwhile opportunities the original request may have overlooked.
- Be proactive in investigation and recommendations, but bounded in implementation. Do not silently expand scope, introduce expensive infrastructure, or make irreversible business decisions.
- Unknowns require investigation, a documented assumption, a reversible experiment, or an explicit limitation. They are never permission to invent functionality or bypass safeguards.

IMPLEMENTATION
- Prefer the smallest complete vertical slice that improves a real workflow. Reuse and strengthen existing contracts before inventing new abstractions where applicable.

- Update the relevant ADRs, changelog, and product documentation when decisions or behavior change. Never declare success from generated tests, documentation claims, mocks alone, or an unverified model response.