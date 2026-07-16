# Skill: Module author

Use when adding or changing an installable business module under `modules/`.

## Steps

1. Create `modules/<id>/` with package.json, tsconfig, `src/index.ts`.
2. Define `manifest` (id, version, permissions, capabilities, optional specialist profile).
3. Register commands/queries with Zod input/output and permission strings.
4. Tag commands for specialist routing (`tags: ["crm"]`).
5. Emit domain events only via outbox helpers after successful work.
6. Do not import `apps/web` or React.
7. Add contract tests.
8. Update docs if public API surface changed.

## Done when

- [ ] Module loads in API module registry
- [ ] Commands work via `POST /api/v1/commands/:name`
- [ ] Permissions enforced
- [ ] Tests pass
