import type { EvidenceRef, RiskClass } from "@chaste/kernel";

/**
 * Typed agent plans (research doc §Planning).
 *
 * Plans are useful but not authoritative: typed, inspectable, and revisable.
 * They are the harness's layer-3 artifact that connects intent → approval →
 * execution. For low-risk tasks the agent plans internally and executes; for
 * medium/high-risk tasks the plan is shown to the user or approver before
 * execution; approval becomes a durable grant so later tool calls can cite it.
 */

export type PlanRiskLevel = "low" | "medium" | "high";

/** An approval the plan needs before its steps may run (doc §Planning). */
export interface ApprovalNeed {
  commandType?: string;
  resourceType?: string;
  resourceId?: string;
  riskClass: RiskClass;
  /** Why this approval is needed (recorded as the grant's condition). */
  reason: string;
}

export interface PlanRisk {
  level: PlanRiskLevel;
  description: string;
  mitigation?: string;
}

export interface EvidenceNeed {
  /** Evidence class, e.g. "query_result" | "document" | "approval". */
  type: string;
  /** Stable locator when already known. */
  ref?: string;
  note?: string;
}

export interface PlanStep {
  id: string;
  title: string;
  /** Name of the command/query on the bus this step dispatches. */
  command?: string;
  /** Payload for the command/query (validated against the bus at execution). */
  args?: unknown;
  /** Declared step risk; drives plan risk when set. */
  riskClass?: RiskClass;
  /** Approval this specific step needs before dispatch. */
  requiredApproval?: ApprovalNeed;
  /** Other step ids that must complete first. */
  dependsOn?: string[];
  /** Evidence ref ids this step is expected to produce. */
  expectedEvidence?: string[];
}

export interface AgentPlan {
  id: string;
  objective: string;
  assumptions: string[];
  steps: PlanStep[];
  requiredApprovals: ApprovalNeed[];
  risks: PlanRisk[];
  evidenceNeeded: EvidenceNeed[];
  stopConditions: string[];
}

/** Evidence the plan expects to gather, ready to attach once produced. */
export interface PlanEvidenceExpectation {
  need: EvidenceNeed;
  refs: EvidenceRef[];
}