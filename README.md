<div align="center">

# ChasteBusinessOS

**An AI-native Business Operating System for SMBs — modular, open source, built for trust.**

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](#)
[![Status](https://img.shields.io/badge/status-alpha-yellow.svg)](#)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> **AI is how you operate the business.** Manual UIs remain available.  
> **AI never bypasses business rules.**  
> Every action — AI or human — flows through the same validated command bus, permission checks, and audit trail.

[Docs](#documentation) · [Vision](VISION.md) · [Architecture](ARCHITECTURE.md) · [Roadmap](docs/product-architecture-next.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

</div>

---

## What is this?

ChasteBusinessOS is an open-source operating system for running a business — **not an ERP with a chatbot bolted on**. Operate through natural language or traditional screens. Either way, every mutation runs through the **same native bus**: human clicks and AI requests share identical validation, permission checks, and audit records (see [AI/manual parity](AGENTS.md#non-negotiable-product-invariants)).

The goal is **trustworthy automation**: AI that plans, clarifies, and suggests — without elevated privileges or hidden write paths.

Six business modules plus a platform layer are installable as packages. No kernel fork required to add a domain.

| Module            | Capabilities                                              | AI specialist       |
| ----------------- | --------------------------------------------------------- | ------------------- |
| **CRM**           | Customers and relationship data                           | CRM Agent           |
| **Accounting**    | Chart of accounts, journals, invoices                     | Accounting Agent    |
| **Inventory**     | Warehouses, products, stock movements                     | Inventory Agent     |
| **Purchasing**    | Vendors and purchase orders                               | Purchasing Agent    |
| **Manufacturing** | Bills of materials and work orders                        | Manufacturing Agent |
| **HR**            | Employees and payroll preparation                         | HR Agent            |
| **Platform**      | RBAC, module installs, marketplace, org settings, autonomy | System Agent        |

---

## Key features

- **Single command bus** — humans and AI execute the same commands with identical authz and audit coverage
- **Agent harness** — models operate the business through the same tools as humans (no elevated privileges)
- **Installable modules** — Odoo-inspired modularity; enable only what your organization needs
- **Conversation intelligence** — multi-turn memory, clarifying questions, multi-step plans, proactive suggestions
- **Domain specialists** — scoped AI agents (CRM, Accounting, Inventory, …) over module tool registries
- **Configurable autonomy** — `recommend → confirm → guarded_auto → full_autonomous`
- **HTTP-first clients** — the web app talks REST only; no kernel or DB imports in the browser
- **Explainable AI** — every assisted path can record *what* happened, *why*, and *which rules* applied
- **Transactional outbox** — domain events publish after commit; no dual-write races
- **Built-in messaging, email, and encrypted backups** — with Docker deployment

---

## Quick start

You have two options: **Docker** (recommended, minimal setup) or **running from source**.

### Option 1 — Docker (recommended)

```bash
git clone https://github.com/benaiah-muga/ChasteBusinessOS.git
cd ChasteBusinessOS

# Generate secrets
export CHASTE_SESSION_SECRET="$(openssl rand -hex 24)"
export CHASTE_BACKUP_KEY="$(openssl rand -hex 32)"

# Build and start everything (Postgres + Redis included)
docker compose -f docker-compose.prod.yml up -d --build
```

- Web app → <http://localhost:3000>
- API health → <http://localhost:3001/health>
- The default admin is seeded on first boot (see logs / `CHASTE_ADMIN_*`).

### Option 2 — From source

**Prerequisites:** [Node.js](https://nodejs.org) 22+, [pnpm](https://pnpm.io) 9+, [PostgreSQL](https://www.postgresql.org) 16+. Redis is optional.

```bash
git clone https://github.com/benaiah-muga/ChasteBusinessOS.git
cd ChasteBusinessOS

pnpm install
cp .env.example .env            # then edit DATABASE_URL
createdb chaste                 # if needed
pnpm db:migrate                # apply schema
pnpm dev                       # API + web in parallel
```

| Service | URL |
| ------- | --- |
| **Web app** | <http://localhost:3000> |
| **API** | <http://localhost:3001> |
| **Health** | <http://localhost:3001/health> |

On first run with `CHASTE_BOOTSTRAP=true`, the API seeds a default organization and admin user.

> Want **messaging**, **email**, or **backups** working in a few minutes? See [Docs → Features](#documentation).

---

## Screenshots

> Screenshots coming soon.

---

## Architecture

```
┌─────────────┐      HTTP / JSON       ┌──────────────────────────────┐
│  apps/web   │ ──────────────────────▶│             apps/api          │
│  Next.js UI │                        │   Fastify · auth · command    │
│ (API client │                        │   /query dispatch · chat      │
│  only)      │                        └──────────────┬───────────────┘
└─────────────┘                                       │ command bus
                                               ┌──────▼──────┐
                                               │ apps/worker │  outbox,
                                               └──────┬──────┘  email, backup
                                                      │
                                         ┌────────────▼─────────────┐
                                         │ PostgreSQL + pgvector * * │
                                         └──────────────────────────┘
```

**Monorepo layout**

```
apps/
  api/            Fastify HTTP API: auth, routes, chat, command/query dispatch
  web/            Next.js UI (API client only; no kernel/db imports)
  worker/         Outbox processor and background jobs (email, backups)

packages/
  kernel/         Command/query bus, authz, audit, module registry
  db/             Drizzle schema, migrations, settings schemas
  ai-core/        Orchestrator, workflows, providers, memory, guardrails
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
  messaging/      Internal messaging
```

## Tech stack

| Layer         | Technology                                    | Role                                                                 |
| ------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| Orchestrator  | `@chaste/ai-core`                             | Intent resolution, autonomy gates, confirm/cancel flows              |
| Command bus   | `@chaste/kernel`                              | Authz, audit, module registry                                        |
| Database      | PostgreSQL + pgvector                         | Persistence and long-term memory                                     |
| Schema        | Drizzle ORM + Zod                             | Typed, validated boundaries                                          |
| Providers     | OpenAI, OpenAI-compatible, Ollama, Nvidia NIM | Config-driven via `CHASTE_AI_PROVIDER` (or `none` for rules-only)    |
| Email         | SMTP (nodemailer) / Resend                    | Config-driven outbound email                                         |
| Backups       | AES-256-GCM + S3 / local store                | Encrypted snapshot + restore                                         |
| Observability | Langfuse (optional)                           | Trace LLM calls when keys are configured                             |
| Deploy        | Docker (multi-target build)                   | `migrate` · `api` · `web` · `worker` images                         |

Set `CHASTE_AI_PROVIDER=none` for deterministic, rule-based planning with no external LLM — useful for zero-cost local evaluation.

---

## Development

```bash
pnpm lint          # TypeScript strict lint across the monorepo
pnpm typecheck     # TypeScript strict type checks
pnpm test          # Unit and integration tests
pnpm e2e           # Full API + Postgres end-to-end verification
pnpm build         # Compile all packages and apps
```

> Run `pnpm test` with a local PostgreSQL available. See [docs/configuration.md](docs/configuration.md) for environment setup.

---
## Deployment

Four container images (`migrate`, `api`, `web`, `worker`) are produced from a single [Dockerfile](Dockerfile) build targets (see [docs/deploy](docs/deploy/)):

| Target  | Runs                     |
| ------- | ------------------------ |
| `migrate` | one-off schema migrations |
| `api`     | HTTP API (`:3001`)       |
| `web`     | Next.js UI (`:3000`)     |
| `worker`  | outbox, email, backups   |

Per-provider guides: **AWS** · **GCP** · **Azure** · **Fly.io** · **Render** · **Railway** · **Supabase/Neon**.

```bash
# Example: build one target
docker build --target api -t chaste/api:0.1.0 .
```

Public images are published to **GHCR** (`ghcr.io/benaiah-muga/chastebusinessos`, tag per image: `api-`, `web-`, `worker-`, `migrate-`). See [docs/deploy/README.md](docs/deploy/README.md).

---

## Design constraints

1. `apps/web` → HTTP → `apps/api` only
2. Mutations → kernel commands (Zod + permissions + audit)
3. AI tools wrap commands; never raw SQL
4. Domain specialists are tool/profile scopes, not private backends
5. Events publish via transactional outbox after commit

---

## Documentation

| Doc | Purpose |
| --- | ------- |
| [configuration.md](docs/configuration.md) | Environment variables, AI providers, autonomy |
| [module-development.md](docs/module-development.md) | Authoring a new business module |
| [ai-autonomy-and-safety.md](docs/ai-autonomy-and-safety.md) | Autonomy levels and safety model |
| [deploy/](docs/deploy/) | Deployment guides + Docker usage |
| [specs/](docs/specs/) | Feature specifications (messaging, backup, AI, …) |
| [adr/](docs/adr/) | Architecture decision records |
| [AGENTS.md](AGENTS.md) | Rules for AI coding agents |

## Roadmap

See [docs/product-architecture-next.md](docs/product-architecture-next.md) for the full roadmap — semantic memory, capability-gap self-development, and marketplace extensions.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and follow the checks in [AGENTS.md](AGENTS.md).

## License

Distributed under the [Apache License 2.0](LICENSE). See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.