# Copilot Instructions for ChasteBusinessOS

This repository uses **AGENTS.md** as the single source of truth for AI agent behavior.

## Quick Start for Agents

1. **Read `AGENTS.md` first** -- it contains all rules, invariants, and workflows
2. **Follow the "Where to put code" table** -- HTTP endpoints in `apps/api`, UI in `apps/web`, commands in `packages/kernel`, etc.
3. **Respect forbidden patterns** -- no kernel/db imports in web, no raw SQL from AI tools, no cross-module private joins
4. **Run required checks before finishing**:
   ```bash
   pnpm lint
   pnpm typecheck
   pnpm test
   ```

## Key Principles

- **AI/manual parity**: AI executes through the same command/query bus as humans
- **No elevated AI privileges**: Never bypass permissions, validation, or audit
- **Frontend is an API client**: `apps/web` consumes REST only
- **Zod validates boundaries**: HTTP, commands, chat UI parts
- **Events after commit**: Use transactional outbox

## Skills

When relevant, load these skills via the skill tool:
- `skills/module-author` -- new modules
- `skills/command-safety` -- commands & permissions
- `skills/pr-hygiene` -- PR completeness

## Project Structure

```
apps/
  api/     Fastify HTTP API
  web/     Next.js UI (API client only)
  worker/  Background jobs

packages/
  kernel/     Command/query bus, authz, audit
  db/         Drizzle schema, migrations
  ai-core/    Orchestrator, Mastra agents
  api-client/ Typed HTTP client
  ui-schema/  Generative chat UI schemas

modules/
  crm, accounting, inventory, purchasing, manufacturing, hr, platform, core-system, demo-crm
```

See `AGENTS.md` for complete details.