import { describe, expect, it } from "vitest";
import {
  OrgPolicyEngine,
  type OrgPolicyRule,
  type PolicyEngine,
} from "./policy";
import { defineCapability, type ActionContext } from "./capability";
import { z } from "zod";

function writeCapability() {
  return defineCapability({
    id: "purchasing.createPurchaseOrder",
    title: "Create purchase order",
    intent: "Order goods from a vendor with lines and prices, matched later by receipts and bills",
    module: "purchasing",
    risk: "write",
    permission: "purchasing.write",
    input: z.object({}),
    output: z.object({}),
    execute: async () => ({}),
  });
}

const ctx: ActionContext = {
  actor: { type: "agent", id: null, orgId: "o1", permissions: new Set(["*"]) },
  now: new Date(),
  services: {},
};

function engineWith(rules: OrgPolicyRule[]): PolicyEngine {
  return new OrgPolicyEngine(async () => rules);
}

describe("OrgPolicyEngine specificity (ADR 0035)", () => {
  it("a specific rule overrides the onboarding blanket", async () => {
    const engine = engineWith([
      { capabilityPattern: "*", maxRiskAutonomous: "write" },
      { capabilityPattern: "purchasing.*", maxRiskAutonomous: "read" },
    ]);
    const decision = await engine.evaluate(ctx, writeCapability(), {});
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reason).toContain('caps autonomy at "read"');
  });

  it("the blanket alone keeps write-class autonomous", async () => {
    const engine = engineWith([{ capabilityPattern: "*", maxRiskAutonomous: "write" }]);
    const decision = await engine.evaluate(ctx, writeCapability(), {});
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("ambiguity resolves to the stricter cap, never the looser one", async () => {
    const engine = engineWith([
      { capabilityPattern: "purchasing.*", maxRiskAutonomous: "write" },
      { capabilityPattern: "purchasing.*", maxRiskAutonomous: "read" },
    ]);
    const decision = await engine.evaluate(ctx, writeCapability(), {});
    expect(decision.requiresApproval).toBe(true);
  });
});
