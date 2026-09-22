import { and, asc, eq } from "drizzle-orm";
import {
  agentRunSteps,
  agentRuns,
  withOrgContext,
  type Database,
} from "@chaste/db";
import { canonicalInputHash } from "@chaste/kernel";
import { getHarnessComposition } from "./harness-compositions";

export const DURABLE_RUN_STATUSES = [
  "pending",
  "running",
  "waiting_approval",
  "paused",
  "cancel_requested",
  "cancelled",
  "blocked",
  "failed",
  "completed",
] as const;

export type DurableRunStatus = (typeof DURABLE_RUN_STATUSES)[number];

export interface DurableRunActor {
  type: string;
  id: string | null;
}

export interface CreateDurableRunInput {
  orgId: string;
  goal: string;
  actor: DurableRunActor;
  sessionId?: string | null;
  modelRef?: string | null;
  registryVersion?: string;
  harnessCompositionId?: string | null;
}

export interface RecordDurableStepInput {
  orgId: string;
  runId: string;
  stepIndex: number;
  capabilityId: string;
  capabilityVersion?: string;
  input: unknown;
  status: "pending" | "running" | "waiting_approval" | "committed" | "failed" | "cancelled";
  output?: unknown;
  error?: string | null;
  receiptId?: string | null;
  approvalId?: string | null;
}

export async function createDurableRun(
  db: Database["db"],
  input: CreateDurableRunInput,
): Promise<string> {
  const composition = input.harnessCompositionId
    ? await getHarnessComposition(db, input.orgId, input.harnessCompositionId)
    : null;
  if (input.harnessCompositionId && !composition) {
    throw new Error("harness composition not found for organization");
  }
  const [row] = await withOrgContext(db, input.orgId, async (tx) =>
    tx
      .insert(agentRuns)
      .values({
        orgId: input.orgId,
        sessionId: input.sessionId ?? null,
        goal: input.goal,
        status: "pending",
        registryVersion: input.registryVersion ?? process.env.REGISTRY_VERSION ?? "1",
        modelRef: input.modelRef ?? null,
        harnessCompositionId: composition?.id ?? null,
        harnessProfileId: composition?.profileId ?? null,
        harnessProfileVersion: composition?.profileVersion ?? null,
        harnessCompositionDigest: composition?.compositionDigest ?? null,
        initiatedByActorType: input.actor.type,
        initiatedByActorId: input.actor.id,
      })
      .returning({ id: agentRuns.id }),
  );
  return row!.id;
}

export async function transitionDurableRun(
  db: Database["db"],
  input: { orgId: string; runId: string; status: DurableRunStatus; currentStep?: number; error?: string | null },
): Promise<void> {
  const terminal = ["cancelled", "failed", "completed"].includes(input.status);
  await withOrgContext(db, input.orgId, async (tx) => {
    await tx
      .update(agentRuns)
      .set({
        status: input.status,
        currentStep: input.currentStep,
        lastError: input.error ?? null,
        startedAt: input.status === "running" ? new Date() : undefined,
        finishedAt: terminal ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .where(and(eq(agentRuns.id, input.runId), eq(agentRuns.orgId, input.orgId)));
  });
}

/**
 * Inserts one step idempotently. A retry of the same run/step returns the
 * original checkpoint instead of creating a second semantic action.
 */
export async function recordDurableStep(
  db: Database["db"],
  input: RecordDurableStepInput,
): Promise<{ id: string; inputHash: string; replayed: boolean }> {
  const inputHash = await canonicalInputHash(input.input);
  return withOrgContext(db, input.orgId, async (tx) => {
    const [existing] = await tx
      .select({ id: agentRunSteps.id, inputHash: agentRunSteps.inputHash })
      .from(agentRunSteps)
      .where(
        and(
          eq(agentRunSteps.orgId, input.orgId),
          eq(agentRunSteps.runId, input.runId),
          eq(agentRunSteps.stepIndex, input.stepIndex),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.inputHash !== inputHash) {
        throw new Error("durable run step conflict: same step has a different input");
      }
      return { id: existing.id, inputHash, replayed: true };
    }

    const [row] = await tx
      .insert(agentRunSteps)
      .values({
        orgId: input.orgId,
        runId: input.runId,
        stepIndex: input.stepIndex,
        capabilityId: input.capabilityId,
        capabilityVersion: input.capabilityVersion ?? process.env.REGISTRY_VERSION ?? "1",
        inputHash,
        input: input.input as object,
        status: input.status,
        output: input.output as object | undefined,
        error: input.error ?? null,
        receiptId: input.receiptId ?? null,
        approvalId: input.approvalId ?? null,
        startedAt: input.status === "running" ? new Date() : null,
        finishedAt: ["committed", "failed", "cancelled"].includes(input.status) ? new Date() : null,
      })
      .returning({ id: agentRunSteps.id });
    return { id: row!.id, inputHash, replayed: false };
  });
}

export async function transitionDurableStep(
  db: Database["db"],
  input: {
    orgId: string;
    runId: string;
    stepIndex: number;
    status: RecordDurableStepInput["status"];
    output?: unknown;
    error?: string | null;
    receiptId?: string | null;
    approvalId?: string | null;
  },
): Promise<boolean> {
  const terminal = ["committed", "failed", "cancelled"].includes(input.status);
  return withOrgContext(db, input.orgId, async (tx) => {
    const [row] = await tx
      .update(agentRunSteps)
      .set({
        status: input.status,
        output: input.output as object | undefined,
        error: input.error ?? null,
        receiptId: input.receiptId,
        approvalId: input.approvalId,
        startedAt: input.status === "running" ? new Date() : undefined,
        finishedAt: terminal ? new Date() : undefined,
      })
      .where(
        and(
          eq(agentRunSteps.orgId, input.orgId),
          eq(agentRunSteps.runId, input.runId),
          eq(agentRunSteps.stepIndex, input.stepIndex),
        ),
      )
      .returning({ id: agentRunSteps.id });
    return Boolean(row);
  });
}

export async function getDurableRun(
  db: Database["db"],
  orgId: string,
  runId: string,
): Promise<{ run: typeof agentRuns.$inferSelect; steps: (typeof agentRunSteps.$inferSelect)[] } | null> {
  return withOrgContext(db, orgId, async (tx) => {
    const [run] = await tx
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)))
      .limit(1);
    if (!run) return null;
    const steps = await tx
      .select()
      .from(agentRunSteps)
      .where(and(eq(agentRunSteps.runId, runId), eq(agentRunSteps.orgId, orgId)))
      .orderBy(asc(agentRunSteps.stepIndex));
    return { run, steps };
  });
}
