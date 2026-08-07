import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryAuditWriter } from "./audit.js";
import {
  createCommandRegistry,
  defineCommand,
  executeCommand,
  type CommandHelpers,
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

  it("runs the handler inside the provided transaction (ARCH-2)", async () => {
    const { registry, ctx } = setup(["demo.ping"]);
    const outerAudit = new InMemoryAuditWriter();
    const txAudit = new InMemoryAuditWriter();

    const helpers: CommandHelpers = {
      audit: outerAudit,
      outbox: new InMemoryOutboxWriter(),
      db: {},
      async transaction<T>(fn: (tx: CommandHelpers) => Promise<T>): Promise<T> {
        // Simulate a DB transaction: tx-scoped writers are distinct from outer.
        return fn({ audit: txAudit, outbox: new InMemoryOutboxWriter(), db: {} });
      },
    };

    const result = await executeCommand(registry, "demo.ping", { name: "Acme" }, ctx, helpers);
    expect(result.data).toEqual({ id: "1", name: "Acme" });

    // Success audit must be written through the tx-scoped writer (inside the tx).
    expect(txAudit.entries).toHaveLength(1);
    expect(txAudit.entries[0]?.success).toBe(true);
    // Nothing written to the outer audit on the success path.
    expect(outerAudit.entries).toHaveLength(0);
  });

  it("writes the failure audit OUTSIDE the transaction when the handler throws", async () => {
    const registry = createCommandRegistry();
    const failing = defineCommand({
      name: "demo.boom",
      permissions: ["demo.boom"],
      input: z.object({}),
      output: z.object({}),
      handler: async () => {
        throw new Error("kernel-level failure");
      },
    });
    registry.register(failing);
    const ctx = createRequestContext({
      actor: {
        kind: "user",
        userId: "u1",
        organizationId: "o1",
        permissions: new Set(["demo.boom"]),
      },
    });

    const outerAudit = new InMemoryAuditWriter();
    const txAudit = new InMemoryAuditWriter();

    const helpers: CommandHelpers = {
      audit: outerAudit,
      outbox: new InMemoryOutboxWriter(),
      async transaction<T>(fn: (tx: CommandHelpers) => Promise<T>): Promise<T> {
        // A real DB would roll back partial writes here; the handler already threw.
        return fn({ audit: txAudit, outbox: new InMemoryOutboxWriter() });
      },
    };

    await expect(executeCommand(registry, "demo.boom", {}, ctx, helpers)).rejects.toThrow(
      "kernel-level failure",
    );

    // No success audit written inside the (rolled-back) tx.
    expect(txAudit.entries).toHaveLength(0);
    // The failure audit is recorded via the OUTER writer (survives the rollback).
    expect(outerAudit.entries).toHaveLength(1);
    expect(outerAudit.entries[0]?.success).toBe(false);
    expect(outerAudit.entries[0]?.action).toBe("demo.boom");
  });
});
