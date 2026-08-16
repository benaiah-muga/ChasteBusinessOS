import { describe, expect, it } from "vitest";
import { z } from "zod";
import { InMemoryAuditWriter } from "./audit.js";
import { createCommandRegistry, defineCommand, type CommandHelpers } from "./command.js";
import { InMemoryOutboxWriter } from "./events.js";
import { createCommandEnvelope, dispatchCommand } from "./envelope.js";

const actor = {
  kind: "user" as const,
  userId: "u1",
  organizationId: "o1",
  permissions: new Set(["demo.ping"]),
};

const cmd = defineCommand({
  name: "demo.ping",
  permissions: ["demo.ping"],
  tags: ["demo"],
  input: z.object({ name: z.string().min(1) }),
  output: z.object({ id: z.string(), name: z.string() }),
  handler: async (data) => ({ id: "1", name: data.name }),
});

function helpers() {
  return {
    audit: new InMemoryAuditWriter(),
    outbox: new InMemoryOutboxWriter(),
  } satisfies CommandHelpers;
}

describe("createCommandEnvelope", () => {
  it("fills stable defaults (commandId, idempotencyKey, correlationId, origin)", () => {
    const env = createCommandEnvelope({
      commandType: "demo.ping",
      actor,
      tenantId: "o1",
      payload: { name: "A" },
    });
    expect(env.commandId).toBeTruthy();
    expect(env.idempotencyKey).toBeTruthy();
    expect(env.correlationId).toBeTruthy();
    expect(env.requestedAt).toBeTruthy();
    expect(env.origin).toBe("human");
    expect(env.policyContext).toEqual({});
  });

  it("honors explicit provenance fields", () => {
    const env = createCommandEnvelope({
      commandType: "demo.ping",
      actor,
      tenantId: "o1",
      payload: { name: "A" },
      origin: "agent",
      reason: "user asked to ping",
      evidenceRefs: [{ id: "e1", type: "document", ref: "d1" }],
      approvalGrantId: "ag-1",
      policyContext: { branchId: "b1", amount: 100 },
      idempotencyKey: "retry-1",
    });
    expect(env.origin).toBe("agent");
    expect(env.reason).toBe("user asked to ping");
    expect(env.evidenceRefs).toHaveLength(1);
    expect(env.approvalGrantId).toBe("ag-1");
    expect(env.policyContext.branchId).toBe("b1");
    expect(env.idempotencyKey).toBe("retry-1");
  });
});

describe("dispatchCommand", () => {
  it("executes through the same command bus and records envelope provenance in audit", async () => {
    const registry = createCommandRegistry();
    registry.register(cmd);
    const { audit, outbox } = helpers();

    const env = createCommandEnvelope({
      commandType: "demo.ping",
      actor,
      tenantId: "o1",
      payload: { name: "Acme" },
      origin: "agent",
      reason: "user asked",
      evidenceRefs: [{ id: "e1", type: "query_result", ref: "q1" }],
      approvalGrantId: "ag-1",
      policyContext: { branchId: "b1" },
      idempotencyKey: "k-1",
    });

    const result = await dispatchCommand(registry, env, { audit, outbox });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ id: "1", name: "Acme" });
    expect(result.envelope).toBe(env);
    expect(result.requestId).toBe(env.commandId);

    const entry = audit.entries[0];
    expect(entry).toMatchObject({
      action: "demo.ping",
      success: true,
      origin: "agent",
      reason: "user asked",
      approvalGrantId: "ag-1",
      idempotencyKey: "k-1",
    });
    expect(entry?.evidenceRefs).toEqual([{ id: "e1", type: "query_result", ref: "q1" }]);
    expect(entry?.policyContext).toEqual({ branchId: "b1" });
  });

  it("does not elevate an agent origin: a missing permission still denies", async () => {
    const registry = createCommandRegistry();
    const restricted = defineCommand({
      name: "demo.admin",
      permissions: ["demo.admin"],
      input: z.object({}),
      output: z.object({}),
      handler: async () => ({}),
    });
    registry.register(restricted);
    const { audit, outbox } = helpers();

    const env = createCommandEnvelope({
      commandType: "demo.admin",
      actor: { ...actor, permissions: new Set<string>() },
      tenantId: "o1",
      payload: {},
      origin: "agent",
    });

    await expect(dispatchCommand(registry, env, { audit, outbox })).rejects.toThrow(/demo\.admin/);
    const entry = audit.entries[0];
    expect(entry?.success).toBe(false);
    expect(entry?.errorCode).toBe("PERMISSION_DENIED");
    expect(entry?.origin).toBe("agent");
  });
});
