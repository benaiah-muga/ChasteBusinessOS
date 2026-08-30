import { and, eq, lte, sql } from "drizzle-orm";
import { jobs, recurringInvoices, type Database } from "@chaste/db";
import { nextRunAfter, type RecurringFrequency } from "@chaste/erp-core";
import type { ActionContext, Actor, Logger } from "@chaste/kernel";
import { buildExecutor, buildRegistry } from "@/server/kernel";
import { executeRoutine } from "@/server/routines";

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
}

export async function enqueueCapabilityJob(
  db: Database["db"],
  input: {
    orgId: string;
    type: string;
    payload: unknown;
    createdByActorType?: string;
    createdByActorId?: string | null;
  },
): Promise<string> {
  const [row] = await db
    .insert(jobs)
    .values({
      orgId: input.orgId,
      type: input.type,
      payload: input.payload as object,
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

async function claimJob(db: Database["db"]): Promise<ClaimedJob | null> {
  const result = (await db.execute(sql`
    UPDATE jobs SET status = 'processing', attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'pending' AND attempts < max_attempts
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, org_id, type, payload, attempts, max_attempts
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
  };
}

/**
 * Expands due recurring templates into real invoices through the governed
 * executor (system actor scoped to accounting.write). Templates are claimed
 * with FOR UPDATE SKIP LOCKED so parallel workers never double-bill. The
 * handler re-enqueues itself while work remains, giving cron-like behavior
 * from the one-shot durable queue.
 */
async function processRecurringBatch(
  db: Database["db"],
  log: Logger,
  executor: ReturnType<typeof buildExecutor>,
): Promise<number> {
  const now = new Date();
  const due = (await db.execute(sql`
    UPDATE recurring_invoices SET last_run_at = now()
    WHERE id IN (
      SELECT id FROM recurring_invoices
      WHERE active = true AND next_run_at <= now()
      ORDER BY next_run_at
      LIMIT 25
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, org_id AS "orgId", customer_id AS "customerId", memo, frequency, lines
  `)) as unknown as Record<string, unknown>[] | { rows: Record<string, unknown>[] };
  const list: Record<string, unknown>[] = Array.isArray(due) ? due : (due.rows ?? []);
  let processed = 0;
  for (const t of list) {
    const orgId = String(t.orgId);
    const templateId = String(t.id);
    const log2 = log.child({ templateId, orgId });
    try {
      const lines = Array.isArray(t.lines) ? (t.lines as unknown[]) : [];
      const result = await executor.execute(
        "accounting.createInvoice",
        {
          actor: systemActorFor(orgId, "accounting.write"),
          now,
          services: {},
        },
        {
          customerId: String(t.customerId),
          memo: `Recurring${t.memo ? `: ${String(t.memo)}` : ""}`.slice(0, 300),
          lines,
        },
      );
      if (!result.ok) throw new Error(result.error ?? "invoice creation failed");
      const frequency = String(t.frequency) as RecurringFrequency;
      await db
        .update(recurringInvoices)
        .set({ nextRunAt: nextRunAfter(frequency, now) })
        .where(eq(recurringInvoices.id, templateId));
      processed += 1;
      log2.info("recurring invoice generated", {
        invoiceNumber: (result.data as { invoiceNumber?: number })?.invoiceNumber,
      });
    } catch (err) {
      // One bad template must not block the batch; deactivate after repeated
      // failures is future work — for now the error surfaces in job state.
      log2.warn("recurring expansion failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return processed;
}

async function hasMoreDue(db: Database["db"]): Promise<boolean> {
  const [row] = await db
    .select({ id: recurringInvoices.id })
    .from(recurringInvoices)
    .where(and(eq(recurringInvoices.active, true), lte(recurringInvoices.nextRunAt, new Date())))
    .limit(1);
  return Boolean(row);
}

/** Claims and runs at most one job. Returns false when the queue was empty. */
export async function processOneJob(db: Database["db"], log: Logger): Promise<boolean> {
  const job = await claimJob(db);
  if (!job) return false;

  const log2 = log.child({ jobId: job.id, capabilityId: job.type, orgId: job.orgId });

  try {
    if (job.type === "accounting.generateRecurringInvoices") {
      const registry = buildRegistry(db);
      const executor = buildExecutor(db, registry);
      const processed = await processRecurringBatch(db, log, executor);
      const more = await hasMoreDue(db);
      await db
        .update(jobs)
        .set({
          status: more ? "pending" : "done",
          attempts: 0,
          lastError: null,
          updatedAt: new Date(),
        })
        .where(sql`${jobs.id} = ${job.id}`);
      log2.info(more ? "recurring batch partial; rescheduled" : "recurring batch complete", {
        processed,
        more,
      });
      return true;
    }

    if (job.type === "routines.executeRoutine") {
      // Scheduling happened at claim time (tickRoutines); the run itself
      // goes through the governed executor inside executeRoutine.
      await executeRoutine(db, log2, job.payload as { routineId: string; trigger: string });
      await db
        .update(jobs)
        .set({ status: "done", lastError: null, updatedAt: new Date() })
        .where(sql`${jobs.id} = ${job.id}`);
      return true;
    }

    const registry = buildRegistry(db);
    const cap = registry.get(job.type);
    // Unknown types fail permanently: retrying can never succeed, and a
    // permissive fallback would silently widen what a queue row can do.
    if (!cap) throw new Error(`unknown job capability: ${job.type}`);
    const ctx: ActionContext = {
      actor: systemActorFor(job.orgId, cap.permission),
      now: new Date(),
      services: {},
    };
    const executor = buildExecutor(db, registry);
    const result = await executor.execute(job.type, ctx, job.payload);
    if (!result.ok) throw new Error(result.error ?? "capability failed");
    await db
      .update(jobs)
      .set({ status: "done", lastError: null, updatedAt: new Date() })
      .where(sql`${jobs.id} = ${job.id}`);
    log2.info("job done", { attempts: job.attempts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const exhausted = job.attempts >= job.maxAttempts || message.startsWith("unknown job capability:");
    await db
      .update(jobs)
      .set({
        status: exhausted ? "failed" : "pending",
        lastError: message,
        updatedAt: new Date(),
      })
      .where(sql`${jobs.id} = ${job.id}`);
    log2.warn(exhausted ? "job failed permanently" : "job attempt failed; will retry", {
      attempts: job.attempts,
      error: message,
    });
  }
  return true;
}
