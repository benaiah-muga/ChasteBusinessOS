import { z } from "zod";
import type { components } from "../generated/business-v1";

export type CapabilityExecutionRequest = components["schemas"]["CapabilityExecutionRequest"];
export type CapabilityExecutionSuccess = components["schemas"]["CapabilityExecutionSuccess"];
export type CapabilityExecutionPending = components["schemas"]["CapabilityExecutionPending"];
export type CapabilityExecutionRefusal = components["schemas"]["CapabilityExecutionRefusal"];

export const CapabilityExecutionSuccessSchema: z.ZodType<CapabilityExecutionSuccess> = z.object({
  ok: z.literal(true),
  data: z.unknown(),
}).strict();

export const CapabilityExecutionPendingSchema: z.ZodType<CapabilityExecutionPending> = z.object({
  ok: z.literal(false),
  pendingApproval: z.literal(true),
  reason: z.string(),
  approvalId: z.string().optional(),
}).strict();

export const CapabilityExecutionRefusalSchema: z.ZodType<CapabilityExecutionRefusal> = z.object({
  ok: z.literal(false),
  data: z.unknown().optional(),
  error: z.string().optional(),
  approvalId: z.string().optional(),
  approvalRationale: z.string().optional(),
  replayed: z.boolean().optional(),
}).strict();

export function capabilityExecutionRequest(
  capabilityId: string,
  input: unknown,
  intentId?: string,
): CapabilityExecutionRequest {
  return intentId === undefined ? { capabilityId, input } : { capabilityId, input, intentId };
}
