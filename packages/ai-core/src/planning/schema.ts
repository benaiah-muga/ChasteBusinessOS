import { z } from "zod";

/**
 * Zod contracts for agent plans (research doc §Planning). Plans are validated
 * at every boundary (chat UI parts, harness, inbox cards) so the model can
 * propose a plan but never invent a shape the kernel rejects.
 */

export const planRiskLevelSchema = z.enum(["low", "medium", "high"]);

export const riskClassSchema = z.enum(["read", "write_local", "exec", "external"]);

export const approvalNeedSchema = z
  .object({
    commandType: z.string().min(1).optional(),
    resourceType: z.string().min(1).optional(),
    resourceId: z.string().min(1).optional(),
    riskClass: riskClassSchema,
    reason: z.string().min(1),
  })
  .strict();

export const planRiskSchema = z
  .object({
    level: planRiskLevelSchema,
    description: z.string().min(1),
    mitigation: z.string().min(1).optional(),
  })
  .strict();

export const evidenceNeedSchema = z
  .object({
    type: z.string().min(1),
    ref: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  })
  .strict();

export const planStepSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    command: z.string().min(1).optional(),
    args: z.unknown().optional(),
    riskClass: riskClassSchema.optional(),
    requiredApproval: approvalNeedSchema.optional(),
    dependsOn: z.array(z.string().min(1)).default([]),
    expectedEvidence: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const agentPlanSchema = z
  .object({
    id: z.string().min(1),
    objective: z.string().min(1),
    assumptions: z.array(z.string()).default([]),
    steps: z.array(planStepSchema).min(1),
    requiredApprovals: z.array(approvalNeedSchema).default([]),
    risks: z.array(planRiskSchema).default([]),
    evidenceNeeded: z.array(evidenceNeedSchema).default([]),
    stopConditions: z.array(z.string()).default([]),
  })
  .strict();

export type PlanValidationResult =
  | { ok: true; plan: z.infer<typeof agentPlanSchema> }
  | { ok: false; issues: Array<{ path: string; message: string }> };

/** Validate an AgentPlan at a boundary; returns typed issues on failure. */
export function validatePlan(input: unknown): PlanValidationResult {
  const parsed = agentPlanSchema.safeParse(input);
  if (parsed.success) return { ok: true, plan: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => ({
      path: i.path.join(".") || "(root)",
      message: i.message,
    })),
  };
}