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

### Portability checklist

| Requirement | Detail |
|---|---|
| Declarative manifest | `id`, `version`, permissions, capabilities, dependencies |
| No cross-module private joins | Only public commands/queries/events |
| Namespaced tables & permissions | Collision-free side-load |
| Optional `ui-manifest.json` | Nav/homeHref via HTTP, not React import from module package |
| Share paths | Marketplace publish, `.chaste-module.tgz` pack, or monorepo path for dev |

**Standard platform features** (branches, RBAC, settings, notifications) are customized without code. Self-dev / coding agents only for out-of-scope capabilities ([specs/self-development.md](./specs/self-development.md)).

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
- `*.list` (with search/filter), `*.get` (detail) queries
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

## Forbidden patterns

- Importing `@chaste/kernel` or `@chaste/db` from `apps/web`
- Direct SQL from AI tool handlers
- Cross-module private table joins
- Secrets in source or logs
- Bypassing permission checks for “temporary” UI convenience
