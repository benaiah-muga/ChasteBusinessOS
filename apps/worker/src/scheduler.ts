/**
 * ARCH-9/REL-2 — schedule driver.
 *
 * Two modes behind one interface:
 *   - "poll":   the worker loop fires due reminders / follow-ups inline each
 *               tick (previous behavior; requires no Redis).
 *   - "bullmq": the worker enqueues due reminders / follow-ups onto a Redis
 *               BullMQ queue with the exact remaining delay; a queue worker
 *               claims each job by id (atomic UPDATE…RETURNING) so a single
 *               item can never be double-fired across processes.
 *
 * Redis availability is probed at startup; if it is unreachable we fall back
 * to poll mode so the platform still works (loose coupling, no hard Redis
 * dependency). Poll mode is intentionally NOT "worse": both modes keep the
 * single-fire guarantee via the DB claim.
 */
import type { Db } from "@chaste/db";
import { createScheduleProcessor } from "@chaste/module-platform";
import { Redis } from "ioredis";
import { Queue, Worker } from "bullmq";
import { runFollowUp, type FollowUpHarness } from "./harness.js";

export type ScheduleMode = "poll" | "bullmq";

export interface ScheduleDriver {
  mode: ScheduleMode;
  /** Process currently-due work. In bullmq mode this enqueues due items; in
   * poll mode it fires/claims them inline. Returns what was enqueued/fired. */
  tick(): Promise<{ reminders: number; followUps: number }>;
  close(): Promise<void>;
}

export interface DueEnqueuer {
  enqueue(kind: "reminder" | "followup", id: string, delayMs: number): Promise<void>;
}

export interface DueScanner {
  listDueReminders(now?: Date): Promise<{ id: string; fireAt: Date }[]>;
  listDueFollowUps(now?: Date): Promise<{ id: string; fireAt: Date }[]>;
}

/**
 * Enqueue all currently-due reminders/follow-ups with the remaining delay so
 * BullMQ fires them at (or as soon after) their `fire_at`. Pure and injectable
 * for tests.
 */
export async function enqueueDue(
  scanner: DueScanner,
  enqueuer: DueEnqueuer,
  now = new Date(),
): Promise<{ reminders: number; followUps: number }> {
  const reminders = await scanner.listDueReminders(now);
  const followUps = await scanner.listDueFollowUps(now);
  for (const r of reminders) {
    await enqueuer.enqueue("reminder", r.id, Math.max(0, r.fireAt.getTime() - now.getTime()));
  }
  for (const f of followUps) {
    await enqueuer.enqueue("followup", f.id, Math.max(0, f.fireAt.getTime() - now.getTime()));
  }
  return { reminders: reminders.length, followUps: followUps.length };
}

export async function detectRedis(url?: string): Promise<boolean> {
  if (!url) return false;
  const probe = new Redis(url, {
    connectTimeout: 1_500,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  probe.on("error", () => {
    /* probe only — failures are surfaced by the ping below */
  });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    try {
      await probe.disconnect();
    } catch {
      /* ignore */
    }
  }
}

export interface ScheduleDriverDeps {
  db: Db;
  redisUrl?: string;
  schedule: ReturnType<typeof createScheduleProcessor>;
  followUps: FollowUpHarness;
}

function createPollDriver(deps: ScheduleDriverDeps): ScheduleDriver {
  return {
    mode: "poll",
    async tick() {
      const { schedule, followUps } = deps;
      const fired = await schedule.processDueReminders();
      if (fired > 0) {
        console.log(
          JSON.stringify({ service: "chaste-worker", action: "reminders_fired", count: fired }),
        );
      }
      const dueFollowUps = await schedule.claimDueFollowUps();
      for (const f of dueFollowUps) {
        try {
          const result = await runFollowUp(followUps, f.id, f.id);
          console.log(
            JSON.stringify({
              service: "chaste-worker",
              action: "followup_fired",
              followUpId: f.id,
              orgId: f.organizationId,
              userId: f.userId,
              status: result.status,
              sessionId: result.sessionId,
            }),
          );
        } catch (err) {
          console.error(
            JSON.stringify({
              service: "chaste-worker",
              action: "followup_failed",
              followUpId: f.id,
              orgId: f.organizationId,
              userId: f.userId,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
      return { reminders: fired, followUps: dueFollowUps.length };
    },
    async close() {
      /* nothing to release in poll mode */
    },
  };
}

function createBullMqDriver(deps: ScheduleDriverDeps): ScheduleDriver {
  const connection = new Redis(deps.redisUrl!, { maxRetriesPerRequest: null });
  const queue = new Queue("chaste-scheduling", { connection });
  const worker = new Worker(
    "chaste-scheduling",
    async (job) => {
      if (job.name === "scheduling.reminder.fire") {
        const row = await deps.schedule.claimReminderById(job.data.reminderId);
        if (row) {
          await deps.schedule.deliverReminder(row);
        }
      } else if (job.name === "scheduling.followup.run") {
        const row = await deps.schedule.claimFollowUpById(job.data.followUpId);
        if (row) {
          await runFollowUp(deps.followUps, row.id, row.id);
        }
      }
    },
    { connection, concurrency: 4 },
  );

  return {
    mode: "bullmq",
    async tick() {
      return enqueueDue(deps.schedule, {
        async enqueue(kind, id, delayMs) {
          const name = kind === "reminder" ? "scheduling.reminder.fire" : "scheduling.followup.run";
          await queue.add(name, kind === "reminder" ? { reminderId: id } : { followUpId: id }, {
            jobId: `${kind}-${id}`,
            delay: delayMs,
            attempts: 5,
            backoff: { type: "exponential", delay: 5_000 },
            removeOnComplete: { count: 1_000 },
            removeOnFail: { count: 1_000 },
          });
        },
      });
    },
    async close() {
      await worker.close();
      await queue.close();
      connection.disconnect();
    },
  };
}

export async function createScheduleDriver(deps: ScheduleDriverDeps): Promise<ScheduleDriver> {
  if (await detectRedis(deps.redisUrl)) {
    return createBullMqDriver(deps);
  }
  return createPollDriver(deps);
}
