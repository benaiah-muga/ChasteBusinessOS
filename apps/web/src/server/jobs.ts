import { and, eq, sql } from "drizzle-orm";
import { approvals, jobs, type Database } from "@chaste/db";
import type { ActionContext, Actor, Logger } from "@chaste/kernel";
import { buildExecutor, buildRegistry } from "@/server/kernel";
import { executeRoutine } from "@/server/routines";
import { findActionReceiptId } from "@/server/effect-receipts";
import {
  transitionDurableRun,
  transitionDurableStep,
} from "@/server/durable-runs";

/**
 * Durable capability-job queue. Jobs reference a registered capability by id
 * and are executed through KernelExecutor, the single governed path:
 * validation, permission checks, policy gates, and audit apply to background
 * work too. Claiming uses FOR UPDATE SKIP LOCKED, so multiple workers are
 * safe. The `pnpm worker` script wraps this loop.
 */

export interface ClaimedJob {
  id: string;
  orgId: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  workerId: string;
  fencingToken: number;
  runId: string | null;
  runStepIndex: number | null;
  approvedApprovalId: string | null;
}

export interface ProcessJobOptions {
  /** Stable worker identity used by the lease and fencing predicates. */
  workerId?: string;
  /** Short lease keeps crashed work reclaimable without delaying recovery. */
  leaseMs?: number;
  /** Injectable clock makes expiry/reclaim behavior deterministic in tests. */
  now?: Date;
}

const DEFAULT_LEASE_MS = 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export async function enqueueCapabilityJob(
  db: Database["db"],
  input: {
    orgId: string;
    type: string;
    payload: unknown;
    createdByActorType?: string;
    createdByActorId?: string | null;
    runId?: string | null;
    runStepIndex?: number | null;
    approvedApprovalId?: string | null;
  },
): Promise<string> {
  const [row] = await db
    .insert(jobs)
    .values({
      orgId: input.orgId,
      type: input.type,
      payload: input.payload as object,
      runId: input.runId ?? null,
      runStepIndex: input.runStepIndex ?? null,
      approvedApprovalId: input.approvedApprovalId ?? null,
      createdByActorType: input.createdByActorType ?? "system",
      createdByActorId: input.createdByActorId ?? null,
    })
    .returning({ id: jobs.id });
  return row!.id;
}

/**
 * The system actor holds exactly the permission of the capability it runs,
 * never a wildcard. A queue insert must therefore only ever confer the power
 * of one declared capability; "*" would turn any future row-injection bug
 * into org-admin execution.
 */
export function systemActorFor(orgId: string, permission: string): Actor {
  return { type: "system", id: null, orgId, permissions: new Set([permission]) };
}

async function reapExhaustedLeases(db: Database["db"], now: Date): Promise<void> {
  await db
    .update(jobs)
    .set({
      status: "failed",
      lastError: "job lease expired after maximum attempts",
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(
      sql`${jobs.status} = 'processing' AND ${jobs.leaseExpiresAt} <= ${now.toISOString()}::timestamptz AND ${jobs.attempts} >= ${jobs.maxAttempts}`,
    );
}

export async function claimJob(
  db: Database["db"],
  workerId: string,
  leaseMs: number,
  now: Date,
): Promise<ClaimedJob | null> {
  const leaseExpiresAt = new Date(now.getTime() + leaseMs);
  const result = (await db.execute(sql`
    UPDATE jobs
    SET status = 'processing',
        attempts = attempts + 1,
        lease_owner = ${workerId},
        lease_expires_at = ${leaseExpiresAt.toISOString()}::timestamptz,
        fencing_token = fencing_token + 1,
        updated_at = ${now.toISOString()}::timestamptz
    WHERE id = (
      SELECT id FROM jobs
      WHERE (
        status = 'pending' AND attempts < max_attempts AND available_at <= ${now.toISOString()}::timestamptz
      ) OR (
        status = 'processing' AND lease_expires_at <= ${now.toISOString()}::timestamptz AND attempts < max_attempts
      )
      ORDER BY available_at, created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, org_id, type, payload, attempts, max_attempts, fencing_token,
      run_id, run_step_index, approved_approval_id
  `)) as unknown as { rows?: Record<string, unknown>[] } | Record<string, unknown>[];
  // postgres-js returns a plain array; other drivers wrap it in { rows }.
  const list = Array.isArray(result) ? result : (result.rows ?? []);
  const row = list[0];
  if (!row) return null;
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    type: String(row.type),
    payload: row.payload,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    workerId,
    fencingToken: Number(row.fencing_token),
    runId: row.run_id ? String(row.run_id) : null,
    runStepIndex: row.run_step_index == null ? null : Number(row.run_step_index),
    approvedApprovalId: row.approved_approval_id ? String(row.approved_approval_id) : null,
  };
}

async function renewLease(db: Database["db"], job: ClaimedJob, leaseMs: number): Promise<boolean> {
  const [row] = await db
    .update(jobs)
    .set({ leaseExpiresAt: new Date(Date.now() + leaseMs), updatedAt: new Date() })
    .where(
      sql`${jobs.id} = ${job.id} AND ${jobs.status} = 'processing' AND ${jobs.leaseOwner} = ${job.workerId} AND ${jobs.fencingToken} = ${job.fencingToken}`,
    )
    .returning({ id: jobs.id });
  return Boolean(row);
}

export async function finalizeJob(
  db: Database["db"],
  job: ClaimedJob,
  patch: { status: string; lastError?: string | null; availableAt?: Date },
): Promise<boolean> {
  const values: {
    status: string;
    lastError: string | null;
    leaseOwner: null;
    leaseExpiresAt: null;
    updatedAt: Date;
    availableAt?: Date;
  } = {
    status: patch.status,
    lastError: patch.lastError ?? null,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: new Date(),
  };
  if (patch.availableAt) values.availableAt = patch.availableAt;
  const [row] = await db
    .update(jobs)
    .set(values)
    .where(
      sql`${jobs.id} = ${job.id} AND ${jobs.status} = 'processing' AND ${jobs.leaseOwner} = ${job.workerId} AND ${jobs.fencingToken} = ${job.fencingToken}`,
    )
    .returning({ id: jobs.id });
  return Boolean(row);
}

function retryDelayMs(attempts: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

/** Claims and runs at most one job. Returns false when the queue was empty. */
export async function processOneJob(
  db: Database["db"],
  log: Logger,
  options: ProcessJobOptions = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const workerId = options.workerId ?? `${process.pid}:${crypto.randomUUID()}`;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  await reapExhaustedLeases(db, now);
  const job = await claimJob(db, workerId, leaseMs, now);
  if (!job) return false;

  const log2 = log.child({ jobId: job.id, capabilityId: job.type, orgId: job.orgId });
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void renewLease(db, job, leaseMs)
      .then((owned) => {
        if (!owned) leaseLost = true;
      })
      .catch(() => undefined);
  }, Math.max(100, Math.floor(leaseMs / 3)));
  heartbeat.unref?.();

  const durableRunId = job.runId;
  const durableStepIndex = job.runStepIndex;
  const durable = durableRunId !== null && durableStepIndex !== null;
  if (durable) {
    await transitionDurableRun(db, {
      orgId: job.orgId,
      runId: durableRunId,
      status: "running",
      currentStep: durableStepIndex,
    });
    await transitionDurableStep(db, {
      orgId: job.orgId,
      runId: durableRunId,
      stepIndex: durableStepIndex,
      status: "running",
      approvalId: job.approvedApprovalId,
    });
  }

  try {
    if (job.type === "routines.executeRoutine") {
      // Scheduling happened at claim time (tickRoutines); the run itself
      // goes through the governed executor inside executeRoutine.
      await executeRoutine(db, log2, job.payload as { routineId: string; trigger: string });
      const finalized = !leaseLost && (await finalizeJob(db, job, { status: "done" }));
      if (!finalized) log2.warn("job completed after lease was lost; acknowledgement fenced");
      return true;
    }

    const registry = buildRegistry(db);
    const cap = registry.get(job.type);
    // Unknown types fail permanently: retrying can never succeed, and a
    // permissive fallback would silently widen what a queue row can do.
    if (!cap) throw new Error(`unknown job capability: ${job.type}`);
    const ctx: ActionContext = {
      actor: systemActorFor(job.orgId, cap.permission),
      // A redelivery of one queue row must replay its governed receipt rather
      // than create a second business effect.
      intentId: job.id,
      now: new Date(),
      services: {},
    };
    const executor = buildExecutor(db, registry);
    const result = await executor.execute(job.type, ctx, job.payload, {
      approvedApprovalId: job.approvedApprovalId ?? undefined,
    });
    if (!result.ok) throw new Error(result.error ?? "capability failed");
    if (job.approvedApprovalId) {
      await db
        .update(approvals)
        .set({ status: "executed", decidedAt: new Date() })
        .where(and(eq(approvals.id, job.approvedApprovalId), eq(approvals.status, "executing")));
    }
    if (durable) {
      await transitionDurableStep(db, {
        orgId: job.orgId,
        runId: durableRunId!,
        stepIndex: durableStepIndex!,
        status: "committed",
        output: result.data,
        receiptId: await findActionReceiptId(db, job.orgId, job.id),
        approvalId: job.approvedApprovalId,
      });
    }
    const finalized = !leaseLost && (await finalizeJob(db, job, { status: "done" }));
    if (!finalized) log2.warn("job completed after lease was lost; acknowledgement fenced");
    log2.info("job done", { attempts: job.attempts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = job.attempts >= job.maxAttempts || message.startsWith("unknown job capability:");
    if (durable && exhausted) {
      await transitionDurableStep(db, {
        orgId: job.orgId,
        runId: durableRunId!,
        stepIndex: durableStepIndex!,
        status: "failed",
        error: message,
        approvalId: job.approvedApprovalId,
      });
      await transitionDurableRun(db, {
        orgId: job.orgId,
        runId: job.runId!,
        status: "failed",
        currentStep: durableStepIndex!,
        error: message,
      });
    }
    const finalized =
      !leaseLost &&
      (await finalizeJob(db, job, {
        status: exhausted ? "failed" : "pending",
        lastError: message,
        availableAt: exhausted ? undefined : new Date(Date.now() + retryDelayMs(job.attempts)),
      }));
    if (!finalized) log2.warn("job failure after lease was lost; acknowledgement fenced", { error: message });
    log2.warn(exhausted ? "job failed permanently" : "job attempt failed; will retry", {
      attempts: job.attempts,
      error: message,
    });
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
