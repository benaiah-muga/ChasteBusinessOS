# ChasteBusinessOS

Agentic ERP. Every human action is also an AI-agent action through the same
capability pipeline, governed, auditable, reversible.

Read `ARCHITECTURE.md` first, then `ROADMAP.md`. Design decisions live in
`docs/adr/`; user-facing changes are recorded in `CHANGELOG.md`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

In this monorepo the bundled docs resolve to **`apps/web/node_modules/next/dist/docs/`** (Next.js lives in `apps/web`).

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

## Verification gate, run before declaring any work done

```sh
pnpm typecheck && pnpm lint && pnpm test
```

Live behavior proofs: `pnpm demo:slice`, `demo:m2`, `demo:m3`, `demo:m4`, `demo:m4b`, `demo:m5`.
A change that breaks a demo is not done.

## For coding agents

- New capabilities must pass conformance (`assertWellFormedCapability`):
  valid `module.action` id, intent ≥ 20 chars (it gets embedded), and an
  inverse declared for state changes unless you can justify the warning.
  The registry self-validates at boot, broken inverses refuse to boot.
- Domain math lives in `packages/erp-core` as pure functions, keep IO out,
  and add property tests for financial invariants.
- No `any` without an adjacent eslint-disable comment explaining *why* the
  hole is unavoidable. `pnpm lint` fails on unexplained ones.
- Significant design decisions get an ADR (`docs/adr/`, next number, never
  delete old ones). If you argued for a choice that others will live with,
  write it down.
- Update `CHANGELOG.md` under `[Unreleased]` for every user-visible or
  behavioral change, Added/Changed/Fixed/Removed.
- Do not add comments explaining obvious code; explain *why*, not *what*.

## Next.js 16.3 agent tooling (`apps/web`)

The web app runs Next.js **16.3** with version-matched docs bundled inside
the package. Never trust training-data Next.js knowledge for this app;
consult these first:

### Bundled docs (version-accurate, offline)

```
apps/web/node_modules/next/dist/docs/
├── 01-app/01-getting-started/
├── 01-app/02-guides/          # ai-agents.md, mcp.md, caching, instant-navigation, …
├── 01-app/03-api-reference/
└── index.md
```

Start with `01-app/02-guides/upgrading/version-16.md` before touching code
written against older Next.js. The same docs are online as Markdown: append
`.md` to any nextjs.org/docs URL; `/docs/messages/*` error pages are written
for agents and are not bundled.

### Runtime visibility (MCP)

`.mcp.json` at the repo root configures `next-devtools-mcp`, which connects
to the dev server's built-in MCP endpoint at `/_next/mcp`. Start the dev
server (`pnpm --filter web dev`) and use its tools instead of guessing:
`get_errors`, `get_logs`, `get_page_metadata`, `get_project_metadata`,
`get_routes`, `get_server_action_by_id`, `get_compilation_issues`,
`compile_route` — e.g. check compilation via MCP before running a full
`next build`.

`next dev` also forwards browser console errors/warnings to the terminal,
and writes PID/port to `apps/web/.next/dev/lock`; connect to the running
server instead of starting a duplicate.

For the browser's view use [`agent-browser`](https://github.com/vercel-labs/agent-browser)
(`agent-browser open --enable react-devtools`), which exposes DOM, console,
network, Web Vitals, component tree, and pending Suspense boundaries as
structured text.

### Skills

Already installed at `.agents/skills/` (committed): `next-dev-loop`,
`next-cache-components-adoption`, `next-cache-components-optimizer`,
`next-partial-prefetching-adoption`. Re-install only to update:

```sh
npx skills add vercel/next.js --skill next-dev-loop                    # edit → verify loop vs running dev server
npx skills add vercel/next.js --skill next-cache-components-adoption   # adopt Cache Components route-by-route
npx skills add vercel/next.js --skill next-cache-components-optimizer  # make a navigation instant, guarded by instant() test
npx skills add vercel/next.js --skill next-partial-prefetching-adoption # shared App Shell prefetching
```

Default working agreement for this repo: after every UI edit, verify the page
at runtime using the `next-dev-loop` Skill (or MCP + agent-browser when the
skill is not installed), then run the verification gate below.

### Performance work

When asked to make pages fast: prefer Cache Components (`"use cache"`,
`<Suspense>` streaming) and instant navigation patterns from
`01-app/02-guides/caching-without-cache-components.md` → `migrating-to-cache-components.md`
and `instant-navigation.md` in the bundled docs, drive the work through the
matching Skill, and guard outcomes with `instant()` tests rather than
one-off measurements.
