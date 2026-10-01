import { and, eq } from "drizzle-orm";
import {
  hasPermission,
  ledgerEventFor,
  type CapabilityRegistry,
  type CapabilityResult,
  type KernelExecutor,
} from "@chaste/kernel";
import { approvals, type Database, withOrgContext } from "@chaste/db";
import { actorFromResolved, PgLedgerStore, type ResolvedUser } from "./kernel";

/**
 * Approve/reject a pending approval gate.
 *
 * Concurrency contract: the status transition is claimed atomically
 * (UPDATE ... WHERE status = 'pending') BEFORE execution. Two concurrent
 * approvers can never both execute the gated capability; exactly one claim
 * wins and the loser gets a conflict. A crash between claim and finalize
 * leaves the row in "executing", which the inbox surfaces for re-drive
 * instead of silently allowing a second execution.
 */
export type DecisionResult =
  | { ok: true; status: "rejected" }
  | { ok: true; status: "executed" | "approved"; result: CapabilityResult<never> }
  | { ok: false; code: number; error: string };

export async function decideApproval(
  db: Database["db"],
  executor: KernelExecutor,
  registry: CapabilityRegistry,
  resolved: ResolvedUser,
  input: { approvalId: string; decision: "approve" | "reject"; comment?: string },
  transactionExecutorFactory?: (transactionDb: Database["db"]) => KernelExecutor,
): Promise<DecisionResult> {
  const orgScope = resolved.orgId;
  if (!orgScope) return { ok: false, code: 428, error: "onboarding required" };
  const [approval] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, input.approvalId), eq(approvals.orgId, orgScope)))
    .limit(1);
  if (!approval) return { ok: false, code: 404, error: "not found" };

  // A stale gate must not stay approvable forever: business context (prices,
  // balances, vendors) may have moved on since it was raised. Expire it
  // conditionally so a concurrent decision still wins cleanly.
  if (
    approval.status === "pending" &&
    approval.expiresAt &&
    approval.expiresAt.getTime() <= Date.now()
  ) {
    const expired = await db
      .update(approvals)
      .set({ status: "expired" })
      .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")))
      .returning({ id: approvals.id });
    if (expired.length > 0) {
      return { ok: false, code: 410, error: "this approval has expired; request it again" };
    }
    return alreadyDecided("expired");
  }

  const humanCtx = actorFromResolved(resolved, {});
  if (!humanCtx) return { ok: false, code: 428, error: "onboarding required" };
  const decidedAt = new Date();

  if (input.decision === "reject") {
    const rejected = await withOrgContext(db, orgScope, async (tx) => {
      const rows = await tx
        .update(approvals)
        .set({
          status: "rejected",
          decidedByUserId: resolved.userId,
          decisionComment: input.comment ?? null,
          decidedAt,
        })
        // Conditional transition: only the first reject of a pending row wins.
        .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")))
        .returning({ id: approvals.id });
      if (rows.length === 0) return false;
      const txAsDb = tx as unknown as Database["db"];
      await new PgLedgerStore(txAsDb).append(
        ledgerEventFor(humanCtx, "approval.rejected", approval.capabilityId, {
          approvalId: approval.id,
          comment: input.comment ?? null,
        }),
      );
      return true;
    });
    if (!rejected) return alreadyDecided(approval.status);
    return { ok: true, status: "rejected" };
  }

  // Approver must hold the capability's own permission; authority can't be
  // laundered through the inbox. Checked before claiming so unauthorized
  // users never consume a pending gate.
  const cap = registry.get(approval.capabilityId);
  if (!cap) return { ok: false, code: 422, error: `unknown capability: ${approval.capabilityId}` };
  if (!hasPermission({ permissions: resolved.permissions }, cap.permission)) {
    return { ok: false, code: 403, error: "you lack authority over this action" };
  }

  const claimed = await db
    .update(approvals)
    .set({ status: "executing" })
    .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending")))
    .returning({ id: approvals.id });
  if (claimed.length === 0) return alreadyDecided(approval.status);

  let result: CapabilityResult<unknown>;
  let finalStatus: "executed" | "approved" | "failed" = "failed";
  if (transactionExecutorFactory) {
    try {
      result = await withOrgContext(db, orgScope, async (tx) => {
        const txAsDb = tx as unknown as Database["db"];
        const transactionExecutor = transactionExecutorFactory(txAsDb);
        const execution = await transactionExecutor.execute(approval.capabilityId, humanCtx, approval.payload, {
          approvedApprovalId: approval.id,
        });
        finalStatus = execution.ok ? "executed" : execution.pendingApproval ? "approved" : "failed";
        const finalized = await tx
          .update(approvals)
          .set({
            status: finalStatus,
            decidedByUserId: resolved.userId,
            decisionComment: input.comment ?? null,
            decidedAt,
          })
          .where(and(eq(approvals.id, approval.id), eq(approvals.status, "executing")))
          .returning({ id: approvals.id });
        if (finalized.length !== 1) throw new Error("approval execution claim was lost before finalization");
        return execution;
      });
    } catch (executionError) {
      try {
        await withOrgContext(db, orgScope, async (tx) => {
          await tx
            .update(approvals)
            .set({ status: "pending" })
            .where(and(eq(approvals.id, approval.id), eq(approvals.status, "executing")));
        });
      } catch (recoveryError) {
        throw new AggregateError([executionError, recoveryError], "approval execution failed and pending recovery failed");
      }
      throw executionError;
    }
  } else {
    result = await executor.execute(approval.capabilityId, humanCtx, approval.payload, {
      approvedApprovalId: approval.id,
    });

    finalStatus = result.ok ? "executed" : result.pendingApproval ? "approved" : "failed";
    await db
      .update(approvals)
      .set({
        status: finalStatus,
        decidedByUserId: resolved.userId,
        decisionComment: input.comment ?? null,
        decidedAt,
      })
      .where(eq(approvals.id, approval.id));
  }

  if (!result.ok && !result.pendingApproval) {
    return { ok: false, code: 422, error: result.error ?? "execution failed" };
  }
  return { ok: true, status: finalStatus as "executed" | "approved", result: result as CapabilityResult<never> };
}

function alreadyDecided(status: string): DecisionResult {
  if (status === "executing") {
    return {
      ok: false,
      code: 409,
      error: "this approval is being executed elsewhere; refresh to see the outcome",
    };
  }
  return { ok: false, code: 409, error: `already ${status}` };
}
