/**
 * ARCH-6 — boot-time registry integrity test.
 *
 * Registers every shipped module against a fresh command/query registry and
 * asserts the boot never hits a duplicate command or query name. This catches
 * the "landmine" class of bug where a dead/abandoned module (or two modules
 * defining the same `crm.customer.*`/`core.modules.*` surface) would crash the
 * server at boot, long after a contributor follows the README and wires it up.
 */
import { describe, expect, it } from "vitest";
import { createCommandRegistry, createQueryRegistry, createModuleRegistry } from "@chaste/kernel";
import { createDb, type Db } from "@chaste/db";
import { createCrmModule } from "@chaste/module-crm";
import { createAccountingModule } from "@chaste/module-accounting";
import { createInventoryModule } from "@chaste/module-inventory";
import { createPurchasingModule } from "@chaste/module-purchasing";
import { createHrModule } from "@chaste/module-hr";
import { createManufacturingModule } from "@chaste/module-manufacturing";
import { createMessagingModule } from "@chaste/module-messaging";
import { createPlatformModule } from "@chaste/module-platform";

describe("module registry boot integrity", () => {
  it("registers every shipped module without duplicate command or query names", async () => {
    const commands = createCommandRegistry();
    const queries = createQueryRegistry();
    const modules = createModuleRegistry(commands, queries);

    // The module factories are dependency-injected; a real DB is only needed by
    // handlers at call time. createDb lazily connects, so this stays in-memory.
    const db = createDb(process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/db") as Db;

    const factories = [
      createCrmModule(db),
      createAccountingModule(db),
      createInventoryModule(db),
      createPurchasingModule(db),
      createHrModule(db),
      createManufacturingModule(db),
      createMessagingModule(db),
      createPlatformModule(db, modules, { allowFullAutonomous: true, regions: ["local"] }),
    ];

    for (const mod of factories) {
      await expect(modules.register(mod)).resolves.toBeUndefined();
    }

    const commandNames = commands.list().map((c) => c.name);
    const queryNames = queries.list().map((q) => q.name);
    const allNames = [...commandNames, ...queryNames];

    // No duplicates across the whole bus (including cross command-vs-query).
    const dupes = allNames.filter((n, i) => allNames.indexOf(n) !== i);
    expect(dupes).toEqual([]);
    expect(commandNames.length).toBeGreaterThan(50);
    expect(queryNames.length).toBeGreaterThan(10);

    // Sanity: platform-provided queries the web/API depends on are present.
    expect(queryNames).toContain("core.modules.list");
    expect(commandNames).toContain("crm.customer.create");
  });
});
