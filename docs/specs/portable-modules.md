# Spec: Portable modules

**Status:** Draft  
**Related:** [module-development.md](../module-development.md), [self-development.md](./self-development.md)

## 1. Goal

A module must be **shareable**: package once, install on another org or another ChasteBusinessOS instance (local or cloud), without private monorepo coupling.

## 2. Portability unit

```
module-package/
  manifest.json          # id, version, name, permissions, capabilities, dependencies
  dist/ or src/          # BusinessModule factory
  schema/                # optional SQL migrations / drizzle fragments (namespaced)
  ui-manifest.json       # optional nav/homeHref (consumed via HTTP, not React import)
  README.md
  LICENSE
```

**Rules:**

| Rule | Why |
|---|---|
| No imports of other modules’ private tables | Loose coupling |
| No dependency on `apps/web` React | Web is an API client |
| Namespaced permissions & commands | Collision-free install |
| Declarative `manifest.json` | Marketplace + install without loading code first |
| Version + semver dependencies | Safe upgrades |
| Export via marketplace or file/tarball | Share with another person/org |

## 3. Share paths

1. **Marketplace publish** — listing + package artifact (cloud or self-hosted registry).  
2. **Portable archive** — `chaste module pack <id>` → `.chaste-module.tgz` for side-load.  
3. **Git submodule / monorepo path** — developer workflow only; still builds to portable package for production.

## 4. Install contract

`core.module.install` accepts:

- `moduleId` from registry, or  
- `packageRef` (url / local path / digest) for side-load  

After install: permissions registered, commands/queries available, UI nav from registry or `ui-manifest`.

## 5. Standard features vs extensions

| Layer | How customized | Code change? |
|---|---|---|
| **Standard (platform + builtin modules)** | Settings, workflows, fields, autonomy, reports | No |
| **Config extensions** | Custom fields, NL workflows, templates | No |
| **Portable module** | Shared capability package | Yes (module code) |
| **Self-dev / coding agent** | Gap ticket → implement module/extension | Yes (gated pipeline) |

Never dump every tenant one-off into core.

## 6. Implementation phases

| Phase | Deliverable |
|---|---|
| P0 | Document + enforce namespace rules; a `demo.*` namespace portable sample |
| P1 | `manifest.json` export + pack command |
| P2 | Side-load install + signature/digest verify |
| P3 | Cross-instance marketplace sync |
