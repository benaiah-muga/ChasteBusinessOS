import { z } from "zod";

export const RiskClass = z.enum(["read", "write", "money", "identity", "destructive", "secret"]);
export type RiskClass = z.infer<typeof RiskClass>;

export type ActorType = "human" | "agent" | "system";

export interface Actor {
  type: ActorType;
  id: string | null;
  orgId: string;
  permissions: ReadonlySet<string>;
}

export interface ActionContext {
  actor: Actor;
  sessionId?: string;
  /**
   * Client-originated action identity (B02): stable across retries of one
   * intended action. When present with a receipt store, the executor serves
   * the prior receipt instead of re-executing; a reused key with a different
   * payload is a conflict, never a silent second effect.
   */
  intentId?: string;
  now: Date;
  /** Side-channel for capabilities needing storage etc. Wired at app layer. */
  services: Record<string, unknown>;
}

export interface ApprovalRequest {
  capabilityId: string;
  riskClass: RiskClass;
  payload: unknown;
  rationale: string;
  expiresAt?: Date;
}

export interface CapabilityResult<O> {
  ok: boolean;
  data?: O;
  error?: string;
  /** Present when policy demanded human sign-off before execution. */
  pendingApproval?: ApprovalRequest;
  /**
   * Honest effect semantics (B02/F01): "unknown" means a governed write may
   * have committed but the result could not be proven (audit append failed,
   * or the capability returned output violating its schema). Callers must
   * not blindly retry an unknown outcome; they reconcile by action key.
   */
  outcome?: "known" | "unknown";
  /** True when the executor served the prior receipt for the same intent key. */
  replayed?: boolean;
}

export interface InverseSpec<I, O = unknown> {
  /** Builds the input for the inverse capability from the original input+output. */
  buildInput(input: I, output: O): Record<string, unknown>;
}

export interface Capability<I = unknown, O = unknown> {
  id: string;
  title: string;
  intent: string;
  module: string;
  risk: RiskClass;
  permission: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  /**
   * Money threshold above which approval is forced (minor units).
   * Ignored unless risk === "money".
   */
  moneyThresholdMinor?: number;
  /**
   * Extracts the governing monetary amount (minor units) from validated
   * input. Mandatory for risk === "money" capabilities (conformance):
   * gating on a name heuristic failed open whenever an input named its
   * amount unconventionally. Return null when no amount is knowable up
   * front (e.g. reversals); null is treated as "always gate", never as
   * "no gate". Declared as a method so Capability stays assignable across
   * input types (bivariance), matching execute().
   */
  moneyAmount?(input: I): number | null;
  /**
   * The inverse's buildInput is typed against THIS capability's validated
   * input and output, so an inverse that reads a key the output never
   * returns is a compile error, not a silent runtime undefined (N12).
   */
  inverse?: { capabilityId: string } & InverseSpec<I, O>;
  execute(ctx: ActionContext, input: I): Promise<O>;
}

export function defineCapability<I, O>(spec: Capability<I, O>): Capability<I, O> {
  return spec;
}
