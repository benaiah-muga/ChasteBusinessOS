import type { Actor } from "@chaste/kernel";
import { z } from "zod";

/**
 * External harness adapter contract (research doc §Harness Adapter Contract,
 * build item 16).
 *
 * External harnesses (Codex, Claude Code, opencode, DeepSeek Harness) are
 * optional accelerators for specialized technical/analytical work. They are
 * never direct business authorities: every run is bound to a Chaste actor, its
 * tool calls are mediated by the MCP gateway (revalidated, reauthorized,
 * audited), its traces attach as `externalHarness/*` artifacts, and the Chaste
 * trajectory on `runId` remains the audit spine.
 *
 * Security rules encoded here:
 *  - External harnesses receive scoped MCP/business tools mediated by Chaste.
 *  - Any proposed command is revalidated, reauthorized, and audited in Chaste.
 *  - Provider/model usage is recorded when the harness exposes it; otherwise
 *    the run is marked `usageVisibility: "unknown"` (incomplete downstream
 *    usage visibility — policy may forbid such runs for regulated operations).
 */

export const HARNESS_KINDS = [
  "deepseek-harness",
  "claude-code",
  "opencode",
  "codex",
  "custom",
] as const;
export type HarnessKind = (typeof HARNESS_KINDS)[number];

/** A tool an external harness is explicitly allowed to call. */
export const harnessToolGrantSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
});
export type HarnessToolGrant = z.infer<typeof harnessToolGrantSchema>;

export const harnessArtifactSchema = z.object({
  ref: z.string().min(1),
  summary: z.string().optional(),
  version: z.string().optional(),
});
export type HarnessArtifact = z.infer<typeof harnessArtifactSchema>;

/** JSON-safe snapshot of the actor a run is bound to. */
export interface HarnessActorSnapshot {
  kind: Actor["kind"];
  userId: string;
  organizationId: string;
  displayName?: string;
  clientId?: string;
  permissions: string[];
}

export const harnessStartRequestSchema = z.object({
  objective: z.string().min(1),
  tenantId: z.string().min(1),
  workspace: z.string().optional(),
  allowedTools: z.array(harnessToolGrantSchema).default([]),
  forbiddenDataClasses: z.array(z.string()).default([]),
  outputSchema: z.unknown().optional(),
  budget: z.object({ maxUsd: z.number().positive() }).optional(),
  deadline: z.string().optional(),
  contextBundle: z.unknown().optional(),
  auditCorrelationId: z.string().optional(),
});
export type HarnessStartRequestFields = z.infer<typeof harnessStartRequestSchema>;
export interface HarnessStartRequest extends HarnessStartRequestFields {
  actor: Actor;
}

export type HarnessRunStatus = "running" | "succeeded" | "failed" | "cancelled" | "blocked";

/** A run handle — fully reconstructable from the trajectory's
 * `externalHarness/session-start` event, so a stateless HTTP layer can resume
 * a run from `runId` alone. */
export interface HarnessRunHandle {
  /** The Chaste trajectory session id this run records onto (audit spine). */
  runId: string;
  harnessId: string;
  kind: HarnessKind;
  actor: HarnessActorSnapshot;
  objective: string;
  tenantId?: string;
  workspace?: string;
  allowedTools: HarnessToolGrant[];
  forbiddenDataClasses: string[];
  outputSchema?: unknown;
  budget?: { maxUsd: number };
  deadline?: string;
  auditCorrelationId?: string;
  status: HarnessRunStatus;
  usageVisibility: "recorded" | "unknown";
  modelUsage: Array<{
    provider?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    costCents?: number;
  }>;
  toolOutcomes: HarnessToolOutcome[];
  artifacts: HarnessArtifact[];
  proposedCommands: unknown[];
  summary: string;
}

export interface HarnessToolOutcome {
  tool: string;
  toolCallId?: string;
  ok: boolean;
  summary?: string;
  error?: string;
  approvalRequired?: boolean;
}

export const harnessMessageSchema = z.object({
  role: z.enum(["user", "assistant"]).default("assistant"),
  content: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  usage: z
    .object({
      promptTokens: z.number().optional(),
      completionTokens: z.number().optional(),
      costCents: z.number().optional(),
    })
    .optional(),
  toolCalls: z
    .array(
      z.object({
        tool: z.string().min(1),
        args: z.unknown().optional(),
        toolCallId: z.string().optional(),
      }),
    )
    .optional(),
  artifacts: z.array(harnessArtifactSchema).optional(),
  proposedCommands: z.array(z.unknown()).optional(),
  endSession: z.boolean().optional(),
});
export type HarnessMessage = z.infer<typeof harnessMessageSchema>;

export interface HarnessRunResult {
  status: HarnessRunStatus;
  /** The harness's structured output, when an outputSchema was enforced. */
  structured?: unknown;
  summary: string;
  evidenceRefs: HarnessArtifact[];
  artifacts: HarnessArtifact[];
  /** The Chaste trajectory session id — the audit spine for the run. */
  traceRef: string;
  modelUsage: HarnessRunHandle["modelUsage"];
  proposedCommands: unknown[];
  usageVisibility: "recorded" | "unknown";
}

export interface HarnessCapabilities {
  id: string;
  kind: HarnessKind;
  name: string;
  description: string;
  connector: string;
  recordsProviderModel: boolean;
  supportsArtifacts: boolean;
  integrationNotes: string[];
}

export interface HarnessDefinition {
  id: string;
  kind: HarnessKind;
  name: string;
  description: string;
  connector: string;
  recordsProviderModel: boolean;
  supportsArtifacts: boolean;
  integrationNotes: string[];
}

export interface HarnessAdapter {
  id: string;
  kind: HarnessKind;
  capabilities(): Promise<HarnessCapabilities>;
  start(request: HarnessStartRequest): Promise<HarnessRunHandle>;
  followup(handle: HarnessRunHandle, message: HarnessMessage): Promise<HarnessRunHandle>;
  cancel(handle: HarnessRunHandle, reason: string): Promise<HarnessRunHandle>;
  collect(handle: HarnessRunHandle): Promise<HarnessRunResult>;
}
