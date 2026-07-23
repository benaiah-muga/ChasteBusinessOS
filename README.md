# ChasteBusinessOS

**AI-native Business Operating System** for SMBs: modular, open source, and built for trust.

> **AI is how you operate the business.** Manual UIs remain available.  
> **AI never bypasses business rules.**

*Every action -- AI or human -- flows through the same validated command bus, permission checks, and audit trail.*

[Vision](./VISION.md) · [Architecture](./ARCHITECTURE.md) · [Contributing](./CONTRIBUTING.md) · [Agents](./AGENTS.md) · [Changelog](./CHANGELOG.md)

## Status

**Early alpha, active development.** The platform ships a production-shaped foundation: kernel command/query bus, full web UI, seven business modules, RBAC and settings, audit trails, transactional outbox, and a conversation intelligence layer powered by Mastra agents. Not yet recommended for production workloads.

## What it is

ChasteBusinessOS is an open-source operating system for running a business, not an ERP with a chatbot bolted on. Users can operate through natural language or traditional screens. Either way, every mutation flows through the same validated command bus, permission checks, and audit trail.

The goal is **trustworthy automation**: AI that plans, clarifies, and suggests, without elevated privileges or hidden write paths.

## Highlights

- **Single command bus**: humans and AI execute the same commands with identical authz and audit coverage
- **Installable modules**: Odoo-inspired modularity; enable only what your organization needs
- **Conversation intelligence**: multi-turn memory, clarifying questions, multi-step plans, and proactive suggestions
- **Domain specialists**: scoped AI agents (CRM, Accounting, Inventory, …) over module tool registries, not private backends
- **Configurable autonomy**: recommend → confirm → guarded auto → full autonomous (with explicit warnings)
- **HTTP-first clients**: the web app consumes REST APIs only; no kernel or DB imports in the browser
- **Explainable AI actions**: every assisted path can record what happened, why, and which rules applied
- **Zod-validated boundaries**: intents, commands, settings, and generative chat UI parts
- **Observable stack**: optional Langfuse tracing for LLM calls; transactional outbox for domain events

## Business modules

| Module | Capabilities | AI specialist |
|---|---|---|
| **CRM** | Customers and relationship data | CRM Agent |
| **Accounting** | Chart of accounts, journals, invoices | Accounting Agent |
| **Inventory** | Warehouses, products, stock movements | Inventory Agent |
| **Purchasing** | Vendors and purchase orders | Purchasing Agent |
| **Manufacturing** | Bills of materials and work orders | Manufacturing Agent |
| **HR** | Employees and payroll preparation | HR Agent |
| **Platform** | RBAC, module installs, marketplace, org settings, autonomy policy | System Agent |

Modules declare permissions, commands, queries, and optional specialist profiles. New domains ship as installable packages; no kernel fork required.

## Web application

The Next.js UI provides operational screens alongside the AI chat surface:

- **Dashboard**: activity, audit summaries, and quick actions
- **CRM, Accounting, Inventory, Purchasing, Manufacturing, HR**: module workspaces
- **Workflows**: multi-step automation builder and run history
- **Audit trail**: searchable record of commands and policy events
- **RBAC**: roles, permissions, and user management
- **Settings**: organization policy and user preferences
- **Marketplace**: discover and manage installable modules

## AI stack

| Layer | Technology | Role |
|---|---|---|
| Orchestrator | `@chaste/ai-core` | Intent resolution, autonomy gates, confirm/cancel flows |
| Agents | [Mastra](https://mastra.ai) | Conversational agent, supervisor routing, domain specialists |
| Tools | Command/query wrappers | AI never calls SQL directly; only registered bus operations |
| Workflows | Workflow engine | Multi-step business automation with step validation |
| Memory | PostgreSQL + pgvector | Persistent chat sessions and long-term org memory |
| Providers | OpenAI, OpenAI-compatible, Ollama, Nvidia NIM | Config-driven via `CHASTE_AI_PROVIDER` |
| Observability | Langfuse (optional) | Trace LLM calls when keys are configured |

Set `CHASTE_AI_PROVIDER=none` for deterministic, rule-based planning with no external LLM. See [configuration](./docs/configuration.md) for provider credentials and autonomy settings.

## Monorepo

```
apps/
  api/            Fastify HTTP API: auth, routes, chat, command/query dispatch
  web/            Next.js UI (API client only; no kernel/db imports)
  worker/         Outbox processor and background jobs

packages/
  kernel/         Command/query bus, authz, audit, module registry
  db/             Drizzle schema, migrations, settings schemas
  ai-core/        Orchestrator, Mastra agents, workflows, memory, guardrails
  api-client/     Typed HTTP client and DTOs for frontends
  ui-schema/      Generative chat UI part schemas (Zod)
  config/         Typed environment configuration

modules/
  crm/            Customer relationship management
  accounting/     Ledger, journals, invoices
  inventory/      Warehouses, products, stock
  purchasing/     Vendors, purchase orders
  manufacturing/  BOMs, work orders
  hr/             Employees, payroll prep
  platform/       RBAC, settings, marketplace, autonomy
  core-system/    Always-on system queries
  demo-crm/       Reference vertical slice for contributors
```

## Quick start

**Prerequisites:** Node.js 22+, pnpm 9+, PostgreSQL. Redis is optional (reserved for future queue scale-out).

```bash
pnpm install
cp .env.example .env
# Edit DATABASE_URL for your local Postgres, e.g.:
# DATABASE_URL=postgres://$USER@/chaste?host=/var/run/postgresql
createdb chaste   # if needed
pnpm db:migrate
pnpm dev          # API + web in parallel (or run services individually below)
```

| Service | Command | URL |
|---|---|---|
| API | `pnpm --filter @chaste/api dev` | http://localhost:3001 |
| Web | `pnpm --filter @chaste/web dev` | http://localhost:3000 |
| Worker | `pnpm --filter @chaste/worker dev` | n/a |
| Health | n/a | http://localhost:3001/health |

On first run with `CHASTE_BOOTSTRAP=true`, the API seeds a default organization and admin user (see `.env.example`).

## Development

```bash
pnpm lint          # ESLint across the monorepo
pnpm typecheck     # TypeScript strict checks
pnpm test          # Unit and integration tests
pnpm e2e           # Full API + Postgres end-to-end verification
pnpm db:generate   # Generate Drizzle migrations after schema changes
```

Configuration and secrets: [docs/configuration.md](./docs/configuration.md)  
Module authoring: [docs/module-development.md](./docs/module-development.md)  
AI autonomy and safety: [docs/ai-autonomy-and-safety.md](./docs/ai-autonomy-and-safety.md)

## Design constraints

1. `apps/web` → HTTP → `apps/api` only
2. Mutations → kernel commands (Zod + permissions + audit)
3. AI tools wrap commands; never raw SQL
4. Domain specialists are tool/profile scopes, not private backends
5. Events publish via transactional outbox after commit

## License

[Apache License 2.0](./LICENSE)

## Security

See [SECURITY.md](./SECURITY.md).
