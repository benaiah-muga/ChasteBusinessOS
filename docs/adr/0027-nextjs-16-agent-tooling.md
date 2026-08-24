# ADR 0027: Next.js 16.3 upgrade and first-class AI-agent tooling

Date: 2026-08-24
Status: Accepted

## Context

`apps/web` ran Next.js 15.5. Next.js 16.x is a materially different release
(Turbopack default, `middleware` → `proxy`, async request APIs finalized,
Cache Components / instant navigation as the performance model), and from
16.2 onward the framework ships its documentation **inside the `next`
package** (`node_modules/next/dist/docs/`) plus runtime tooling aimed at AI
coding agents: a built-in MCP endpoint at `/_next/mcp`, browser console
forwarding to the terminal, the `agent-browser` CLI, and installable
Skills such as `next-dev-loop`.

ChasteBusinessOS is developed agent-first: most code changes here are made
by coding agents working from repo-root instructions.

## Decision

1. Upgrade `apps/web` to Next.js **16.3.x** (^16.3.2).
2. Keep a committed root `AGENTS.md` containing:
   - the official managed block between
     `<!-- BEGIN:nextjs-agent-rules -->` / `<!-- END:nextjs-agent-rules -->`
     markers, byte-identical to what `next dev` upserts, so the file stays
     "current" and `next dev` never rewrites it;
   - project-specific guidance **outside** the markers (bundled-docs path
     for this pnpm monorepo, MCP usage, Skills, performance workflow),
     which Next.js preserves across updates.
3. Commit `.mcp.json` (`next-devtools-mcp`) and `CLAUDE.md` (`@AGENTS.md`)
   so every mainstream agent gets the same entry point.
4. Adopt `next-dev-loop` as the default verify step for UI work: edits are
   verified against the running dev server via MCP + agent-browser before
   the existing verification gate.

## Consequences

- Agents read version-matched docs instead of stale training data;
  upgrade-related mistakes should drop sharply.
- Upgrading Next.js also upgrades the bundled docs; AGENTS.md needs no
  doc-path maintenance.
- Turbopack is now the default for dev and build; webpack-specific config
  would need migration (none currently used).
- Cache Components adoption is *not* done yet; it is the recommended
  follow-up via the `next-cache-components-adoption` Skill when UI
  performance work starts.
