# Agent Onboarding Guide

This guide helps AI agents (Cursor, Copilot, opencode, etc.) contribute effectively to ChasteBusinessOS.

## First Read

**Start with `AGENTS.md`** -- it contains all non-negotiable rules, code locations, forbidden patterns, and required checks.

## Essential Commands

```bash
# Install dependencies
pnpm install

# Run all checks (required before finishing any task)
pnpm lint
pnpm typecheck
pnpm test

# Development
pnpm dev              # API + web + worker
pnpm --filter @chaste/api dev
pnpm --filter @chaste/web dev
pnpm --filter @chaste/worker dev

# Database
pnpm db:migrate       # Run migrations
pnpm db:generate      # Generate migrations after schema changes
```

## Common Tasks

### Adding a New Module
1. Read `skills/module-author` skill
2. Create `modules/<name>/` with manifest, commands, queries, schema
3. Update module registry
4. Add contract tests

### Adding a Command
1. Read `skills/command-safety` skill
2. Define Zod input/output schemas in module
3. Register command with permission string
4. Add audit coverage via command bus
5. Write contract test

### Working with AI Layer
- AI tools wrap kernel commands/queries only -- never raw SQL
- Domain specialists are tool/profile scopes, not private backends
- Autonomy gates: recommend → confirm → guarded_auto → full_autonomous
- Set `CHASTE_AI_PROVIDER=none` for deterministic planning

## Architecture Constraints

| Constraint | Rule |
|------------|------|
| Web ↔ API | `apps/web` → HTTP → `apps/api` only |
| Mutations | Via kernel commands (Zod + permissions + audit) |
| AI tools | Wrap commands; never raw SQL |
| Specialists | Tool/profile scopes, not private backends |
| Events | Publish via transactional outbox after commit |

## File Locations

| Change | Location |
|--------|----------|
| HTTP endpoints | `apps/api` |
| UI / chat rendering | `apps/web` |
| Commands, authz, audit | `packages/kernel` |
| Schema & migrations | `packages/db` |
| AI orchestration | `packages/ai-core` |
| Business features | `modules/<name>` |
| Shared client types | `packages/api-client` |

## Testing

- Unit tests: `pnpm test`
- E2E tests: `pnpm e2e` (requires Postgres)
- Contract tests required for every command/query

## Configuration

- Secrets: `.env` (never committed), see `.env.example`
- Typed config: `@chaste/config` with Zod validation
- AI provider: `CHASTE_AI_PROVIDER` (openai, ollama, nim, none)

## Getting Help

- `AGENTS.md` -- complete rules and workflows
- `docs/module-development.md` -- module authoring
- `docs/ai-autonomy-and-safety.md` -- AI safety
- `docs/configuration.md` -- environment setup
- `docs/adr/` -- architectural decisions