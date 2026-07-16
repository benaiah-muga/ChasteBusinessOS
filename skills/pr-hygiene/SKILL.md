# Skill: PR hygiene

Use before opening or finalizing a PR.

## Checklist

- [ ] Scope is focused and described
- [ ] `apps/web` still has zero imports of kernel/db/ai-core/modules
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass
- [ ] New boundaries use Zod
- [ ] Secrets not committed
- [ ] ADR added for architectural decisions
- [ ] User-facing docs updated when behavior changes
