# ChasteBusinessOS Architecture

## Goals

- Modular installable business capabilities
- AI as an operational layer over the same services as the UI
- High transactional integrity and complete audit trails
- **Loose coupling**: clients consume HTTP APIs; domain logic stays server-side

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
                          ┌──────────────────────────┼──────────────────┐
                          ▼                          ▼                  ▼
                   packages/db                 modules/*          packages/ai-core
                   PostgreSQL                  demo-crm, …        orchestrator
                          ▲
                          │
                   apps/worker (outbox, jobs)
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

## AI operational layer

1. User message → orchestrator (`packages/ai-core`)
2. Intent + tool plan (tools = installed module commands/queries)
3. Autonomy gate (recommend / confirm / guarded / full)
4. On execute: kernel command bus
5. Explanation record + optional generative UI parts (`@chaste/ui-schema`)

Domain specialists (CRM Agent, Accounting Agent, …) are **profiles** that restrict
tool allowlists and prompts. They do not own side-effect channels.

## Memory

| Kind | Store | Notes |
|---|---|---|
| Short-term chat | `chat_sessions` / messages | Per conversation |
| Workflow | checkpoints / run state | LangGraph later |
| Long-term org | memory records + pgvector | Revisable |
| Permanent business | SoR tables via commands | Never “notes only” |

## Events

Transactional **outbox** in PostgreSQL. After commit, `apps/worker` publishes/dispatches.
Consistency beats autonomous fan-out.

## Tech stack (v1)

- TypeScript + Node.js LTS
- pnpm + Turborepo
- Fastify API
- Next.js web (API client)
- PostgreSQL + Drizzle + pgvector
- Redis + BullMQ (jobs)
- Zod everywhere at boundaries
- Vitest

## Extensibility

New domain ≈ new module package + migrations + commands + (optional) specialist profile.
No kernel fork required for normal features. No web redeploy required for pure API-only
module additions beyond registering the module on the server (UI can be progressive).
