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
  async evaluate(
    ctx: ActionContext,
    cap: Capability,
    _input: unknown,
    opts: { humanGates?: ReadonlySet<RiskClass> | "*" } = {},
  ): Promise<PolicyDecision> {
    if (!hasPermission(ctx.actor, cap.permission)) {
      return { allowed: false, requiresApproval: false, reason: `missing permission: ${cap.permission}` };
    }

    // A permitted human acting in the product executes under their own
    // authority: the audit trail is the control, and routing every click
    // through the approvals inbox makes the human approve themselves. Gates
    // exist for actors nobody can trust implicitly: the workmate, routines,
    // system jobs. An org can re-impose dual control (maker-checker) for
    // humans per risk class via opts.humanGates; that is a strictness knob,
    // never a default.
    const strict = opts.humanGates === "*" || opts.humanGates?.has(cap.risk);
    if (cap.risk === "identity" || cap.risk === "destructive") {
      if (ctx.actor.type === "human" && !strict) {
        return {
          allowed: true,
          requiresApproval: false,
          reason: `human authority: ${ctx.actor.id ?? "user"} executes directly`,
        };
      }
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
  /**
   * Risk classes that require dual control even for humans (maker-checker
   * strict mode); "*" covers every class. Empty/undefined keeps the default:
   * permitted humans act directly under their own authority (ADR 0055).
   */
  requiresApprovalFor?: string[];
}

function matchesPattern(pattern: string, capabilityId: string): boolean {
  if (pattern === "*" || pattern === "*.*") return true;
  if (pattern.endsWith(".*")) return capabilityId.startsWith(pattern.slice(0, -1));
  return pattern === capabilityId;
}

/** Union of the matching rules' human-gate risk classes; null when none. */
function humanGateSet(
  rules: OrgPolicyRule[],
  capabilityId: string,
): ReadonlySet<RiskClass> | "*" | null {
  let set: Set<RiskClass> | null = null;
  for (const rule of rules) {
    if (!matchesPattern(rule.capabilityPattern, capabilityId)) continue;
    for (const risk of rule.requiresApprovalFor ?? []) {
      if (risk === "*") return "*";
      if (risk in RISK_RANK) (set ??= new Set<RiskClass>()).add(risk as RiskClass);
    }
  }
  return set;
}

/**
 * Policy engine driven by per-org rules (persisted in the policies table).
 * Falls back to safe defaults when no rule matches.
 */
export class OrgPolicyEngine implements PolicyEngine {
  constructor(private readonly loadRules: (orgId: string) => Promise<OrgPolicyRule[]>) {}

  async evaluate(ctx: ActionContext, cap: Capability, input: unknown): Promise<PolicyDecision> {
    const rules = await this.loadRules(ctx.actor.orgId);
    const humanGates = humanGateSet(rules, cap.id);
    const base = await new DefaultPolicyEngine().evaluate(ctx, cap, input, { humanGates: humanGates ?? undefined });
    // A gate here (agent hard gates, or strict-mode human gates) is final:
    // the rule walk below may add gates, never remove one.
    if (!base.allowed || base.requiresApproval) return base;

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
    if (ctx.actor.type !== "human" && rule && cap.risk !== "money" && RISK_RANK[cap.risk] > RISK_RANK[rule.maxRiskAutonomous]) {
      return { allowed: true, requiresApproval: true, reason: `org policy caps autonomy at "${rule.maxRiskAutonomous}"` };
    }

    if (cap.risk === "money") {
      const threshold = rule?.moneyThresholdMinor ?? cap.moneyThresholdMinor ?? 0;
      const amount = cap.moneyAmount ? cap.moneyAmount(input as never) : null;
      const humanStrict = humanGates === "*" || humanGates?.has("money") === true;
      const gated = ctx.actor.type === "agent" || (ctx.actor.type === "human" && humanStrict);
      // Null amount gates when the actor is gated at all: we cannot prove
      // this action is below it, so it waits for approval. Fail closed.
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
    // Secret-class inputs (credentials) are redacted symmetrically: the
    // stored approval payload and the re-execution verification payload
    // both carry the marker, so approval still verifies exactly while no
    // secret ever lands in the approvals table or the inbox UI.
    payload: cap.risk === "secret" ? "[REDACTED: secret-class]" : input,
    rationale: decision.reason,
  };
}
