import type { ActionContext, ApprovalRequest, Capability, RiskClass } from "./capability";

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

export interface PolicyEngine {
  evaluate(ctx: ActionContext, cap: Capability, input: unknown): Promise<PolicyDecision>;
}

export const RISK_RANK: Record<RiskClass, number> = {
  read: 0,
  write: 1,
  money: 2,
  identity: 3,
  destructive: 4,
  secret: 5,
};

export function hasPermission(actor: { permissions: ReadonlySet<string> }, permission: string): boolean {
  return actor.permissions.has("*") || actor.permissions.has(permission);
}

export class DefaultPolicyEngine implements PolicyEngine {
  async evaluate(ctx: ActionContext, cap: Capability, _input: unknown): Promise<PolicyDecision> {
    if (!hasPermission(ctx.actor, cap.permission)) {
      return { allowed: false, requiresApproval: false, reason: `missing permission: ${cap.permission}` };
    }

    // Hard gates that no policy can relax.
    if (cap.risk === "identity" || cap.risk === "destructive") {
      return {
        allowed: true,
        requiresApproval: true,
        reason: `risk class "${cap.risk}" always requires human authority`,
      };
    }

    // Agents cannot self-approve money above the capability's threshold.
    // A null amount (unknowable up front) gates unconditionally: fail closed.
    if (cap.risk === "money" && ctx.actor.type === "agent") {
      const amount = cap.moneyAmount ? cap.moneyAmount(_input as never) : null;
      const threshold = cap.moneyThresholdMinor ?? 0;
      if (amount === null || amount > threshold) {
        return {
          allowed: true,
          requiresApproval: true,
          reason:
            amount === null
              ? "amount is not knowable before execution; human approval required"
              : `amount ${amount} exceeds autonomous threshold ${threshold}`,
        };
      }
    }

    return { allowed: true, requiresApproval: false, reason: "within policy" };
  }
}

export interface OrgPolicyRule {
  /** Glob-ish pattern: "accounting.*" matches "accounting.postJournalEntry". */
  capabilityPattern: string;
  maxRiskAutonomous: RiskClass;
  moneyThresholdMinor?: number;
}

function matchesPattern(pattern: string, capabilityId: string): boolean {
  if (pattern === "*" || pattern === "*.*") return true;
  if (pattern.endsWith(".*")) return capabilityId.startsWith(pattern.slice(0, -1));
  return pattern === capabilityId;
}

/**
 * Policy engine driven by per-org rules (persisted in the policies table).
 * Falls back to safe defaults when no rule matches.
 */
export class OrgPolicyEngine implements PolicyEngine {
  constructor(private readonly loadRules: (orgId: string) => Promise<OrgPolicyRule[]>) {}

  async evaluate(ctx: ActionContext, cap: Capability, input: unknown): Promise<PolicyDecision> {
    const base = await new DefaultPolicyEngine().evaluate(ctx, cap, input);
    if (!base.allowed || cap.risk === "identity" || cap.risk === "destructive") return base;

    const rules = await this.loadRules(ctx.actor.orgId);
    const matching = rules.filter((r) => matchesPattern(r.capabilityPattern, cap.id));
    // Most specific pattern wins: "purchasing.createPurchaseOrder" beats
    // "purchasing.*" beats the onboarding blanket "*". Ties resolve to the
    // stricter autonomy cap, because ambiguity must never loosen a gate.
    const rule = matching
      .slice()
      .sort((a, b) => {
        const bySpecificity = b.capabilityPattern.length - a.capabilityPattern.length;
        if (bySpecificity !== 0) return bySpecificity;
        return RISK_RANK[a.maxRiskAutonomous] - RISK_RANK[b.maxRiskAutonomous];
      })[0];

    // Money actions are governed by amount thresholds below, not by the
    // blanket risk cap, otherwise every retail sale needs sign-off.
    if (rule && cap.risk !== "money" && RISK_RANK[cap.risk] > RISK_RANK[rule.maxRiskAutonomous]) {
      return { allowed: true, requiresApproval: true, reason: `org policy caps autonomy at "${rule.maxRiskAutonomous}"` };
    }

    if (cap.risk === "money") {
      const threshold = rule?.moneyThresholdMinor ?? cap.moneyThresholdMinor ?? 0;
      const amount = cap.moneyAmount ? cap.moneyAmount(input as never) : null;
      const gated = ctx.actor.type === "agent" || threshold > 0;
      // Null amount gates even humans when a threshold is configured: the
      // org asked for sign-off on money, we cannot prove this action is
      // below it, so it waits for approval. Fail closed, never open.
      if (gated && (amount === null || amount > threshold)) {
        return {
          allowed: true,
          requiresApproval: true,
          reason:
            amount === null
              ? "amount is not knowable before execution; human approval required"
              : `amount ${amount} exceeds autonomous threshold ${threshold}`,
        };
      }
    }

    return { allowed: true, requiresApproval: false, reason: "within policy" };
  }
}

export function approvalRequestFor(
  cap: Capability,
  input: unknown,
  decision: PolicyDecision,
): ApprovalRequest {
  return {
    capabilityId: cap.id,
    riskClass: cap.risk,
    payload: input,
    rationale: decision.reason,
  };
}
