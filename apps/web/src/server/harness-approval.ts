import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  approvals,
  type Database,
} from "@chaste/db";
import {
  defineCapability,
  type ActionContext,
  type CapabilityRegistry,
  type KernelExecutor,
} from "@chaste/kernel";
import { getHarnessComposition } from "./harness-compositions";

export const HARNESS_COMPOSITION_APPROVAL_CAPABILITY = "harness.approveComposition";

export const harnessCompositionApprovalPayloadSchema = z.object({
  compositionId: z.string().uuid(),
  compositionDigest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type HarnessCompositionApprovalPayload = z.infer<typeof harnessCompositionApprovalPayloadSchema>;

export interface HarnessCompositionApproval {
  id: string;
  status: string;
  compositionId: string;
  compositionDigest: string;
  decidedByUserId: string | null;
  decisionComment: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

function payloadFor(compositionId: string, compositionDigest: string): HarnessCompositionApprovalPayload {
  return { compositionId, compositionDigest };
}

function toApproval(row: typeof approvals.$inferSelect): HarnessCompositionApproval | null {
  const payload = harnessCompositionApprovalPayloadSchema.safeParse(row.payload);
  if (!payload.success) return null;
  return {
    id: row.id,
    status: row.status,
    compositionId: payload.data.compositionId,
    compositionDigest: payload.data.compositionDigest,
    decidedByUserId: row.decidedByUserId,
    decisionComment: row.decisionComment,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

export async function findHarnessCompositionApproval(
  db: Database["db"],
  orgId: string,
  compositionId: string,
  compositionDigest: string,
): Promise<HarnessCompositionApproval | null> {
  const rows = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.capabilityId, HARNESS_COMPOSITION_APPROVAL_CAPABILITY)))
    .orderBy(desc(approvals.createdAt));
  const payload = payloadFor(compositionId, compositionDigest);
  for (const row of rows) {
    const approval = toApproval(row);
    if (
      approval &&
      approval.compositionId === payload.compositionId &&
      approval.compositionDigest === payload.compositionDigest
    ) {
      return approval;
    }
  }
  return null;
}

export async function requestHarnessCompositionApproval(
  db: Database["db"],
  executor: KernelExecutor,
  ctx: ActionContext,
  compositionId: string,
): Promise<{ approvalId: string; status: string; compositionDigest: string }> {
  const composition = await getHarnessComposition(db, ctx.actor.orgId, compositionId);
  if (!composition) throw new Error("harness composition not found for organization");

  const prior = await findHarnessCompositionApproval(
    db,
    ctx.actor.orgId,
    composition.id,
    composition.compositionDigest,
  );
  if (prior && ["pending", "executing", "executed"].includes(prior.status)) {
    return { approvalId: prior.id, status: prior.status, compositionDigest: composition.compositionDigest };
  }

  const result = await executor.execute(
    HARNESS_COMPOSITION_APPROVAL_CAPABILITY,
    ctx,
    payloadFor(composition.id, composition.compositionDigest),
  );
  if (result.ok || !result.pendingApproval) {
    throw new Error(result.error ?? "harness composition approval did not enter review");
  }

  const pending = await findHarnessCompositionApproval(
    db,
    ctx.actor.orgId,
    composition.id,
    composition.compositionDigest,
  );
  if (!pending) throw new Error("harness composition approval was not persisted");
  return { approvalId: pending.id, status: pending.status, compositionDigest: composition.compositionDigest };
}

export async function assertHarnessCompositionApproved(
  db: Database["db"],
  orgId: string,
  compositionId: string,
  compositionDigest: string,
  approvalId: string,
): Promise<HarnessCompositionApproval> {
  const approval = await findHarnessCompositionApproval(db, orgId, compositionId, compositionDigest);
  if (!approval || approval.id !== approvalId || approval.status !== "executed") {
    throw new Error("harness composition is not approved");
  }
  return approval;
}

export function registerHarnessApprovalCapabilities(
  registry: CapabilityRegistry,
  deps: { db: Database["db"] },
): void {
  registry.register(
    defineCapability({
      id: HARNESS_COMPOSITION_APPROVAL_CAPABILITY,
      title: "Approve harness composition",
      intent:
        "Record a human-authorized approval for an immutable tenant-owned harness composition before durable execution begins",
      module: "harness",
      risk: "identity",
      permission: "harness.approve",
      input: harnessCompositionApprovalPayloadSchema,
      output: z.object({ compositionId: z.string().uuid(), compositionDigest: z.string(), status: z.literal("approved") }),
      execute: async (ctx, input) => {
        const composition = await getHarnessComposition(deps.db, ctx.actor.orgId, input.compositionId);
        if (!composition || composition.compositionDigest !== input.compositionDigest) {
          throw new Error("harness composition identity no longer matches the approval request");
        }
        return { compositionId: composition.id, compositionDigest: composition.compositionDigest, status: "approved" as const };
      },
    }),
  );
}
