import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryAuditWriter } from "./audit.js";
import {
  createCommandRegistry,
  defineCommand,
  executeCommand,
} from "./command.js";
import { createRequestContext } from "./context.js";
import { PermissionError, ValidationError } from "./errors.js";
import { InMemoryOutboxWriter } from "./events.js";

describe("executeCommand", () => {
  const input = z.object({ name: z.string().min(1) });
  const output = z.object({ id: z.string(), name: z.string() });

  const cmd = defineCommand({
    name: "demo.ping",
    permissions: ["demo.ping"],
    tags: ["demo"],
    input,
    output,
    handler: async (data) => ({ id: "1", name: data.name }),
  });

  function setup(permissions: string[]) {
    const registry = createCommandRegistry();
    registry.register(cmd);
    const audit = new InMemoryAuditWriter();
    const outbox = new InMemoryOutboxWriter();
    const ctx = createRequestContext({
      actor: {
        kind: "user",
        userId: "u1",
        organizationId: "o1",
        permissions: new Set(permissions),
      },
    });
    return { registry, audit, outbox, ctx };
  }

  it("executes when permitted and valid", async () => {
    const { registry, audit, outbox, ctx } = setup(["demo.ping"]);
    const result = await executeCommand(registry, "demo.ping", { name: "Acme" }, ctx, {
      audit,
      outbox,
    });
    expect(result.data).toEqual({ id: "1", name: "Acme" });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.success).toBe(true);
  });

  it("denies without permission", async () => {
    const { registry, audit, outbox, ctx } = setup([]);
    await expect(
      executeCommand(registry, "demo.ping", { name: "Acme" }, ctx, { audit, outbox }),
    ).rejects.toBeInstanceOf(PermissionError);
    expect(audit.entries[0]?.success).toBe(false);
  });

  it("validates input with zod", async () => {
    const { registry, audit, outbox, ctx } = setup(["demo.ping"]);
    await expect(
      executeCommand(registry, "demo.ping", { name: "" }, ctx, { audit, outbox }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
