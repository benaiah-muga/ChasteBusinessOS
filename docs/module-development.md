# Module Development Guide

Modules are the unit of business capability in ChasteBusinessOS, similar to
Odoo apps: backend capability + optional frontend surface, installed per
organization through the marketplace.

## Rules (for humans and agents)

1. **Public contracts only** -- other modules consume your commands, queries, and events -- not your tables.
2. **Namespaced data** -- tables use a clear prefix (`crm_customers`, not `customers` alone when ambiguous).
3. **All writes via commands** -- with Zod input/output and permission strings.
4. **Outbox for events** -- publish after successful commit through kernel helpers.
5. **No web imports** -- modules must not depend on `apps/web` or React.
6. **Optional UI** -- expose APIs; web discovers capabilities. Module React lives in `apps/web` and talks HTTP only.
7. **AI tools = commands/queries** -- declare capability tags for specialist routing; do not invent a parallel tool API.
8. **Tests** -- contract tests for every command and query.
9. **Portable by default** -- a module must be packable and shareable with another org/instance without private monorepo coupling. See [specs/portable-modules.md](./specs/portable-modules.md).
10. **Creates are natural-key idempotent by convention** -- every `*.create` command has a uniquely-identifying natural key (`name`, `sku`, `code`, `email`) surfaced by the module's `*.list` query, and a matching `NaturalKeyRule` in `packages/ai-core/src/tools/natural-key.ts`. The AI harness existence gate then skips redundant creates instead of duplicating records (see "AI harness integration" below).
11. **New domains ship a platform skill** -- add a `platform.<domain>` def in `packages/ai-core/src/skills/platform-skills.ts` so the agent loop routes the domain's check-then-write doctrine into its prompt.

### Portability checklist

| Requirement | Detail |
|---|---|
| Declarative manifest | `id`, `version`, permissions, capabilities, dependencies |
| No cross-module private joins | Only public commands/queries/events |
| Namespaced tables & permissions | Collision-free side-load |
| Optional `ui-manifest.json` | Nav/homeHref via HTTP, not React import from module package |
| Share paths | Marketplace publish, `.chaste-module.tgz` pack, or monorepo path for dev |

**Standard platform features** (branches, RBAC, settings, notifications) are customized without code. Self-dev / coding agents only for out-of-scope capabilities ([specs/self-development.md](./specs/self-development.md)).

## AI harness integration (agent tool loop)

Every registered command and query automatically becomes a native function
tool in the agent loop (`packages/ai-core/src/tools/from-bus.ts` → exposed under
the actor's own permissions). No separate AI API. Three integration duties make
a module's tools **efficient** (model picks the right one) and **reliable**
(model never proposes a duplicate or an invented id):

### 1. Existence gate (no redundant creates)

`packages/ai-core/src/tools/natural-key.ts` maps each guarded `*.create` to a
`checkQuery` and `keyField`. Before the write dispatches (or parks), the gate
runs the actor's own `*.list` query, matches the natural key, and if the record
exists it **skips the write** and returns "already exists as <id>". It is
best-effort: if the read fails (no permission) or no rule matches, the write
proceeds normally — the gate never blocks a legitimate write.

To guard a new create:

```ts
// packages/ai-core/src/tools/natural-key.ts — add to NATURAL_KEY_RULES
{
  command: "example.item.create",          // bus command name
  checkQuery: "example.item.list",         // must return id + natural key
  keyField: "code",                        // name | sku | code | email
  pick: (data) => {
    const items = ((data as { items?: { id: string; code: string }[] }).items ?? []);
    return items.map((i) => ({ id: i.id, label: i.code }));
  },
  entity: "Item",
}
```

Contract: the `*.list` query returns `id` + the natural-key field, and the read
permission is granted wherever the create is (otherwise the gate silently
no-ops). Add a unit test in `tools/natural-key.test.ts`.

### 2. Platform domain skills (tool selection steering)

`packages/ai-core/src/skills/platform-skills.ts` holds one doctrine block per
domain (`platform.purchasing`, `platform.inventory`, …). A deterministic
keyword router matches the user's request and injects the matched blocks into
the agent loop's system prompt before any tool call. Each new module should add
one:

```ts
{
  name: "platform.example",
  title: "Example domain — items and codes",
  summary: "Resolve items via example.item.list; never re-create an existing code.",
  keywords: ["item", "items", "code"],
  instructions:
    "Domain: example (example.*).\n" +
    "- Discover items with example.item.list; resolve code → id before any write.\n" +
    "- example.item.create: only for a code that does NOT already exist; the gate skips duplicates and reports the existing id.\n" +
    "- Answer read questions from example.item.list with real org data.",
}
```

The defs are also visible to the skill catalog and `loadSkill` (they merge into
`PostgresSkillStore` as read-only platform skills). Add a routing test in
`skills/platform-skills.test.ts`.

### 3. Descriptions (what the model reads)

The tool surface auto-annotates each tool as `(bus: <name>; read-only|write;
skips if the <entity> already exists …)`. Set a real `description` on every
`defineCommand` / `defineQuery` — with 143 tools in the prompt, the description
is the primary steer. Commands that require approval still show the same card
as a human confirm: the agent never bypasses `minAutonomyForAuto`.

Verify end to end with `apps/api/src/nl-driver-agent.ts` (add a case for your
module): a read request must answer from the `*.list` query, a write must park
the right command, and a create for an already-existing record must NOT reach
the confirm card.

## End-to-end module lifecycle (Odoo-like)

```
modules/<id>/          Backend package (manifest, commands, queries, schema)
       │
       ▼
API module loader      Registers on process boot (apps/api app-context)
       │
       ▼
Marketplace listing    packages/db seed + marketplace_listings row
       │
       ▼
Install / uninstall    core.module.install | core.module.uninstall
       │
       ▼
module_installs        Per-org enabled flag
       │
       ▼
apps/web registry      lib/module-registry.ts maps moduleId → route/nav
       │
       ▼
Module workspace UI    apps/web/src/components/<module>/ + app/<module>/page.tsx
```

### 1. Backend module package

Create `modules/<id>/` with:

| File | Purpose |
|------|---------|
| `package.json` | Workspace package `@chaste/module-<id>` |
| `tsconfig.json` | Extends monorepo base |
| `src/index.ts` | `createXModule(db): BusinessModule` |

Manifest shape:

```ts
export function createExampleModule(db: Db): BusinessModule {
  return {
    manifest: {
      id: "example",
      name: "Example",
      version: "0.1.0",
      description: "What this module does for operators",
      dependencies: [],
      permissions: ["example.item.read", "example.item.manage"],
      capabilities: ["example.items"],
      specialist: {
        id: "example",
        displayName: "Example Agent",
        description: "Handles example domain work",
        toolTags: ["example"],
      },
    },
    register({ commands, queries }) {
      // defineCommand / defineQuery with Zod + permissions
    },
  };
}
```

### 2. Wire into the API loader

In `apps/api/src/app-context.ts` (or the active module bootstrap):

1. Import `createExampleModule`
2. Register it with the kernel `ModuleRegistry`
3. Ensure permissions appear in `packages/db` `PERMISSION_CATALOG` / seed

Commands become available at:

- `POST /api/v1/commands/:name`
- `POST /api/v1/queries/:name`

Prefer dedicated REST routes only when the product intentionally exposes them
(for example list endpoints used by the web).

### 3. Marketplace listing

Add a row to the marketplace catalog in `packages/db/src/seed.ts`:

```ts
{
  moduleId: "example",
  name: "Example",
  version: "0.1.0",
  summary: "Operator-facing summary",
  category: "operations",
  kind: "builtin", // or "custom"
}
```

- **Built-in** modules ship with the product (`publisher: chaste`, `kind: builtin`).
- **Custom** modules are third-party / community style listings.
- **Archived** listings use `metadata.archived: true` and are hidden from the UI.
- **Uninstalled** modules are removed from `module_installs` and disappear from nav.

Install / uninstall / archive commands:

| Command | Effect |
|---------|--------|
| `core.module.install` | Upsert install row, `enabled: true` |
| `core.module.uninstall` | Delete install row for the org |
| `core.module.set_enabled` | Toggle enabled without removing install |
| `core.marketplace.archive` | Hide listing from catalog |

### 4. Frontend surface

The web app is an HTTP client only. For each installed module:

1. **Route** -- `apps/web/src/app/<id>/page.tsx` (server component loads data)
2. **Workspace** -- `apps/web/src/components/<id>/<Name>Workspace.tsx` (client UI with tabs, KPIs, charts)
3. **Nav registry** -- add entry in `apps/web/src/lib/module-registry.ts`:

```ts
{ moduleId: "example", href: "/example", label: "Example", group: "business" }
```

4. **API client** -- add typed methods on `@chaste/api-client` when the surface is stable
5. **Icons** -- map `href → Lucide icon` in `AppShell`

`AppShell` loads `GET /api/v1/modules` and only shows business nav items whose
`moduleId` is installed and enabled. System pages (`marketplace`, `settings`, …)
use `always: true`.

### 5. UI conventions for modules

Every module landing screen should follow this pattern:

1. **Overview tab** -- KPIs + charts (Recharts via `components/ui/Chart`)
2. **Primary list tabs** -- tables for core entities with search, filter, and
   per-row actions (view / edit / delete)
3. **Create / action tabs** -- forms that call the same APIs as the agent
4. **Detail pages** -- `app/<module>/<entity>/[id]/page.tsx` for drill-down with
   related panels, lifecycle controls, and an activity timeline
5. Human copy only (no raw command names or HTTP paths in the operator UI)

**Deep module pattern** (ADR 0008): a module is "deep" when it covers the full
lifecycle end-to-end — list (with filter/search), detail (with related data),
create + edit + status transitions + soft-delete, and an activity timeline.
CRM is the reference implementation; copy its structure for new modules.

Shared primitives (`apps/web/src/components/ui/`):

- `Tabs` / `Tab` / `TabPanel`
- `Kpi`
- `ChartCard`, `AreaSeries`, `BarSeries`, `DonutChart`
- `Select` for styled dropdowns
- `Modal`, `ConfirmDialog` for dialogs and destructive-action confirmation
- `StatusBadge` for pipeline / lifecycle state pills
- `Timeline` for activity history (created, status changes, notes, calls, …)

Backend depth checklist (per entity):

- `*.create`, `*.update`, `*.delete` (soft), `*.setStatus` commands
- `*.list` (with search/filter), `*.get` (detail) queries — the list returns `id` + natural key
- `NaturalKeyRule` in `packages/ai-core/src/tools/natural-key.ts` for each create
- `platform.<domain>` skill + routing test in `packages/ai-core/src/skills/platform-skills.ts`
- Domain `description` on every command/query
- Outbox events for every write
- Activity/interaction log table + `*.interaction.log` command + `*.interaction.list` query
- Permission strings in `PERMISSION_CATALOG` seed
- Contract test coverage (e2e or vitest)

### 6. Checklist

- [ ] `modules/<id>` package builds and typechecks
- [ ] Manifest + permissions + capabilities
- [ ] Commands + queries registered with Zod
- [ ] Contract tests
- [ ] Schema/migrations if needed
- [ ] Permission catalog seed updated
- [ ] Marketplace listing (builtin or custom)
- [ ] API loader registration
- [ ] `@chaste/api-client` methods (if public)
- [ ] Web route + workspace UI + nav registry entry
- [ ] Install shows the app; uninstall hides it from nav
- [ ] Every `*.create` has a natural key + `NaturalKeyRule` + test
- [ ] `platform.<domain>` skill + routing test
- [ ] Domain descriptions set on commands/queries
- [ ] Agentic path verified via `nl-driver-agent.ts` (read answers, write parks,
      redundant create not proposed)

## Forbidden patterns

- Importing `@chaste/kernel` or `@chaste/db` from `apps/web`
- Direct SQL from AI tool handlers
- Cross-module private table joins
- Secrets in source or logs
- Bypassing permission checks for “temporary” UI convenience
