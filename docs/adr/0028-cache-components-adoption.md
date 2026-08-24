# ADR 0028: Cache Components adoption (incremental) and Next.js Skills

Date: 2026-08-24
Status: Accepted

## Context

With Next.js 16.3 in place (ADR 0027), the recommended performance model is
Cache Components: routes validate that navigation renders instantly, data
is cached with `use cache` or streamed below `<Suspense>`, and route
segment configs like `dynamic`/`revalidate`/`fetchCache` are replaced.
The official Skills (`next-dev-loop`, `next-cache-components-adoption`,
`next-cache-components-optimizer`, `next-partial-prefetching-adoption`)
encode these workflows for coding agents.

## Decision

1. Install the four official Next.js Skills into `.agents/skills/`
   (universal layout: Cline, Codex, Cursor, Gemini CLI, etc. all read it).
   They are committed so every agent gets them from a fresh clone.
2. Adopt Cache Components **incrementally** (the adoption skill's
   incremental mode):
   - `cacheComponents: true` in `apps/web/next.config.mjs`.
   - Removed both `export const dynamic = "force-dynamic"` exports
     (`api/purchasing`, `api/manufacturing`) — under Cache Components every
     route is dynamic by default; nothing to translate.
   - Ran the `cache-components-instant-false` codemod. It opted out exactly
     three server segments with blocking reads (`src/app/layout.tsx`,
     `(app)/layout.tsx`, `(app)/page.tsx`) with TODO-marked
     `export const instant = false`. All module pages are `"use client"`
     shells fetching through `/api`, so they needed no opt-out.
   - No sync-IO blockers (`new Date()`, `Math.random()`, …) exist outside
     client components, which the opt-out cannot cover anyway.
   - Converted `/portal/[token]` to the canonical params pattern: the
     client content moved to `portal-content.tsx` with `use(params)` inside
     a `<Suspense>` boundary on the server page. The route is now ◐ Partial
     Prerendered; `/login` and `/onboarding` became fully static (○).

## Consequences

- The build passes under validation; behavior is unchanged for users
  (opt-outs preserve current rendering), with instant shells gained on
  public routes.
- Backlog: remove the three `instant = false` opt-outs one feature at a
  time via the adoption skill's inner loop (layouts first), guarding each
  conversion with `next-dev-loop` + an `instant()` test from the optimizer
  skill. Only after the `(app)` layout converts can its descendants be
  meaningfully validated.
- Partial Prefetching (`partialPrefetching` config + its skill) is
  deliberately deferred until the opt-outs are gone.
- Verification bar rises: `pnpm typecheck && pnpm lint && pnpm test`
  plus `next build` (authoritative for prerendering) plus runtime checks
  via `/_next/mcp` and `agent-browser`.
