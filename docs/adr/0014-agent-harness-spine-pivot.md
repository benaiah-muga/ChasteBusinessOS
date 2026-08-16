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

## Update (2026-08-16): Tranche 3 — durable approval grants

The third tranche implements the doc's §Human Collaboration rule that
**human approval is a durable grant, not a chat message the model may
reinterpret**. The `ApprovalGrant` type from tranche 1 had no store; this
tranche adds the store, the matcher, the durable schema, and the bridge that
turns the tool registry's `approval_required` outcomes into grants the
envelope can cite as `approvalGrantId`.

- `packages/kernel/src/approvals.ts` — `ApprovalGrantRecord` (the envelope's
  `ApprovalGrant` plus `organizationId`, `grantedToUserId`, `status`, revoke
  bookkeeping), `ApprovalGrantStore` interface, `InMemoryApprovalGrantStore`,
  and the pure `grantCovers` matcher (org + actor + scope + expiry + revoked).
  A grant declares who granted, what exact command/resource, which actor it
  authorizes, when it expires, the thresholds/conditions recorded at grant
  time, the policy basis, and the evidence shown. `conditions` are recorded
  for audit/explanation; evaluating thresholds (e.g. amount ceilings) is the
  policy engine's job in a later tranche.
- `packages/db` + `packages/runtime` — `approval_grants` table (Drizzle +
  idempotent SQL) and `PostgresApprovalGrantStore`, wired into `createRuntime`
  as `runtime.approvalGrants`, so grants survive restarts and are shared
  across hosts.
- `packages/ai-core/src/tools/approvals.ts` —
  `grantStoreApprovalResolver` bridges the tool pipeline's approval requests
  to durable grants: it surfaces an approval item in the `InboxStore` (when
  wired), awaits the human decision, and on `allow`/`always` mints a durable
  grant (scope = the exact command, TTL, conditions from `policyContext`,
  `policyBasis` = the policy that demanded approval, `evidenceShown`). Without
  a decision surface it returns not-granted, so the call stays an approval
  *request*. `grantCoveredToolPolicy` checks the store before the default risk
  policy, so a durable grant auto-allows subsequent identical calls until it
  expires or is revoked — the trajectory's `policy/decision` cites `grant:<id>`.
- Tool pipeline: `ApprovalRequest` now carries `policyBasis` and `evidenceRefs`,
  and the command envelope's `policyContext` records the policy that produced
  the decision, so audit and trajectory cite the grant/policy basis.

Acceptance (kernel `approvals.test.ts` + ai-core `tools/approvals.test.ts`):
grants are durable and match exactly (org/actor/scope/expiry/revocation),
approval-required calls become durable grants when the human approves, stay
approval requests (never failures) when denied, and a covering grant
auto-allows without re-asking.

The policy engine / relationship graph / decision log and the orchestrator
wiring that *serves* inbox decisions to this resolver remain later tranches.

## Update (2026-08-16): Tranche 4 — typed agent plans (planning layer)

The fourth tranche implements the doc's §Planning layer. A plan is a typed,
inspectable, revisable artifact — `AgentPlan` — that connects intent →
approval → execution, and it is validated by Zod at every boundary so the
model can propose a plan but never invent a shape the kernel rejects.

- `packages/ai-core/src/planning/types.ts` — `AgentPlan`
  (`objective`, `assumptions`, `steps`, `requiredApprovals`, `risks`,
  `evidenceNeeded`, `stopConditions`), `PlanStep` (`command`, `args`,
  `riskClass`, `requiredApproval`, `dependsOn`, `expectedEvidence`),
  `ApprovalNeed`, `PlanRisk`, `EvidenceNeed`.
- `packages/ai-core/src/planning/schema.ts` — Zod contracts
  (`agentPlanSchema`, `validatePlan`) enforcing `.strict()` shapes at the chat
  UI parts, harness, and inbox-card boundaries.
- `packages/ai-core/src/planning/plan.ts` — pure analysis: `planRisk` maps the
  tool registry's risk tiers onto plan risk levels (aligned with
  `defaultToolPolicy`: `read`→low, `write_local`→medium, `exec`/`external`→high),
  `planRequiresApproval` (low-risk plans run internally; anything else is shown
  before execution), `summarizePlan` (model-facing), `renderPlan` (approval card).
- `packages/ai-core/src/planning/approve.ts` — `requestPlanApproval`: logs
  `plan/proposed`, auto-runs low-risk plans, surfaces medium/high-risk plans as
  an inbox `plan` item (editable/rejectable per the doc's UX rule), and on
  approval mints a durable grant per `requiredApproval` — scoped to the
  command/resource, TTL'd, `policyBasis: "plan-approval"`, conditioned on the
  approval's reason and plan id — so `grantCoveredToolPolicy` auto-allows the
  matching steps without re-asking. Rejection logs `approval/rejected` and mints
  nothing; absent a decision surface the plan fails closed
  (`no_decision_surface`). All of it lands on the session trajectory.

Acceptance (ai-core `planning/planning.test.ts`): risk classification matches
the tool registry's approval semantics, low-risk plans auto-run with no inbox
item or grant, medium/high-risk plans surface and mint exactly the requested
grants on approval, rejection mints nothing, no decision surface fails closed,
and the minted grant covers the approved command for the granted actor only.

Plan *revision* (editing a rejected plan) and orchestrator execution of plan
steps through the bus remain later tranches.

## Update (2026-08-16): Tranche 5 — activities + task foundations

The fifth tranche completes the first half of build-sequence item 7 (durable
activities + workflow/task foundations) in the kernel + runtime, following the
tranche-3 store pattern (model + in-memory store in kernel, Postgres store in
`@chaste/runtime`).

- `packages/kernel/src/activities.ts` — `Activity` (kind, assignee, createdBy,
  dueAt, timezone, recurrence, link to a business record), `RecurrenceRule`,
  the pure `nextOccurrence` (UTC daily/weekly/monthly with optional weekday
  narrowing and pinned trigger time) and `isOverdue` (derived, never stored),
  `ActivityStore` + `InMemoryActivityStore` (create/get/complete/cancel/list,
  agenda ordering, `overdue`).
- `packages/kernel/src/tasks.ts` — workflow/task foundations: `Task` (status,
  priority, dueAt, `dependsOn` task-id graph, blocker reason), pure
  `taskBlockers` / `canTransition` / `readyTasks` (work queue = pending tasks
  with no blockers, ordered by due date then priority), and `TaskStore` +
  `InMemoryTaskStore` with dependency-enforcing `transition`.
- `packages/db` + `packages/runtime` — `activities` and `workflow_tasks`
  tables (Drizzle + idempotent SQL) and `PostgresActivityStore` /
  `PostgresTaskStore`, wired into `createRuntime` as `runtime.activities` and
  `runtime.tasks`. Task transitions re-read the graph and reuse the kernel's
  pure `canTransition`, so readiness/blocking cannot drift between stores.

Acceptance (kernel `activities.test.ts` + `tasks.test.ts`): recurrence is
deterministic, overdue is derived from the clock, activities complete/cancel
once, tasks refuse to start/complete while a dependency is open, blocker
reasons are recorded, and the work queue reports exactly the ready pending
tasks in due/priority order.

The `activities.*` / `workflow.*` command surface (scheduling + workflow
modules layering commands over these stores) and workflow *instances* remain
later tranches.

## Update (2026-08-16): Tranche 6 — harness orchestrator wiring

The sixth tranche connects the four harness layers (tool registry, durable
approval grants, typed plans, trajectory) into a runnable whole — additively,
without touching the existing ad-hoc orchestrator path (the pivot stays
non-breaking).

- `packages/ai-core/src/harness/` — `createHarness` (doc §Agent Harness):
  - **`toolSurface(actor)`** — the model-facing tool surface built from
    `listForActor` + `describeToolSet`: only tools the actor may see and use,
    full schemas + examples.
  - **`call(params)`** — executes one tool call through `executeBusinessTool`
    under the actor's own permissions. Policy is `grantCoveredToolPolicy` (a
    durable grant auto-allows; otherwise the default risk policy), and
    approval-required outcomes go through `grantStoreApprovalResolver` into
    the inbox. No grants/inbox/approver → approval-required calls stay
    approval *requests* (fail closed, never silent execution).
  - **`runPlan(params)`** — validates the plan at the boundary, gates on
    `requestPlanApproval` (low-risk auto-run; medium/high surfaces as an inbox
    `plan` item and mints durable per-step grants), orders steps by dependency
    (`topoSort`; cycles/missing deps rejected), runs each step through the
    bus, skips dependents of failed steps, honors `stopConditions`, and
    attaches `evidence/attached` events for each step's `expectedEvidence`.
- `packages/ai-core/src/tools/execute.ts` — an `allow` decision whose policy
  is `grant:<id>` (from `grantCoveredToolPolicy`) now cites the durable grant
  as the envelope's `approvalGrantId`, so audit and the command handler trace
  exactly which approval authorized the call — a step runs "under the plan
  grant" and proves it.

Acceptance (ai-core `harness/harness.test.ts`): tool surfaces are filtered by
actor permissions, read tools dispatch through the bus with full trajectory,
approval-required calls fail closed without a decision surface and mint
durable grants (then auto-allow) when approved, plan grants cover external
steps (envelope cites the grant id), dependency order and dep-failure
skipping hold, stop conditions halt the run, and boundary validation +
missing approver fail closed.

The HTTP/chat host layer that serves inbox decisions to the harness and the
workflow *instance* engine remain later tranches.

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
