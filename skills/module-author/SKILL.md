# Skill: Module author

Use when adding or changing an installable business module under `modules/`.

Full guide: `docs/module-development.md` (includes the AI harness integration
section — read it before adding commands/queries).

## Steps

1. Create `modules/<id>/` with package.json, tsconfig, `src/index.ts`.
2. Define `manifest` (id, version, permissions, capabilities, optional specialist profile).
3. Register commands/queries with Zod input/output and permission strings.
4. Tag commands for specialist routing (`tags: ["crm"]`).
5. **Give every `*.create` command a natural key.** The target must be uniquely
   identifiable — `name`, `sku`, `code`, or `email` — and the module's `*.list`
   query MUST return that field alongside `id` (the AI harness resolves names →
   ids and dedupes from it).
6. **Register a `NaturalKeyRule`** for each `*.create` in
   `packages/ai-core/src/tools/natural-key.ts` (`command`, `checkQuery`,
   `keyField`, `pick`, `entity`) so the agent loop's existence gate skips the
   write when the entity already exists instead of creating a duplicate. Add a
   unit test in `natural-key.test.ts`.
7. **Add a `platform.<domain>` skill** to
   `packages/ai-core/src/skills/platform-skills.ts` (keywords + instructions
   encoding the check-then-write doctrine: resolve via the list query, never
   re-create, which tools belong to the domain). The deterministic router
   injects it into the agent loop's system prompt for matching requests. Add a
   routing test in `platform-skills.test.ts`.
8. **Set a human-readable `description`** on commands and queries. The agent
   tool surface auto-annotates `(bus: <name>; read-only|write; skips if <entity>
   already exists …)`, but a domain description is what actually steers tool
   selection in a 143-tool prompt.
9. Emit domain events only via outbox helpers after successful work.
10. Do not import `apps/web` or React.
11. Add contract tests.
12. Register module in API loader (`apps/api` app-context).
13. Add marketplace listing in `packages/db` seed (`kind: builtin | custom`).
14. Add web route + workspace UI + `apps/web/src/lib/module-registry.ts` nav entry.
15. Add `@chaste/api-client` methods if the UI needs dedicated endpoints.
16. Update docs if public API surface changed.

## Done when

- [ ] Module loads in API module registry
- [ ] Commands work via `POST /api/v1/commands/:name`
- [ ] Permissions enforced
- [ ] Every `*.create` has a natural key + `NaturalKeyRule` + test
- [ ] `platform.<domain>` skill added + routing test
- [ ] Commands/queries carry domain descriptions
- [ ] Agentic path verified: a read request answers from the list query and a
      write request parks the right command (run `apps/api/src/nl-driver-agent.ts`),
      and a redundant create for an existing record is NOT proposed
- [ ] Install shows module in marketplace + nav; uninstall hides it
- [ ] Web overview tab has KPIs/charts where useful
- [ ] Tests pass