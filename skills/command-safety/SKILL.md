# Skill: Command safety

Use when adding or modifying kernel commands or AI tools.

## Rules

1. Zod validate input and output.
2. Declare permissions; never skip checks.
3. Write audit success/failure via command bus (automatic if using `executeCommand`).
4. AI tools must call `executeCommand` / `executeQuery` -- no raw store access from AI layer.
5. Prefer idempotent designs for retried jobs.
6. Dangerous ops set `minAutonomyForAuto` appropriately.
7. **Creates are natural-key idempotent by convention.** A `*.create` command
   whose target is uniquely identifiable must be guarded by the harness
   existence gate: add a `NaturalKeyRule` in
   `packages/ai-core/src/tools/natural-key.ts` and ensure the module's `*.list`
   query returns the natural key (`name`/`sku`/`code`/`email`) plus `id`. The
   agent loop then skips the write and reports the existing record instead of
   proposing a duplicate. A create that CANNOT be deduped by a natural key is a
   design smell — revisit the entity model.
8. **Gate visibility = read permission.** The existence gate consults the
   actor's own `*.list` query, so the create's permission should be accompanied
   by a corresponding read permission, or the gate silently no-ops (the write
   still happens — the gate is best-effort, never a write blocker).
9. **Descriptions steer the agent.** Set a domain `description` on every
   command/query — the harness surfaces it verbatim (plus auto `read-only`
   / `skips if …` hints) and the model chooses tools from it.
10. **New domains need a platform skill.** When adding a domain's commands,
    also add the matching `platform.<domain>` skill def in
    `packages/ai-core/src/skills/platform-skills.ts` (keywords + instructions)
    so the router injects the check-then-write doctrine into the agent loop.

## Done when

- [ ] No permission bypass
- [ ] Validation errors are clear
- [ ] Audit entry exists for attempts
- [ ] Test covers deny + allow paths
- [ ] `*.create` has a natural key + `NaturalKeyRule` + test
- [ ] List query returns the natural key; read permission accompanies create
- [ ] Domain description set; `platform.<domain>` skill + routing test added
      when the domain is new