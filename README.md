<div align="center">

# ChasteBusinessOS

**The agentic ERP. Describe your business, and an AI co-worker runs it under your authority.**

[![Release](https://img.shields.io/github/v/release/benaiah-muga/ChasteBusinessOS?label=release&sort=semver)](https://github.com/benaiah-muga/ChasteBusinessOS/releases)
[![CI](https://github.com/benaiah-muga/ChasteBusinessOS/actions/workflows/ci.yml/badge.svg)](https://github.com/benaiah-muga/ChasteBusinessOS/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](tsconfig.base.json)
[![Status](https://img.shields.io/badge/status-alpha-orange.svg)](ROADMAP.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[![Vision](https://img.shields.io/badge/Vision-📖-8A2BE2)](VISION.md)
[![Architecture](https://img.shields.io/badge/Architecture-📐-blue)](ARCHITECTURE.md)
[![Roadmap](https://img.shields.io/badge/Roadmap-🗺️-green)](ROADMAP.md)
[![Contributing](https://img.shields.io/badge/Contributing-🤝-orange)](CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/Code_of_Conduct-🛡️-red)](CODE_OF_CONDUCT.md)
[![Security](https://img.shields.io/badge/Security-🔒-black)](SECURITY.md)
[![Changelog](https://img.shields.io/badge/Changelog-📜-yellow)](CHANGELOG.md)

[Features](#features) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Demos](#demo-proofs) · [Docs](#documentation) · [Contributing](#contributing) · [License](#license)

</div>

---

Most ERPs fail at adoption, not at features. Teams spend months implementing them and years clicking through every screen by hand. ChasteBusinessOS takes a different position: you describe your business in plain language, an AI co-worker configures and operates as much as possible on your behalf, and every action it takes passes through the same governance yours does.

It cannot spend above your approval threshold without sign-off. It cannot assign itself a role. When it meets something it can't do, it files a ticket instead of improvising.

## Features

| Area | What works today |
|---|---|
| **Accounting** | Double-entry GL with immutable postings and mirror reversals, AR/AP subledgers, period close, trial balance, P&L, balance sheet, direct-method cash flow, customer and supplier statements, 13-week cash forecast |
| **Approvals** | Human-in-the-loop gates on money above thresholds; identity and destructive actions always require a person |
| **Audit** | Append-only hash-chained event ledger of everything humans and agents did; replayable agent session trajectories |
| **Sales** | Reservation-anchored orders: confirming checks credit headroom and reserves stock, delivery consumes reservations and invoices exactly what shipped, oversell is refused |
| **CRM** | Leads, deals pipeline with weighted forecasting, lead conversion, tasks with due dates, duplicate detection, and a customer 360 timeline merging invoices, payments, quotes, deals and tasks |
| **POS** | Register sessions, atomic cash/card sales, drawer counting with variance flagging, always-gated full-sale returns, and per-register shift summaries |
| **Purchasing** | Vendors, bills, purchase orders with goods receipts and three-way matching, payment terms, supplier price history and lead-time memory, close-with-backorder |
| **Inventory** | Append-only stock ledger with moving-average valuation, reorder alerts, reservations, cycle counts, locations, lots, internal transfers, barcodes, and GL reconciliation |
| **Manufacturing** | Multi-level BOMs with scrap allowances, work orders, production runs with full reversal, lot traceability, can-we-produce-N planning |
| **People & projects** | Employee structure, attendance with late flags, derived leave balances, recruitment-lite through to hire, projects kanban, and expense claims with policy limits and duplicate detection |
| **Marketing** | Saved deterministic segments, campaigns with opt-out honoured at send time, and the append-only send log as the analytics (no tracking pixels) |
| **Support** | Helpdesk tickets with numbers, priority/category/SLA, canned responses, KB articles, and SLA-breach signals |
| **Documents** | Folders, business-record links, and append-only version history with expiry signals |
| **Understanding** | `analytics.explainChange` decomposes a revenue change into exact, property-tested contributions with drill-to-invoice; `askYourBusiness` answers from cited extracts and proposes a governed action |
| **Signals** | Cross-module needs-attention registry: deterministic producers aggregated red-first with evidence and a suggested governed action |
| **Routines** | The agent on a schedule in plain language, running headless under a least-privilege bundle, silent on `NO_ACTION`, triggerable by webhook |
| **Messaging** | Team channels and DMs; the agent participates under its own authority |
| **Creator Mode** | The agent proposes platform changes as governed artifacts; humans merge |

## Quick start

Requirements: Node 24+ (matches CI), pnpm 11+, Docker (for Postgres 16 + pgvector), and one model provider key — NVIDIA NIM ([build.nvidia.com](https://build.nvidia.com)) by default, or OpenRouter, Groq, Mistral, or Z.ai (GLM) via `MODEL_PROVIDER`.

```sh
git clone https://github.com/benaiah-muga/ChasteBusinessOS.git
cd ChasteBusinessOS
pnpm install

cp .env.example .env        # add NVIDIA_API_KEY and BETTER_AUTH_SECRET

docker run -d --name chaste-pgvector \
  -e POSTGRES_PASSWORD=chaste_dev -e POSTGRES_USER=chaste \
  -e POSTGRES_DB=chaste_os_v2 -p 5433:5432 pgvector/pgvector:pg16

pnpm --filter @chaste/db db:migrate
pnpm dev                    # http://localhost:3000
```

Sign up, describe your business in two sentences, and the workspace builds itself: chart of accounts seeded, description embedded into org memory, owner role granted to you.

## How it works

One rule holds the whole system together: there is exactly one way to change state, and humans and agents share it.

```
intent → resolve capability → validate input → check permissions
      → policy evaluation → [execute | request approval]
      → append to ledger → notify
```

Clicking "pay invoice" in the UI and typing "pay the Acme invoice" in chat reach the same executor with the same capability ID. One path means one place for security review, and automatic parity between what you can do and what your AI co-worker can do.

Capabilities carry their own contract: zod schemas, risk class (`read`, `write`, `money`, `identity`, `destructive`), permission reference, and an inverse action so state changes stay reversible. The registry validates all of it at boot; a module declaring an inverse that doesn't exist refuses to start the server.

## Demo proofs

Each script is an executable specification. If one fails, that's a bug worth knowing about.

```sh
pnpm demo:slice   # customer → invoice → gated payment → approval → trial balance
pnpm demo:m4      # vendor bill → gated payment → P&L and balance sheet prove out
pnpm demo:m5      # register session → sales → drawer variance flagged
pnpm demo:m7      # inventory → GL reconciliation, transfers, products
pnpm demo:m8      # needs-attention signals, governed reorder approve/decline
pnpm demo:m9      # quote-to-cash: fulfillment, credit guard, expiry, customer 360
pnpm demo:m10     # cash flow, credit notes, statements, reminders, forecast
pnpm demo:m11     # hire → project → time → expense → approve
pnpm demo:m12     # revenue decomposition, ask-your-business, tickets, documents
pnpm demo:m13     # POS returns, shift summaries, marketing-lite
```

Most take a subcommand to run one proof, e.g. `pnpm demo:m9 fulfillment`.
Every demo needs a migrated database, and several also drive the real agent
and so need a model provider key — CI skips the whole set when no key is
configured, so a missing key looks like a skipped job rather than a failure.

## Upgrading

Updates ship as new app code plus incremental database migrations. Your data
survives updates: migrations are additive `ALTER`s applied in place by
Drizzle's idempotent migrator, and a `pg_dump` snapshot is taken
automatically before any migration runs.

```sh
git pull            # get the new version
pnpm install
pnpm dev            # or: pnpm build && pnpm start
```

That's it. The web server applies pending migrations once at boot, before it
accepts requests (serialized across instances by a Postgres advisory lock),
so you can't end up serving new code against an old schema.

Controls and safety nets:

- Pre-migration snapshots live in `packages/db/backups/` (newest 10 kept).
  Restore one with `psql "$DATABASE_URL" < <snapshot>.sql` after stopping the
  app. Snapshots use the host `pg_dump`, falling back to the one inside the
  database container when the host client is missing or older than the
  server; override with `CHASTE_PG_DUMP_BIN` (a command with flags) or rename
  the container with `CHASTE_DB_CONTAINER`.
- Set `CHASTE_STRICT_MIGRATION_BACKUP=1` in production to refuse migrating
  when a snapshot cannot be taken (e.g. `pg_dump` not installed and no
  container fallback available).
- Set `AUTO_MIGRATE_ON_BOOT=0` if you prefer to migrate manually with
  `pnpm --filter @chaste/db db:migrate`; the app then refuses to start in
  production until the schema is current.
- Upgrade notes for behavioral changes are in [CHANGELOG.md](CHANGELOG.md)
  under the version you're moving to.

## Documentation

- [Vision](VISION.md), what we're building and what we won't compromise
- [Architecture](ARCHITECTURE.md), capability kernel, governance pipeline, memory tiers
- [Roadmap](ROADMAP.md), milestones and standing principles
- [ADRs](docs/adr/), why things are the way they are
- [Changelog](CHANGELOG.md), every behavioral change, per Keep a Changelog

## Contributing

Read [AGENTS.md](AGENTS.md) even if you're human. It defines the conventions, the verification gate (typecheck, lint, tests, then break a demo), and the rules for authoring new capabilities. Significant decisions get an ADR; behavioral changes get a changelog entry.

See [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Found something exploitable? Please report privately per [SECURITY.md](SECURITY.md) rather than opening an issue.

## License

[Apache License 2.0](LICENSE)
