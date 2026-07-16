# Module Development Guide

Modules are the unit of business capability in ChasteBusinessOS.

## Rules (for humans and agents)

1. **Public contracts only** — other modules consume your commands, queries, and events — not your tables.
2. **Namespaced data** — tables use a clear prefix (`crm_customers`, not `customers` alone when ambiguous).
3. **All writes via commands** — with Zod input/output and permission strings.
4. **Outbox for events** — publish after successful commit through kernel helpers.
5. **No web imports** — modules must not depend on `apps/web` or React.
6. **Optional UI** — expose APIs; web discovers capabilities. Module-specific React packages are a future concern and still talk HTTP.
7. **AI tools = commands/queries** — declare capability tags for specialist routing; do not invent a parallel tool API.
8. **Tests** — contract tests for every command and query.

## Manifest shape

```ts
export const manifest = {
  id: "demo-crm",
  name: "Demo CRM",
  version: "0.1.0",
  dependencies: [],
  permissions: ["crm.customer.create", "crm.customer.read"],
  capabilities: ["crm.customers"],
  specialist: {
    id: "crm",
    displayName: "CRM Agent",
    description: "Customers and relationship data",
    toolTags: ["crm"],
  },
} as const;
```

## Checklist

- [ ] `module.manifest.ts`
- [ ] Commands + queries registered on load
- [ ] Schema/migrations if needed
- [ ] Permissions documented
- [ ] Contract tests
- [ ] Events documented (produced/consumed)
- [ ] No cross-module private joins
