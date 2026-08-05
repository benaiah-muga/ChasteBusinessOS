# ADR 0006: Custom AI orchestration (no agent framework core)

## Status

Accepted — 2026-07-27

## Context

ChasteBusinessOS is an AI-native Business Operating System. Non-negotiable
invariants include:

1. **AI/manual parity** — AI executes only through the same command/query bus as humans.
2. **No elevated AI privileges** — permissions, Zod validation, and audit always apply.
3. **Autonomy as product policy** — recommend → confirm → guarded_auto → full.
4. **Explainability** — chat returns structured UI parts (plan, confirm, explanation).

We previously integrated [Mastra](https://mastra.ai) (`@mastra/core`, agents,
tools, memory, PG storage, Fastify adapter) with the intent of replacing the
hand-rolled orchestrator. In practice:

- The **reliable path** remained custom: `orchestrator.ts`, `workflows/engine.ts`,
  `AiProvider`, `DbMemoryStore`, session store.
- Mastra was a **secondary fallback** (`mastraAgent.generate`) and thin wrappers
  around the same command bus.
- PG storage often degraded; dual memory and dual workflow models increased
  complexity without product leverage.
- Framework tool-loops fight confirm/autonomy UX (side effects before user OK).

## Decision

**Own the AI product path in `@chaste/ai-core`:**

```
NL → rules + AiProvider structured plan → autonomy gate → command bus → UiParts
NL (process) → workflow builder → custom workflow engine → durable runs
```

**Do not** depend on a general agent framework for orchestration, memory,
workflows, or tool execution.

**Keep thin and replaceable:**

- `AiProvider` for chat completions (OpenAI-compatible, Ollama, Nvidia NIM HTTP).
- Optional Langfuse tracing via `observability` config.
- Lightweight prompt-injection checks (pure functions).
- Module `specialist` metadata for routing tags — not separate agent runtimes.

**Remove** `@mastra/*` packages and Mastra-backed agents/tools from the codebase.

## Consequences

### Positive

- One mental model for contributors and for the vision (AI is an interface layer).
- Autonomy, confirm, audit stay first-class and testable.
- Fewer dependencies, less supply-chain and version churn risk.
- Easier to deepen domain “outcome packs” without framework constraints.

### Negative / trade-offs

- We implement streaming, multi-agent handoffs, and advanced evals ourselves if needed.
- No Mastra Studio; use Langfuse or logs for observability.
- MCP remains a thin catalog export, not a full framework MCP server (can grow later).

### Non-goals

- Rebuilding a mini-Mastra (generic multi-agent runtime “because agents”).
- Free-form tool loops that bypass confirm or the command bus.

## Alternatives considered

1. **Deepen Mastra** — reject; product constraints fight framework defaults.
2. **Hybrid** (custom orchestrator + Mastra agents) — reject; dual stack cost.
3. **LangGraph / other** — same overhead class; no better fit for command-bus parity.

## References

- `docs/adr/0003-command-layer-and-ai-parity.md`
- `packages/ai-core/src/orchestrator.ts`
- `packages/ai-core/src/workflows/`
- Historical (superseded direction): `docs/ai-pivot-plan.md`
