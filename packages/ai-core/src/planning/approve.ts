import type { ApprovalGrantStore, InboxStore } from "@chaste/kernel";
import type { AgentSessionEventType, SessionLog } from "../trajectory/index.js";
import { sessionEvent } from "../trajectory/index.js";
import { planRequiresApproval, planRisk, renderPlan } from "./plan.js";
import type { AgentPlan } from "./types.js";

/**
 * Plan approval flow (research doc §Planning, §Human Collaboration).
 *
 * A medium/high-risk plan is surfaced to the user or approver before any step
 * dispatches; on approval, each of the plan's `requiredApprovals` becomes a
 * durable grant (ADR 0014 tranche 3) so the tool registry's
 * `grantCoveredToolPolicy` auto-allows the matching command calls without
 * re-asking. Low-risk plans execute internally without surfacing. Everything
 * is recorded on the session trajectory (`plan/proposed`, `approval/requested`,
 * `approval/granted`, `approval/rejected`).
 */

export interface PlanApprovalContext {
  sessionId: string;
  organizationId: string;
  /** The actor whose execution the plan's grants authorize. */
  userId: string;
  /** User id of the approver who may approve the plan; absent → fail closed. */
  approverUserId?: string;
  /** Default grant lifetime in ms when policy implies no explicit expiry. */
  grantTtlMs?: number;
  /** Human-attention queue used to surface medium/high-risk plans. */
  inbox?: InboxStore;
  /** Durable grant store minted from plan approvals. */
  grants?: ApprovalGrantStore;
  trajectory?: SessionLog;
  now?: () => Date;
}

export type PlanApprovalResult =
  | { approved: true; via: "low_risk" | "human"; grantIds: string[] }
  | { approved: false; via: "rejected" | "no_decision_surface"; reason: string };

async function logEvent(
  ctx: PlanApprovalContext,
  type: AgentSessionEventType,
  payload: unknown,
): Promise<void> {
  if (!ctx.trajectory) return;
  await ctx.trajectory.append(
    sessionEvent(ctx.sessionId, ctx.organizationId, type, payload, { now: ctx.now }),
  );
}

export async function requestPlanApproval(
  plan: AgentPlan,
  ctx: PlanApprovalContext,
): Promise<PlanApprovalResult> {
  const risk = planRisk(plan);
  await logEvent(ctx, "plan/proposed", {
    planId: plan.id,
    objective: plan.objective,
    stepCount: plan.steps.length,
    risk: risk.level,
    approvalCount: plan.requiredApprovals.length,
  });

  // Low-risk plans execute internally without surfacing (doc §Planning).
  if (!planRequiresApproval(plan)) {
    return { approved: true, via: "low_risk", grantIds: [] };
  }

  if (!ctx.approverUserId) {
    return {
      approved: false,
      via: "no_decision_surface",
      reason: "No approver configured for plan approval",
    };
  }

  if (!ctx.inbox) {
    return {
      approved: false,
      via: "no_decision_surface",
      reason: "No decision surface wired for plan approval",
    };
  }

  const item = await ctx.inbox.addPlan({
    sessionId: ctx.sessionId,
    organizationId: ctx.organizationId,
    userId: ctx.approverUserId,
    title: `Review plan: ${plan.objective}`,
    body: renderPlan(plan),
    data: { planId: plan.id, stepCount: plan.steps.length },
  });

  const resolution = await ctx.inbox.wait(item.id);
  if (resolution !== "approved") {
    await logEvent(ctx, "approval/rejected", { planId: plan.id, reason: resolution });
    return { approved: false, via: "rejected", reason: resolution };
  }

  const grantIds: string[] = [];
  if (ctx.grants) {
    const now = ctx.now?.() ?? new Date();
    const ttlMs = ctx.grantTtlMs ?? 60 * 60 * 1000;
    for (const need of plan.requiredApprovals) {
      const grant = await ctx.grants.create({
        organizationId: ctx.organizationId,
        grantedBy: ctx.approverUserId,
        grantedToUserId: ctx.userId,
        scope: {
          commandType: need.commandType,
          resourceType: need.resourceType,
          resourceId: need.resourceId,
        },
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        conditions: [need.reason, `plan:${plan.id}`],
        policyBasis: "plan-approval",
      });
      grantIds.push(grant.id);
      await logEvent(ctx, "approval/granted", {
        approvalGrantId: grant.id,
        planId: plan.id,
        commandType: need.commandType,
        resourceType: need.resourceType,
        resourceId: need.resourceId,
      });
    }
  }

  return { approved: true, via: "human", grantIds };
}