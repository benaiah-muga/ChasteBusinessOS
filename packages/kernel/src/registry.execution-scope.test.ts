import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "./capability";
import { KernelExecutor } from "./executor";
import { computeEntryHash, InMemoryLedger } from "./ledger";
import { CapabilityRegistry } from "./registry";

const bootstrapCapability = defineCapability({
  id: "iam.bootstrapOrganization",
  title: "Open the first workspace",
  intent: "Create an organization before a verified human has any organization membership",
  module: "iam",
  risk: "write",
  permission: "iam.bootstrapOrganization",
  executionScope: "pre-organization",
  input: z.object({ intentId: z.string().min(8) }),
  output: z.object({ orgId: z.string() }),
  execute: async () => ({ orgId: "org" }),
});

describe("capability execution scopes", () => {
  it("keeps pre-organization capabilities out of organization actor tool lists", () => {
    const registry = new CapabilityRegistry();
    registry.register(bootstrapCapability);

    expect(registry.all().map((capability) => capability.id)).toContain("iam.bootstrapOrganization");
    expect(registry.forActor({ type: "human", id: "user", orgId: "org", permissions: new Set(["*"]) })).toEqual([]);
  });

  it("refuses ordinary execution even when a caller supplies the capability id directly", async () => {
    const registry = new CapabilityRegistry();
    registry.register(bootstrapCapability);
    const executor = new KernelExecutor({ registry, ledger: new InMemoryLedger() });

    const result = await executor.execute(
      "iam.bootstrapOrganization",
      { actor: { type: "human", id: "user", orgId: "org", permissions: new Set(["*"]) }, now: new Date(), services: {} },
      { intentId: "stable-intent" },
    );

    expect(result).toEqual({
      ok: false,
      error: 'capability "iam.bootstrapOrganization" requires its dedicated pre-organization executor',
    });
  });

  it("covers verified auth session attribution in ledger hashes", () => {
    const entry = {
      orgId: "11111111-1111-4111-8111-111111111111",
      actorType: "human",
      actorId: "22222222-2222-4222-8222-222222222222",
      kind: "organization.created",
      capabilityId: "iam.bootstrapOrganization",
      payload: { orgId: "44444444-4444-4444-8444-444444444444", name: "Parity Org" },
      occurredAt: new Date("2024-01-02T03:04:05.123Z"),
    };
    const prior = computeEntryHash(entry, "0".repeat(64));
    const attributed = computeEntryHash(
      { ...entry, authSessionId: "33333333-3333-4333-8333-333333333333" },
      "0".repeat(64),
    );

    expect(attributed).not.toBe(prior);
    expect(attributed).toBe("3ed97e2eb4f49c069e33161b3f6d8b7e70e6c1a5e388e3091b3226b585439fc6");
  });
});
