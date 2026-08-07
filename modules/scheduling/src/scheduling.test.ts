/**
 * ARCH-3 — contract test for the extracted scheduling module.
 *
 * Verifies the `core.reminder.*`, `core.followup.*`, and `core.calendar.*`
 * surface the API/web depend on is registered with the right names and
 * permissions, so the extraction from the platform module can never silently
 * drop a command/query.
 */
import { describe, expect, it } from "vitest";
import { createCommandRegistry, createQueryRegistry, createModuleRegistry } from "@chaste/kernel";
import { createDb, type Db } from "@chaste/db";
import { createSchedulingModule } from "./index.js";

describe("scheduling module contract", () => {
  it("registers the reminder/followup/calendar surface with expected permissions", async () => {
    const commands = createCommandRegistry();
    const queries = createQueryRegistry();
    const modules = createModuleRegistry(commands, queries);
    const db = createDb(
      process.env.DATABASE_URL ?? "postgresql://user:pass@localhost:5432/db",
    ) as Db;

    await modules.register(createSchedulingModule(db));

    const commandByName = new Map(commands.list().map((c) => [c.name, c]));
    const queryByName = new Map(queries.list().map((q) => [q.name, q]));

    expect(commandByName.get("core.reminder.set")?.permissions).toEqual(["core.reminder.write"]);
    expect(commandByName.get("core.reminder.cancel")?.permissions).toEqual(["core.reminder.write"]);
    expect(commandByName.get("core.followup.create")?.permissions).toEqual(["core.followup.write"]);
    expect(commandByName.get("core.followup.cancel")?.permissions).toEqual(["core.followup.write"]);
    expect(commandByName.get("core.calendar.event.create")?.permissions).toEqual(["core.calendar.write"]);
    expect(commandByName.get("core.calendar.event.update")?.permissions).toEqual(["core.calendar.write"]);
    expect(commandByName.get("core.calendar.event.cancel")?.permissions).toEqual(["core.calendar.write"]);
    expect(queryByName.get("core.reminder.list")?.permissions).toEqual(["core.reminder.write"]);
    expect(queryByName.get("core.followup.list")?.permissions).toEqual(["core.followup.write"]);
    expect(queryByName.get("core.calendar.list")?.permissions).toEqual(["core.calendar.read"]);

    expect(modules.list().map((m) => m.id)).toContain("scheduling");
  });
});