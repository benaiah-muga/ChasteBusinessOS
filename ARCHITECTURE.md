# ChasteBusinessOS Architecture

## Goals

- Modular installable business capabilities
- AI as an **operational harness** over the same services as the UI
- High transactional integrity and complete audit trails
- **Loose coupling**: clients consume HTTP APIs; domain logic stays server-side
- Honest capability gaps → tickets → optional self-development pipeline
- Human-like semantic memory without token-burning tool spam
- Multi-branch org model and time/attention services (schedule, notify, email)

## System context

```
┌──────────────┐     HTTPS/JSON      ┌─────────────────────────────┐
│  apps/web    │ ──────────────────▶ │  apps/api  (Fastify)        │
│  (Next.js)   │ ◀────────────────── │  auth · routes · AI chat    │
└──────────────┘   DTOs only         └──────────────┬──────────────┘
                                                    │
                     in-process                      │ loads
                     (not exposed to web)            ▼
                                      ┌─────────────────────────────┐
                                      │  packages/kernel            │
                                      │  command/query bus · authz  │
                                      │  audit · module registry    │
                                      └──────────────┬──────────────┘
                                                     │
          ┌──────────────────┬───────────────────────┼──────────────────┐
          ▼                  ▼                       ▼                  ▼
   packages/db         modules/*              packages/ai-core    apps/worker
   PostgreSQL          crm, platform, …       harness orchestrator  outbox · jobs
   + pgvector                                 memory · workflows    schedule · notify
```

## Boundary rules

| Package / app | May depend on |
|---|---|
| `apps/web` | `@chaste/api-client`, `@chaste/ui-schema` only (plus React/Next) |
| `apps/api` | kernel, db, ai-core, ui-schema, modules |
| `apps/worker` | kernel, db, ai-core, modules |
| `modules/*` | kernel, db (own schemas), ui-schema (optional) |
| `packages/ai-core` | kernel, ui-schema (not Next.js) |
| `packages/api-client` | zod + shared DTO types only (no db) |

**Invariant:** the browser never holds DB credentials or imports command handlers.

## Command layer (single mutation surface)

All business writes go through **commands**:

```ts
defineCommand({
  name: "crm.customer.create",
  input: CustomerCreateInput,
  output: Customer,
  permissions: ["crm.customer.create"],
  handler: async (input, ctx) => { /* … */ },
});
```

- Manual UI → `POST /api/v1/commands/:name`
- AI tools → same `executeCommand` path
- Both receive the same permission checks, Zod validation, audit entries, and outbox events

Queries are analogous: `GET/POST /api/v1/queries/:name`.

## Modules

Each module provides:

- `module.manifest.ts` -- id, version, deps, permissions, capabilities
- Commands & queries
- Optional schema/migrations (namespaced tables)
- Optional specialist **profile metadata** (tool tags, prompts) -- not a private runtime

Modules must not couple to the web app. If a module needs UI, it exposes API contracts;
the web discovers capabilities via API and renders generic or registered views.

## AI operational harness

The AI layer is a **harness**, not a privileged co-process:

```
User NL / proactive trigger
        │
        ▼
┌─────────────────── ai-core harness ───────────────────┐
│  Memory recall (passive cosine + optional side-agent) │
│  General agent (proactive, clarification, routing)    │
│  Domain specialists (CRM, Accounting, …) as profiles  │
│  Capability classifier → execute | partial | gap      │
│  Autonomy gate (recommend / confirm / guarded / full) │
│  Workflow engine (multi-step durable runs)            │
│  Customization agent → gap ticket / coding pipeline   │
└───────────────────────────┬───────────────────────────┘
                            │ tools only
                            ▼
                   kernel command / query bus
                            │
                            ▼
                   modules + SoR tables + audit
```

1. User message (or scheduled/proactive event) → orchestrator (`packages/ai-core`)
2. Passive memory injection + optional explicit memory tools
3. Intent + tool plan (tools = installed module commands/queries + platform services)
4. Autonomy gate (recommend / confirm / guarded / full)
5. On execute: kernel command bus
6. Explanation record + validated generative UI parts (`@chaste/ui-schema`)
7. On missing capability: Capability Gap Ticket (+ optional self-dev handoff)

Domain specialists improve routing and reasoning via allowlists and prompts. They do **not** own private write paths. Security-sensitive domains (RBAC, secrets, break-glass) force higher gates.

**ADR:** [0006 custom AI orchestration](./docs/adr/0006-custom-ai-orchestration.md), [0007 harness memory & self-dev](./docs/adr/0007-harness-memory-and-self-dev.md).

## Memory

Inspired by jcode-style agent harnesses: automatic semantic recall, extraction side-agent, consolidation, plus explicit tools when the agent chooses.

| Kind | Store | Notes |
|---|---|---|
| Short-term chat | `chat_sessions` / messages | Per conversation; each turn embeddable |
| Semantic memory graph | memory nodes + edges + pgvector | Cosine top-k; optional side-agent verify |
| Session search (RAG) | session embeddings / FTS | Traditional prior-session retrieval |
| Workflow | checkpoints / run state | Durable multi-step |
| Customization lessons | tagged long-term memories | How hard customizations were done |
| Permanent business | SoR tables via commands | Never “notes only” |

**Passive path (every turn):** embed turn → cosine against memory graph → optional memory side-agent relevance check → inject into context (budgeted).

**Active path:** explicit tools `memory.search`, `memory.store`, `session.search`.

**Ambient consolidation:** periodically reorganize, detect staleness/conflicts, merge duplicates (worker job).

**Extraction triggers:** semantic drift, K turns since last extract, session end, successful multi-step plan, closed gap ticket.

Detail: [docs/specs/memory-system.md](./docs/specs/memory-system.md).

## Capability gaps & self-development

```
Request → capability catalog
            │
            ├─ available → commands / config / workflows
            ├─ partial  → do possible + explain remainder
            └─ absent   → CapabilityGapTicket
                              │
                              ├─ local: detect coding agent → sandbox build/test
                              └─ cloud: recommend shared marketplace vs private extension
                              │
                              ▼
                     extension package / module
                              │
                              ▼
                     marketplace / registry (+ memory of how)
```

**Hard rules:**

- No elevated AI privileges while coding or operating.
- Production self-dev only through defined surfaces (module packages, config, approved paths).
- Tests + conventions (AGENTS.md, skills) required before enable.
- Prefer general capabilities over tenant-named forks.

Detail: [docs/specs/self-development.md](./docs/specs/self-development.md), [docs/specs/agent-harness.md](./docs/specs/agent-harness.md).

## Multi-branch

```
Organization
  └── Branch[]
  └── UserBranchAccess
  └── documents / stock / employees often carry branchId
Session: activeBranchId (nullable = all allowed for HQ roles)
```

UI: global branch switcher + list of allowed branches. AI plans and queries respect active branch context unless user asks for cross-branch (and is permitted).

## Scheduling, calendar, reminders, notifications, email

Platform **time & attention** services (worker-backed):

| Concern | Mechanism |
|---|---|
| Schedule / calendar | Commands + calendar entities; NL → structured times |
| Reminders / NL follow-up | Durable jobs; re-enter harness as proactive turns |
| In-app notify + sound/ring | Notification outbox → web push / client ring policy |
| Email | Provider adapter (SMTP/API); templates; digests |

All mutations via commands; delivery via worker/outbox. Spec: [docs/specs/scheduling-and-comms.md](./docs/specs/scheduling-and-comms.md).

## Events

Transactional **outbox** in PostgreSQL. After commit, `apps/worker` publishes/dispatches (notifications, webhooks, schedule fires, memory consolidation jobs). Consistency beats autonomous fan-out.

## Tech stack (v1)

- TypeScript + Node.js LTS
- pnpm + Turborepo
- Fastify API
- Next.js web (API client)
- PostgreSQL + Drizzle + pgvector
- Redis + BullMQ (jobs) as scale path
- Zod everywhere at boundaries
- Vitest
- Optional local coding agents for self-dev (OpenCode, Codex, Claude Code, …)

## Extensibility

New domain ≈ new module package + migrations + commands + (optional) specialist profile.
No kernel fork required for normal features. No web redeploy required for pure API-only
module additions beyond registering the module on the server (UI can be progressive).

Self-dev and marketplace extensions follow the same module contracts so AI and humans stay on one bus.
