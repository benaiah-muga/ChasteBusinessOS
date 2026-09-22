import { describe, expect, it } from "vitest";
import {
  DefaultPolicyEngine,
  OrgPolicyEngine,
  approvalRequestFor,
  RISK_RANK,
  type OrgPolicyRule,
  type PolicyEngine,
} from "./policy";
import { defineCapability, type ActionContext, type Capability } from "./capability";
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

function identityCapability(id: string, risk: "identity" | "destructive" | "secret") {
  return defineCapability({
    id,
    title: "Authority-gated action",
    intent: "Reshape who holds authority or permanently close something off",
    module: "iam",
    risk,
    permission: "iam.admin",
    input: z.object({}),
    output: z.object({}),
    execute: async () => ({}),
  });
}

function moneyCapability(thresholdMinor?: number) {
  return defineCapability({
    id: "accounting.recordPayment",
    title: "Record payment",
    intent: "Settle an outstanding receivable with a posted payment",
    module: "accounting",
    risk: "money",
    permission: "accounting.post",
    moneyThresholdMinor: thresholdMinor,
    moneyAmount: (input: { amountMinor: number }) => input.amountMinor,
    input: z.object({ amountMinor: z.number() }),
    output: z.object({}),
    execute: async () => ({}),
  }) satisfies Capability<{ amountMinor: number }, unknown>;
}

function ctxWith(type: "human" | "agent" | "system", orgId = "o1"): ActionContext {
  return {
    actor: { type, id: "u1", orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
}

const ctx: ActionContext = ctxWith("agent");

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

describe("actor-aware authority (ADR 0055)", () => {
  it("agents stay gated through the full org engine; the rule walk never loosens a gate", async () => {
    const engine = engineWith([{ capabilityPattern: "*", maxRiskAutonomous: "write" }]);
    for (const risk of ["identity", "destructive"] as const) {
      const decision = await engine.evaluate(ctxWith("agent"), identityCapability("iam.setModules", risk), {});
      expect(decision.requiresApproval).toBe(true);
    }
  });

  it("a permitted human executes identity-class actions directly", async () => {
    const decision = await new DefaultPolicyEngine().evaluate(ctxWith("human"), identityCapability("iam.setModules", "identity"), {});
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("a permitted human executes destructive-class actions directly", async () => {
    const decision = await new DefaultPolicyEngine().evaluate(ctxWith("human"), identityCapability("accounting.closePeriod", "destructive"), {});
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it("agent and system actors are still gated for identity and destructive", async () => {
    for (const type of ["agent", "system"] as const) {
      for (const risk of ["identity", "destructive"] as const) {
        const decision = await new DefaultPolicyEngine().evaluate(ctxWith(type), identityCapability("iam.setModules", risk), {});
        expect(decision.requiresApproval).toBe(true);
        expect(decision.reason).toContain("human authority");
      }
    }
  });

  it("humans are not threshold-gated on money by default", async () => {
    const engine = engineWith([{ capabilityPattern: "*", maxRiskAutonomous: "write", moneyThresholdMinor: 50_000 }]);
    const decision = await engine.evaluate(ctxWith("human"), moneyCapability(), { amountMinor: 10_000_000 });
    expect(decision.requiresApproval).toBe(false);
  });

  it("agents stay threshold-gated on money", async () => {
    const engine = engineWith([{ capabilityPattern: "*", maxRiskAutonomous: "write", moneyThresholdMinor: 50_000 }]);
    const decision = await engine.evaluate(ctxWith("agent"), moneyCapability(), { amountMinor: 10_000_000 });
    expect(decision.requiresApproval).toBe(true);
  });

  it("strict mode (maker-checker) re-imposes identity gates on humans", async () => {
    const engine = engineWith([
      { capabilityPattern: "*", maxRiskAutonomous: "write", requiresApprovalFor: ["identity", "destructive"] },
    ]);
    const decision = await engine.evaluate(ctxWith("human"), identityCapability("iam.setModules", "identity"), {});
    expect(decision.requiresApproval).toBe(true);
  });

  it("strict mode with the wildcard covers every risk class", async () => {
    const engine = engineWith([{ capabilityPattern: "*", maxRiskAutonomous: "write", requiresApprovalFor: ["*"] }]);
    const human = await engine.evaluate(ctxWith("human"), identityCapability("iam.setModules", "destructive"), {});
    expect(human.requiresApproval).toBe(true);
    const money = await engine.evaluate(ctxWith("human"), moneyCapability(), { amountMinor: 100 });
    expect(money.requiresApproval).toBe(true);
  });

  it("strict money gates a human above the threshold but not below it", async () => {
    const engine = engineWith([
      { capabilityPattern: "*", maxRiskAutonomous: "write", moneyThresholdMinor: 50_000, requiresApprovalFor: ["money"] },
    ]);
    const small = await engine.evaluate(ctxWith("human"), moneyCapability(), { amountMinor: 40_000 });
    expect(small.requiresApproval).toBe(false);
    const large = await engine.evaluate(ctxWith("human"), moneyCapability(), { amountMinor: 60_000 });
    expect(large.requiresApproval).toBe(true);
  });

  it("pattern-scoped strict rules only affect their own capabilities", async () => {
    const engine = engineWith([
      { capabilityPattern: "iam.*", maxRiskAutonomous: "write", requiresApprovalFor: ["identity"] },
    ]);
    const iamDecision = await engine.evaluate(ctxWith("human"), identityCapability("iam.setModules", "identity"), {});
    expect(iamDecision.requiresApproval).toBe(true);
    const otherDecision = await engine.evaluate(ctxWith("human"), identityCapability("pos.voidSession", "destructive"), {});
    expect(otherDecision.requiresApproval).toBe(false);
  });
});

describe("risk ranking", () => {
  it("orders risk classes from read to secret", () => {
    expect(RISK_RANK.read).toBeLessThan(RISK_RANK.write);
    expect(RISK_RANK.write).toBeLessThan(RISK_RANK.money);
    expect(RISK_RANK.money).toBeLessThan(RISK_RANK.identity);
    expect(RISK_RANK.identity).toBeLessThan(RISK_RANK.destructive);
    expect(RISK_RANK.destructive).toBeLessThan(RISK_RANK.secret);
  });
});

describe("secret-class handling", () => {
  it("approval requests redact secret-class payloads symmetrically", () => {
    const request = approvalRequestFor(
      identityCapability("iam.rotateApiKey", "secret"),
      { apiKey: "sk-hush-hush" },
      { allowed: true, requiresApproval: true, reason: "test" },
    );
    expect(JSON.stringify(request)).not.toContain("sk-hush-hush");
    expect(request.payload).toBe("[REDACTED: secret-class]");
  });
});
