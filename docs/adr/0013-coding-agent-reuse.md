# ADR 0013 — Reuse locally detected coding agents as AI providers

## Status

Accepted (2026-08-11)

## Context

Chaste runs in-process with the operator's machine (self-hosted installs,
single-tenant deployments, dev boxes). Operators of those installs almost
always already run a **coding agent CLI** — Claude Code, Codex, OpenCode,
Gemini, Grok, Cline, … — with a paid subscription or API credential configured.
Today, to give the Chaste harness a real LLM, they must separately set
`CHASTE_AI_PROVIDER` + an API key, duplicating a credential they already own.

Orca, T3 Code, and Buzz all solve this by *detecting the operator's installed
agents and reusing their subscription*. Two mechanisms exist:

- **Drive the agent CLI headless** (`claude -p`, `codex exec`, `opencode run`) —
  what Orca/T3/Buzz do. Works for any agent, zero credential scraping, but a
  process spawn per request is too slow/fragile for Chaste's harness, which
  issues many small completions per turn (classify, route, summarize, plan).
- **Reuse the model + endpoint + credential the agent already holds** by
  calling the underlying provider HTTP API directly. Fast, cheap, fits the
  existing `AiProvider` abstraction.

## Decision

Adopt the **credential/model reuse** mechanism for harness completions:

- New detection module `packages/ai-core/src/coding-agents.ts` with a
  registry of supported coding agents (27 today). Each entry defines its
  binary name(s) and how to resolve `{ model, baseUrl, apiKey }` from the
  agent's own config files, credential files, and environment variables.
- `CHASTE_AI_PROVIDER=auto` activates detection. An explicit provider/config
  always wins; stock installs stay `"none"` (fail-closed, opt-in).
- `CHASTE_AI_PREFER_CODING_AGENT=<id>` pins one agent; otherwise registry
  order is used and the first **usable** agent wins.
- A coding agent is **only a completion backend**. It never gains elevated
  privileges — generated outputs still flow through the command/query bus,
  permissions, validation, and audit like every other provider.
- Detection results are **probe-only**: `hasApiKey` is a boolean, the key
  value is never retained or logged, and `toPublicAgentInfo()` strips it.
  OAuth-only agents (Cursor, Copilot, Devin, …) are reported as installed for
  the self-dev handoff but marked not-reusable.
- Detection is synchronous and memoized per process (API and worker construct
  providers once at boot, so a blocking PATH/config read is acceptable).

## Why not headless CLI invocation for harness completions

Agent CLIs are interactive-first, start slowly, and their non-streaming modes
vary per tool. The harness performs cheap, high-frequency LLM calls; reusing
the underlying API keeps those calls fast and uniform. Headless agent
invocation remains the design for the **self-development handoff**
(`CodingAgentProvider`, docs/specs/self-development.md §7), where agent-native
worktree editing is exactly what is wanted.

## Consequences

- Operators get a working AI stack from the agents they already run; no second
  API key, no new subscription.
- Claude Code OAuth logins and Cursor/Copilot subscriptions are not reusable
  as raw API keys — those surface as "installed; needs API key" with clear
  guidance, and can be upgraded later via a headless-CLI provider.
- The detection registry is data-driven and extensible: adding an agent is one
  registry entry (binary + credential resolution), not a code path.
- Providers constructed from agent credentials record their `provider`
  attribution (`claude-code`, `codex`, …) in observability/audit, preserving
  explainability.
