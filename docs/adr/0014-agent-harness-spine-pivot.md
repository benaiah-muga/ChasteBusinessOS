# ADR 0014 — Pivot to the future architecture: business kernel + agent harness spine

## Status

Accepted (2026-08-16)

## Context

`docs/research/2026-08-15-future-architecture-ai-native-business-os.md` designs
ChasteBusinessOS as a trustworthy business execution harness, not an ERP with a
chatbot. Its central rule: **if the agent can do it, a human can do the same
thing through the same command/query contract**. The durable moat is the
harness — capability design, context assembly, policy enforcement, durable
execution, model-visible logging, trace replay, human approval, and evaluation
— not any single model or prompt.

The repository already ships much of the business-kernel foundation the doc
describes (command/query bus, transactional outbox, audit, RBAC, risk classes,
autonomy gates, durable runtime stores, twelve modules). What is genuinely
missing is the **agent harness spine**:

1. A **command envelope** that makes AI/manual parity explicit at the write
   boundary: origin, idempotency key, evidence refs, approval grant, policy
   context, correlation/causation.
2. An **append-only agent trajectory log** whose event stream can reconstruct
   everything a model saw (the doc's hard invariant: a model request is valid
   only if its system prompt, messages, tool schemas, retrieved evidence,
   memory reads, and injected context are reconstructable from durable events).
3. A **context engine** that assembles model-visible context as a versioned,
   tiered, budgeted `ContextBundle` instead of prompt concatenation.
4. Durable persistence for the trajectory and context bundles so audit, replay,
   fork, eval, and red-team analysis are first-class product surfaces.

## Decision

Proceed on branch `architectural-pivot2` with an additive, non-breaking pivot
toward the doc's implementation blueprint. Keep everything that already works;
add the missing harness spine on top, following the repo's existing
conventions (strict TypeScript, Zod at boundaries, interface + in-memory +
Postgres-store pattern, command bus as the only write path).

The first tranche delivers:

- `packages/kernel/src/envelope.ts` — `CommandEnvelope`, `ActorOrigin`,
  `PolicyContext`, `EvidenceRef`, `ApprovalGrant`, `PolicyDecision`,
  `createCommandEnvelope`, and `dispatchCommand`. Envelope metadata flows into
  `RequestContext`, `AuditEntry`, and the audit/outbox writers, so an AI-origin
  command is audited with its reason, evidence, approval grant, and policy
  context — never silently as a plain user action.
- `packages/ai-core/src/trajectory/` — an append-only `SessionLog`
  (`AgentSessionEvent` union mirroring the doc's `session/start` …
  `session/end` vocabulary) plus `reconstructModelRequest`, which replays the
  event stream into the model-visible request and verifies the reconstruction
  invariant.
- `packages/ai-core/src/context-engine/` — `ContextBundle`, `ContextSection`,
  `TokenBudget`, tiered admission rules, budget allocation, and
  `explainContext` (why a section was included, summarized, or omitted).
- `packages/db` + `packages/runtime` — `agent_session_events` and
  `context_bundles` tables (append-only), envelope columns on `audit_log`, and
  a `PostgresSessionLog` store wired into `createRuntime`.

Later tranches (not in this ADR's scope) follow the doc's build sequence:
policy engine / relationship graph / decision log, harness adapters
(DeepSeek/Claude Code/opencode/Codex), durable workflow engine semantics,
onboarding/migration data plane, and verifiable analytics.

## Update (2026-08-16): Tranche 2 — tool and capability registry

The second tranche implements the doc's §Tool and Capability Registry,
§Tool Surface Optimization, and the §Agent Tool Wrapper Template in
`packages/ai-core/src/tools/`. Design intent follows the doc verbatim:
**agent tools are thin consumers of the same command/query bus** — no tool
implements business logic and no tool may hide a write outside the bus. The
existing orchestrator's ad-hoc `AgentToolCall`/`executeAgentTool` switch is
deliberately *not* mirrored; this registry is the doc-shaped replacement.

- `tools/types.ts` — `BusinessToolDefinition` (`name`, `description`, `kind`
  (`command`/`query`), `command`, optional `risk` override, `exposeWhen`
  permissions, strict `input`/`output` Zod contracts, idempotency, approval
  class, read/write access, latency/cost, examples, `renderResult`,
  `renderHuman`), `ToolContext` (actor + both bus registries + helpers +
  trajectory sink + approval resolver + policy hook), and the typed
  `ToolOutcome` union (`ok` / `denied` / `validation` / `approval_required` /
  `error`).
- `tools/registry.ts` — `createToolRegistry` + `defineBusinessTool` (the doc's
  wrapper template). `listForActor` hides every tool whose `exposeWhen`
  permissions the actor does not hold, so tools are kept out of model context
  unless the actor/task can use them.
- `tools/execute.ts` — `executeBusinessTool` implements the doc's execution
  pipeline in order: log `tool/call` → validate args (same Zod contract the
  bus validates) → authorize visibility/execution → classify risk (derived from
  the wrapped command's `CommandMeta`, or the tool's own override) → require
  approval if policy says so → dispatch through `dispatchCommand` /
  `executeQuery` under the actor's own (never elevated) permission set → record
  `policy/decision` + `command/query/dispatched` + `command/query/result` →
  normalize to the canonical output → render a concise model-facing result →
  log `tool/result`. Approval-required outcomes are returned as `approval_required`
  (an approval *request*), never as failures; `approval/granted` carries the
  durable grant id into the envelope. `defaultToolPolicy` allows `read` /
  `write_local` under the actor's own authority and requires a durable grant
  for `exec` / `external`.
- `tools/schema.ts` — `zodToSchemaText`: deterministic, model-facing summary of
  a Zod contract (strict input / canonical output). Boundary validation still
  uses the real Zod schema, so the text can never widen the contract.
- `tools/describe.ts` — `describeTool` / `describeToolSet` render the tool
  surface (description, schema, risk, approval class, access, idempotency,
  latency/cost, examples) with a `catalog: true` capability-directory one-liner
  mode for staged exposure (doc Stage 0–4).
- Trajectory vocabulary gains `tool/result` (already had `tool/call`,
  `policy/decision`, `approval/*`, `command/query/dispatched|result`).

Acceptance criteria from the doc are covered by `tools/tools.test.ts` (21
tests): the tool does not implement business logic (it only dispatches), call
arguments are logged before dispatch, the command/query result is logged after,
approval-required calls render as approval requests rather than failures, and
tools are hidden from model context unless the actor can use them.

The orchestrator wiring that *uses* this registry (building the model-facing
tool list from `listForActor` + `describeToolSet`, calling
`executeBusinessTool` on parsed tool calls, surfacing `approval_required`
outcomes as inbox items) is a later tranche and is not part of this ADR update.

## Design rules carried forward

- Additive only: existing command/query bus callers keep working.
- AI never bypasses the bus; `dispatchCommand` reuses `executeCommand`.
- Trajectory events are append-only; context bundles reference versioned
  artifacts; the trajectory is the audit spine for agent activity.
- UI stays an API client; the agent stays an operator, never a database channel.
- Every model-visible artifact a context engine includes carries source,
  purpose, authorization decision, and token estimate.

## Consequences

- Audit gains provenance for AI-originated writes (origin, reason, evidence,
  approval grant, policy context), strengthening explainability-by-construction.
- Trajectory + reconstruction make replay, fork, and eval-runner work possible.
- Context engine gives the orchestrator a deterministic assembly path that
  later accepts policy checks, caching, and cost attribution per section.
- The pivot is incremental: no greenfield rewrite, no removed capability, and
  the doc's forbidden-dependency rules remain enforced.

Related: ADR 0006 (custom AI orchestration), ADR 0007 (harness memory),
research doc `docs/research/2026-08-15-future-architecture-ai-native-business-os.md`.
