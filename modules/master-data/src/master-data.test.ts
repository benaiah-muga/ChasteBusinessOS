/**
 * ARCH-3 — contract test for the extracted master-data module.
 *
 * Verifies the `core.bpartner.*` surface that the API/web depend on is
 * registered with the right names and permissions, so the extraction from the
 * platform module can never silently drop a command/query.
 */
import { describe, expect, it } from "vitest";
import { createCommandRegistry, createQueryRegistry, createModuleRegistry } from "@chaste/kernel";
import { createDb, type Db } from "@chaste/db";
import { createMasterDataModule } from "./index.js";

describe("master-data module contract", () => {
  it("registers the bpartner command/query surface with expected permissions", async () => {
    const commands = createCommandRegistry();
    const queries = createQueryRegistry();
    const modules = createModuleRegistry(commands, queries);
    const db = createDb(
      process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/db",
    ) as Db;

    await modules.register(createMasterDataModule(db));

    const commandByName = new Map(commands.list().map((c) => [c.name, c]));
    const queryByName = new Map(queries.list().map((q) => [q.name, q]));

    expect(commandByName.get("core.bpartner.create")?.permissions).toEqual(["core.bpartner.manage"]);
    expect(commandByName.get("core.bpartner.update")?.permissions).toEqual(["core.bpartner.manage"]);
    expect(commandByName.get("core.bpartner.delete")?.permissions).toEqual(["core.bpartner.manage"]);
    expect(queryByName.get("core.bpartner.list")?.permissions).toEqual(["core.bpartner.read"]);
    expect(queryByName.get("core.bpartner.get")?.permissions).toEqual(["core.bpartner.read"]);

    expect(modules.list().map((m) => m.id)).toContain("master-data");
  });
});