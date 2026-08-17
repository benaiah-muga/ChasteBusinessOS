import type { AgentPlan } from "../../planning/index.js";
import type { Scenario, ScenarioContext } from "../scenario.js";
import { createHarnessFixture } from "./fixtures.js";

/**
 * Golden regression scenario: an agent without the permission to send email is
 * refused the email tool — the tool is hidden from the surface it sees and a
 * direct call fails closed with a `policy/decision` deny and nothing
 * dispatched. The runner additionally replays the session (reconstruction
 * invariant) and forks it (first-class replay/fork).
 */
export const unauthorizedToolRefusal: Scenario = {
  id: "harness/unauthorized-tool-refusal",
  name: "Policy refusal — unauthorized external tool",
  description:
    "An actor lacking messaging.email.send never sees the email tool, and a direct call is denied without dispatching anything.",
  async run(ctx: ScenarioContext): Promise<void> {
    await ctx.record("session/start", { channel: "api", source: "scenario" });
    await ctx.record("context/assembled", {
      bundleId: `bundle-${ctx.sessionId}`,
      turn: 1,
      sections: [
        { key: "policy", tier: 0, purpose: "authority", source: "policy", tokenEstimate: 120, visibility: "model" },
      ],
    });
    await ctx.record("model/request", {
      modelRoute: "planning",
      provider: "eval",
      model: "eval-harness",
      systemPromptSections: ["You act through the tool registry within your granted permissions."],
      messages: [{ role: "user", content: "Email the supplier to confirm the order." }],
      toolSchemas: [{ name: "messaging_send_email", command: "messaging.email.send" }],
      evidenceRefs: [],
      memoryReads: [],
      contextBundleId: `bundle-${ctx.sessionId}`,
    });

    const fx = createHarnessFixture({ log: ctx.log, organizationId: ctx.organizationId, now: ctx.now });
    const limited = fx.actor(["procurement.purchase_order.create"]);

    const surface = fx.harness.toolSurface(limited);
    ctx.check(
      "email tool is not exposed to an actor without messaging.email.send",
      !surface.names.includes("messaging_send_email"),
      surface.names.join(", "),
    );

    const outcome = await fx.harness.call({
      actor: limited,
      sessionId: ctx.sessionId,
      organizationId: ctx.organizationId,
      tool: "messaging_send_email",
      args: { to: "s@supplier.com", subject: "Order confirmation" },
      correlationId: `corr-${ctx.sessionId}`,
    });
    ctx.check("direct call to the unauthorized tool fails closed", !outcome.ok);
    if (!outcome.ok) {
      ctx.check("failure is a policy denial, not a generic error", outcome.kind === "denied");
      ctx.check(
        "denial cites a named policy basis",
        outcome.policyDecisions.some((d) => d.policy === "tool-exposeWhen"),
      );
    }
    ctx.check("nothing was dispatched for the refused call", fx.emailLogs.length === 0);

    const events = await ctx.log.list(ctx.sessionId);
    ctx.check(
      "trajectory records a policy/decision deny",
      events.some((e) => e.type === "policy/decision"),
    );
  },
};

/** A minimal realistic plan for the harness eval scenarios. */
export function evalPlan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "eval-plan-1",
    objective: "Notify the supplier outside the platform",
    assumptions: [],
    steps: [
      {
        id: "e1",
        title: "Notify supplier",
        command: "messaging.email.send",
        args: { to: "s@supplier.com", subject: "PO shipped" },
        riskClass: "external",
      },
    ],
    requiredApprovals: [
      { commandType: "messaging.email.send", riskClass: "external", reason: "notify supplier outside the platform" },
    ],
    risks: [],
    evidenceNeeded: [],
    stopConditions: [],
    ...overrides,
  };
}

/**
 * Golden regression scenario: an external side effect runs only under a
 * durable grant minted from a plan approval — the plan is surfaced
 * (`approval/requested`), the human approves, grants are minted
 * (`approval/granted`), and the step dispatches under the covering grant.
 */
export const externalStepApproval: Scenario = {
  id: "harness/external-step-approval",
  name: "Approval gate — external step executes under a minted grant",
  description:
    "An external email step in a medium-risk plan is surfaced for approval and executes only under the durable grant minted from that approval.",
  async run(ctx: ScenarioContext): Promise<void> {
    await ctx.record("session/start", { channel: "api", source: "scenario" });
    await ctx.record("context/assembled", {
      bundleId: `bundle-${ctx.sessionId}`,
      turn: 1,
      sections: [
        { key: "policy", tier: 0, purpose: "authority", source: "policy", tokenEstimate: 120, visibility: "model" },
      ],
    });
    await ctx.record("model/request", {
      modelRoute: "planning",
      provider: "eval",
      model: "eval-harness",
      systemPromptSections: ["You act through the tool registry within your granted permissions."],
      messages: [{ role: "user", content: "Email the supplier to confirm the shipment." }],
      toolSchemas: [{ name: "messaging_send_email", command: "messaging.email.send" }],
      evidenceRefs: [],
      memoryReads: [],
      contextBundleId: `bundle-${ctx.sessionId}`,
    });

    const fx = createHarnessFixture({ log: ctx.log, organizationId: ctx.organizationId, now: ctx.now });
    const agent = fx.actor(["messaging.email.send"]);

    const result = await fx.harness.runPlan({
      actor: agent,
      sessionId: ctx.sessionId,
      organizationId: ctx.organizationId,
      plan: evalPlan(),
      correlationId: `corr-${ctx.sessionId}`,
    });

    ctx.check("plan run succeeded", result.ok);
    if (result.ok) {
      ctx.check("a durable grant was minted from the approval", result.grantIds.length === 1);
      ctx.check("the external step executed", result.steps[0]?.outcome?.ok === true);
      ctx.check("the command dispatched exactly once", fx.emailLogs.length === 1);
      if (fx.emailLogs.length === 1) {
        const dispatched = JSON.parse(fx.emailLogs[0]!) as { approvalGrantId: string | null };
        ctx.check(
          "the dispatch ran under the minted grant",
          result.ok && dispatched.approvalGrantId === result.grantIds[0],
        );
      }
    }

    const events = await ctx.log.list(ctx.sessionId);
    ctx.check(
      "trajectory records approval/requested then approval/granted then command/dispatched",
      ["approval/requested", "approval/granted", "command/dispatched"].every((t) =>
        events.some((e) => e.type === t),
      ),
    );
  },
};

/** The golden regression suite for build item 14. */
export const GOLDEN_SCENARIOS: Scenario[] = [unauthorizedToolRefusal, externalStepApproval];