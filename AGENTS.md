# AGENTS.md -- Rules for AI coding agents

You are contributing to **ChasteBusinessOS**, an AI-native Business Operating
System. Optimize for **reliability, loose coupling, and auditability** -- not
clever shortcuts.

## Non-negotiable product invariants

1. **AI/manual parity** -- AI executes only through the same command/query bus as humans.
2. **No elevated AI privileges** -- never bypass permissions, validation, or audit.
3. **Frontend is an API client** -- `apps/web` must not import kernel, db, or modules.
4. **Zod validates intent and payloads** at boundaries (HTTP, commands, chat UI parts).
5. **Events after commit** -- use transactional outbox; do not dual-write carelessly.
6. **Explainability** -- AI-assisted paths record why/what/rules when you touch that layer.

## Where to put code

| Change | Location |
|---|---|
| HTTP endpoints | `apps/api` |
| UI / chat rendering | `apps/web` (via API + `@chaste/ui-schema`) |
| Commands, authz, audit, module loader | `packages/kernel` |
| Schema & migrations | `packages/db` (+ module schemas) |
| AI orchestration | `packages/ai-core` (invoked by api/worker only) |
| Business features | `modules/<name>` |
| Shared request/response types for clients | `packages/api-client` |

## Forbidden patterns

- Importing `@chaste/kernel` or `@chaste/db` from `apps/web`
- Direct SQL/table access from AI tool handlers
- Cross-module private table joins
- Secrets in source, fixtures, or logs
- “Temporary” bypasses of permission checks
- Inventing analytics numbers without a verifiable query path

## Required checks before you finish

```bash
pnpm lint
pnpm typecheck
pnpm test
```

If you add a module or command:

- Manifest updated
- Zod input/output schemas
- Permission string(s)
- Audit coverage via command bus
- Contract test for the command
- API route only if intentionally public; prefer generic command/query routes when possible

## Skills

Use repo skills under `skills/` when relevant:

- `skills/module-author` -- new modules
- `skills/command-safety` -- commands & permissions
- `skills/pr-hygiene` -- PR completeness

## Style

- TypeScript strict; prefer explicit types at public boundaries.
- Small, reviewable diffs.
- Prefer extending existing patterns over new frameworks.
- Document architectural choices in `docs/adr/` when non-obvious.
