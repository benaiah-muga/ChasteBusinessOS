import { describe, expect, it } from "vitest";
import { CapabilityRegistry, defineCapability, type ActionContext, type CapabilityResult, type KernelExecutor } from "@chaste/kernel";
import { z } from "zod";
import { createCapabilityBridge } from "./capability-bridge";

describe("harness capability bridge", () => {
  it("discovers scoped capabilities and delegates execution to the kernel", async () => {
    const registry = new CapabilityRegistry();
    registry.register(
      defineCapability({
        id: "inventory.readStock",
        title: "Read stock",
        intent: "Read the current stock balance for one item in the organization",
        module: "inventory",
        risk: "read",
        permission: "inventory.read",
        input: z.object({ itemId: z.string() }),
        output: z.object({ quantity: z.number() }),
        execute: async () => ({ quantity: 3 }),
      }),
    );
    let calls = 0;
    const executor: Pick<KernelExecutor, "execute"> = {
      async execute<I, O>(
        _capabilityId: string,
        _context: ActionContext,
        _input: I,
        _options?: { approvedApprovalId?: string },
      ): Promise<CapabilityResult<O>> {
        calls += 1;
        return { ok: true, data: { quantity: 7 } as O, outcome: "known" };
      },
    };
    const bridge = createCapabilityBridge({ registry, executor, enabledModules: new Set(["inventory"]) });
    const actor = { type: "agent" as const, id: "agent-1", orgId: "org-1", permissions: new Set(["inventory.read"]) };
    const context: ActionContext = { actor, now: new Date("2026-01-01T00:00:00.000Z"), services: {} };

    expect(bridge.list(actor).map((capability) => capability.id)).toEqual(["inventory.readStock"]);
    expect(await bridge.execute("inventory.readStock", context, { itemId: "item-1" })).toEqual({
      ok: true,
      data: { quantity: 7 },
      outcome: "known",
    });
    expect(calls).toBe(1);
    console.log("HARNESS-BRIDGE-OK");
  });
});
