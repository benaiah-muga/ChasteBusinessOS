/**
 * ARCH-3 — contract test for the extracted identity module.
 *
 * Verifies the `core.rbac.*`, `core.role.*`, and `core.user.*` surface the
 * API/web depend on is registered with the right names and permissions, so the
 * extraction from the platform module can never silently drop a command/query.
 */
import { describe, expect, it } from "vitest";
import { createCommandRegistry, createQueryRegistry, createModuleRegistry } from "@chaste/kernel";
import { createDb, type Db } from "@chaste/db";
import { createIdentityModule } from "./index.js";

describe("identity module contract", () => {
  it("registers the rbac/role/user surface with expected permissions", async () => {
    const commands = createCommandRegistry();
    const queries = createQueryRegistry();
    const modules = createModuleRegistry(commands, queries);
    const db = createDb(
      process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/db",
    ) as Db;

    await modules.register(createIdentityModule(db));

    const commandByName = new Map(commands.list().map((c) => [c.name, c]));
    const queryByName = new Map(queries.list().map((q) => [q.name, q]));

    expect(queryByName.get("core.rbac.overview")?.permissions).toEqual(["core.rbac.read"]);
    expect(queryByName.get("core.user.list")?.permissions).toEqual(["core.user.read"]);

    expect(commandByName.get("core.role.create")?.permissions).toEqual(["core.role.manage"]);
    expect(commandByName.get("core.role.update")?.permissions).toEqual(["core.role.manage"]);
    expect(commandByName.get("core.role.delete")?.permissions).toEqual(["core.role.manage"]);
    expect(commandByName.get("core.user.create")?.permissions).toEqual(["core.user.manage"]);
    expect(commandByName.get("core.user.invite")?.permissions).toEqual(["core.user.manage"]);
    expect(commandByName.get("core.user.activate")?.permissions).toEqual(["core.user.manage"]);
    expect(commandByName.get("core.user.deactivate")?.permissions).toEqual(["core.user.manage"]);
    expect(commandByName.get("core.user.assignRole")?.permissions).toEqual(["core.role.assign"]);
    expect(commandByName.get("core.user.removeRole")?.permissions).toEqual(["core.role.assign"]);

    // API keys — org-scoped machine credentials.
    expect(commandByName.get("core.apikey.create")?.permissions).toEqual(["core.apikey.manage"]);
    expect(commandByName.get("core.apikey.revoke")?.permissions).toEqual(["core.apikey.manage"]);
    expect(commandByName.get("core.apikey.rotate")?.permissions).toEqual(["core.apikey.manage"]);
    expect(queryByName.get("core.apikey.list")?.permissions).toEqual(["core.apikey.read"]);

    expect(modules.list().map((m) => m.id)).toContain("identity");
  });
});
