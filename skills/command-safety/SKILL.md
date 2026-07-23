# Skill: Command safety

Use when adding or modifying kernel commands or AI tools.

## Rules

1. Zod validate input and output.
2. Declare permissions; never skip checks.
3. Write audit success/failure via command bus (automatic if using `executeCommand`).
4. AI tools must call `executeCommand` / `executeQuery` -- no raw store access from AI layer.
5. Prefer idempotent designs for retried jobs.
6. Dangerous ops set `minAutonomyForAuto` appropriately.

## Done when

- [ ] No permission bypass
- [ ] Validation errors are clear
- [ ] Audit entry exists for attempts
- [ ] Test covers deny + allow paths
