# Skill: Module author

Use when adding or changing an installable business module under `modules/`.

Full guide: `docs/module-development.md`.

## Steps

1. Create `modules/<id>/` with package.json, tsconfig, `src/index.ts`.
2. Define `manifest` (id, version, permissions, capabilities, optional specialist profile).
3. Register commands/queries with Zod input/output and permission strings.
4. Tag commands for specialist routing (`tags: ["crm"]`).
5. Emit domain events only via outbox helpers after successful work.
6. Do not import `apps/web` or React.
7. Add contract tests.
8. Register module in API loader (`apps/api` app-context).
9. Add marketplace listing in `packages/db` seed (`kind: builtin | custom`).
10. Add web route + workspace UI + `apps/web/src/lib/module-registry.ts` nav entry.
11. Add `@chaste/api-client` methods if the UI needs dedicated endpoints.
12. Update docs if public API surface changed.

## Done when

- [ ] Module loads in API module registry
- [ ] Commands work via `POST /api/v1/commands/:name`
- [ ] Permissions enforced
- [ ] Install shows module in marketplace + nav; uninstall hides it
- [ ] Web overview tab has KPIs/charts where useful
- [ ] Tests pass
