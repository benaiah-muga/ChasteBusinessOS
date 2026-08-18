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
- [ ] If the PR adds/changes a `*.create` command or a domain surface: natural
      key + `NaturalKeyRule` in `packages/ai-core/src/tools/natural-key.ts` +
      test, domain descriptions, and a `platform.<domain>` skill + routing test
      in `packages/ai-core/src/skills/platform-skills.ts` (see the module-author
      and command-safety skills)
- [ ] If the PR touches the agent loop (`packages/ai-core`): the deterministic
      drivers (`apps/api/src/nl-driver.ts`, `nl-driver-ops.ts`) and the agentic
      driver (`nl-driver-agent.ts`) still pass