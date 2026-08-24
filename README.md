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
| **Accounting** | Double-entry GL with immutable postings and mirror reversals, AR/AP subledgers, period close, trial balance, P&L, balance sheet |
| **Approvals** | Human-in-the-loop gates on money above thresholds; identity and destructive actions always require a person |
| **Audit** | Append-only hash-chained event ledger of everything humans and agents did; replayable agent session trajectories |
| **CRM** | Customers and deals pipeline with weighted forecasting |
| **POS** | Register sessions, atomic cash/card sales, drawer counting with variance flagging |
| **Purchasing** | Vendors, bills, purchase orders with goods receipts and three-way matching |
| **Inventory** | Append-only stock ledger with moving-average valuation, reorder alerts, reservations, cycle counts, locations, lots |
| **Manufacturing** | Multi-level BOMs with scrap allowances, work orders, production runs with full reversal, lot traceability |
| **Messaging** | Team channels and DMs; the agent participates under its own authority |
| **Creator Mode** | The agent proposes platform changes as governed artifacts; humans merge |

## Quick start

Requirements: Node 22+, pnpm 11+, Docker (for Postgres 16 + pgvector), an NVIDIA API key ([build.nvidia.com](https://build.nvidia.com)).

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
```

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
