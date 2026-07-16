import {
  createCommandRegistry,
  createQueryRegistry,
  createRequestContext,
  executeCommand,
  executeQuery,
  InMemoryAuditWriter,
  InMemoryOutboxWriter,
} from "@chaste/kernel";
import { describe, expect, it } from "vitest";
import { createDemoCrmModule } from "./index.js";

describe("demo-crm", () => {
  it("creates and lists customers via command/query bus", async () => {
    const commands = createCommandRegistry();
    const queries = createQueryRegistry();
    const mod = createDemoCrmModule();
    await mod.register({ commands, queries });

    const audit = new InMemoryAuditWriter();
    const outbox = new InMemoryOutboxWriter();
    const ctx = createRequestContext({
      actor: {
        kind: "user",
        userId: "u1",
        organizationId: "o1",
        permissions: new Set(["crm.customer.create", "crm.customer.read"]),
      },
    });

    const created = await executeCommand(
      commands,
      "crm.customer.create",
      { name: "Acme", city: "Nairobi" },
      ctx,
      { audit, outbox },
    );
    expect(created.data).toMatchObject({ name: "Acme", city: "Nairobi" });
    expect(outbox.events[0]?.type).toBe("crm.customer.created");

    const listed = await executeQuery(queries, "crm.customer.list", {}, ctx);
    expect(listed.data.items).toHaveLength(1);
  });
});
