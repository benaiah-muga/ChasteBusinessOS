import type { RiskClass } from "@chaste/kernel";
import type { AgentPlan, PlanRiskLevel } from "./types.js";

/**
 * Pure plan analysis (research doc §Planning). Risk drives whether a plan may
 * execute internally (low) or must be shown to the user or approver first
 * (medium/high). Everything here is deterministic and inspectable.
 */

/**
 * Plan risk maps the tool registry's risk tiers onto plan risk levels and
 * matches `defaultToolPolicy` (tools/execute.ts): `exec` and `external` calls
 * require a durable human approval, so a plan touching them is at least high;
 * `write_local` needs no per-call approval but is not read-only, so a plan
 * touching it is medium; `read` is low. A plan whose risk is not low must be
 * shown to the user or approver before execution.
 */
const RISK_CLASS_LEVEL: Record<RiskClass, PlanRiskLevel> = {
  read: "low",
  write_local: "medium",
  exec: "high",
  external: "high",
};

const LEVEL_ORDER: Record<PlanRiskLevel, number> = { low: 0, medium: 1, high: 2 };

function maxLevel(a: PlanRiskLevel, b: PlanRiskLevel): PlanRiskLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

/**
 * Overall plan risk = the strictest of: each step's effective risk class
 * (step risk, else its required approval's risk, else `read`), each declared
 * plan risk, and each required approval's risk class. A plan that needs any
 * approval is at least medium by definition.
 */
export function planRisk(plan: AgentPlan): { level: PlanRiskLevel; reasons: string[] } {
  let level: PlanRiskLevel = "low";
  const reasons: string[] = [];

  for (const step of plan.steps) {
    const effective: RiskClass =
      step.riskClass ?? step.requiredApproval?.riskClass ?? "read";
    const stepLevel = RISK_CLASS_LEVEL[effective];
    if (stepLevel !== "low") reasons.push(`step ${step.id} (${step.title}) is ${stepLevel}`);
    level = maxLevel(level, stepLevel);
  }

  for (const need of plan.requiredApprovals) {
    const needLevel = RISK_CLASS_LEVEL[need.riskClass];
    if (needLevel !== "low") reasons.push(`required approval for ${need.commandType ?? need.resourceType ?? "resource"} is ${needLevel}`);
    level = maxLevel(level, needLevel);
  }

  for (const risk of plan.risks) {
    if (risk.level !== "low") reasons.push(risk.description);
    level = maxLevel(level, risk.level);
  }

  return { level, reasons };
}

/**
 * Whether a plan must be shown to the user/approver before execution
 * (doc §Planning: medium/high-risk plans are shown before execution).
 */
export function planRequiresApproval(plan: AgentPlan): boolean {
  if (plan.requiredApprovals.length > 0) return true;
  return planRisk(plan).level !== "low";
}

/** Concise model-facing summary of a plan. */
export function summarizePlan(plan: AgentPlan): string {
  const risk = planRisk(plan);
  const steps = plan.steps
    .map((s) => `${s.id}:${s.title}${s.command ? ` (${s.command})` : ""}`)
    .join(" -> ");
  const approvals = plan.requiredApprovals.length;
  return `${plan.objective} [risk=${risk.level}, ${plan.steps.length} steps, ${approvals} approval(s), stopWhen=${plan.stopConditions.length ? plan.stopConditions.join("; ") : "none"}] ${steps}`;
}

/** Human-readable plan text for an approval card / console view. */
export function renderPlan(plan: AgentPlan): string {
  const risk = planRisk(plan);
  const lines: string[] = [`# ${plan.objective}`, `risk: ${risk.level}`];
  if (plan.assumptions.length > 0) {
    lines.push("assumptions:");
    for (const a of plan.assumptions) lines.push(`- ${a}`);
  }
  lines.push("steps:");
  for (const s of plan.steps) {
    const dep = s.dependsOn?.length ? ` (after ${s.dependsOn.join(", ")})` : "";
    const need = s.requiredApproval ? ` [needs approval: ${s.requiredApproval.reason}]` : "";
    lines.push(`- ${s.id} ${s.title}${dep}${need}`);
  }
  if (plan.requiredApprovals.length > 0) {
    lines.push("required approvals:");
    for (const a of plan.requiredApprovals) {
      lines.push(`- ${a.commandType ?? a.resourceType ?? a.resourceId ?? "resource"}: ${a.reason}`);
    }
  }
  if (plan.evidenceNeeded.length > 0) {
    lines.push("evidence needed:");
    for (const e of plan.evidenceNeeded) lines.push(`- ${e.type}${e.ref ? ` (${e.ref})` : ""}${e.note ? `: ${e.note}` : ""}`);
  }
  if (plan.stopConditions.length > 0) {
    lines.push(`stop when: ${plan.stopConditions.join("; ")}`);
  }
  return lines.join("\n");
}