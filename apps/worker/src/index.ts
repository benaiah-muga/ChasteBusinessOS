/**
 * Outbox worker — drains unprocessed domain events and routes them
 * to registered handlers. Each handler is idempotent and may be called
 * more than once for the same event.
 *
 * ARCH-9/REL-2 — delivery is now claim-based (FOR UPDATE SKIP LOCKED) with
 * attempts/last_error accounting, exponential backoff via next_attempt_at,
 * and a dead-letter queue (dead_letter_events) after retries are exhausted.
 * Operators get an in-app notification (kind "dead_letter") when an event is
 * dead-lettered. Scheduled reminders/follow-ups run through a schedule driver
 * that prefers Redis/BullMQ and falls back to the poll loop.
 *
 * Secrets via env (DATABASE_URL); no elevated business privileges.
 */
import { loadConfig } from "@chaste/config";
import { createDb, PostgresOutboxWriter, schema, usersWithPermission } from "@chaste/db";
import { createDefaultProcessor } from "@chaste/kernel";
import { createBackupProcessor, createEmailProcessor, createScheduleProcessor } from "@chaste/module-platform";
import { createFollowUpHarness } from "./harness.js";
import { registerBuzzMirror } from "./buzz.js";
import { drainOnce, type OutboxEventRow } from "./drain.js";
import { createScheduleDriver } from "./scheduler.js";
import { createProactiveProcessor } from "./proactive.js";

/**
 * Notify operators (holders of `core.outbox.manage`) that an event hit the
 * dead-letter queue. Notification insert is best-effort: a notification failure
 * must not take the event down or loop back into the outbox.
 */
async function notifyDeadLetter(db: ReturnType<typeof createDb>, row: OutboxEventRow): Promise<void> {
  try {
    const admins = await usersWithPermission(db, row.organizationId, "core.outbox.manage");
    for (const admin of admins) {
      await db.insert(schema.notifications).values({
        organizationId: row.organizationId,
        userId: admin.userId,
        kind: "dead_letter",
        title: `Event ${row.type} dead-lettered`,
        body: `Outbox event ${row.id} exhausted its retries and was moved to the dead-letter queue.`,
        href: "/ops/outbox",
        resourceType: "outbox_event",
        resourceId: row.id,
      });
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        service: "chaste-worker",
        action: "dead_letter_notify_failed",
        eventId: row.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

async function main() {
  const cfg = loadConfig();
  const db = createDb(cfg.databaseUrl);
  const outbox = new PostgresOutboxWriter(db);
  const processor = createDefaultProcessor();
  const buzzBridge = registerBuzzMirror(processor, db);
  const schedule = createScheduleProcessor(db);
  const email = createEmailProcessor(db);
  const backups = createBackupProcessor(db);
  const followUps = await createFollowUpHarness(cfg, db);
  const proactive = createProactiveProcessor(db);
  const driver = await createScheduleDriver({
    db,
    redisUrl: cfg.redisUrl,
    schedule,
    followUps,
  });
  const intervalMs = Number(process.env.WORKER_POLL_MS ?? 5_000);
  const batchSize = Number(process.env.WORKER_OUTBOX_BATCH ?? 50);
  const maxRetries = Number(process.env.WORKER_MAX_RETRIES ?? 3);
  const backoffMs = Number(process.env.WORKER_BACKOFF_MS ?? 10_000);

  console.log(
    JSON.stringify({
      service: "chaste-worker",
      status: "starting",
      region: cfg.region,
      pollMs: intervalMs,
      scheduleMode: driver.mode,
      buzzBridge,
      registeredHandlers: processor.registeredTypes(),
      backupProvider: backups.provider,
    }),
  );

  async function tick() {
    // C2/C5 — fire due reminders / follow-ups (poll mode) or enqueue them for
    // the BullMQ workers (bullmq mode). Single-fire is guaranteed by the DB claim.
    try {
      await driver.tick();
    } catch (err) {
      console.error(
        JSON.stringify({
          service: "chaste-worker",
          action: "schedule_error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // ADR 0014 — collect due watch-rule suggestions, gate, and deliver
    // notifications. Never executes request_approval/draft intents itself.
    try {
      const result = await proactive.tick();
      if (result.delivered > 0) {
        console.log(
          JSON.stringify({
            service: "chaste-worker",
            action: "proactive_delivered",
            ...result,
          }),
        );
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          service: "chaste-worker",
          action: "proactive_error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // C6 — flush queued email through the provider adapter.
    try {
      const sent = await email.flushEmailOutbox();
      if (sent > 0) {
        console.log(
          JSON.stringify({
            service: "chaste-worker",
            action: "email_flushed",
            count: sent,
            provider: email.adapterId,
          }),
        );
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          service: "chaste-worker",
          action: "email_error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // C7 — snapshot + encrypt + store queued backups through the object store.
    try {
      const done = await backups.flushBackupJobs();
      if (done > 0) {
        console.log(
          JSON.stringify({
            service: "chaste-worker",
            action: "backups_flushed",
            count: done,
            provider: backups.provider,
          }),
        );
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          service: "chaste-worker",
          action: "backup_error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    // ARCH-9/REL-2 — claim-and-ack outbox drain with retries → dead-letter.
    try {
      const result = await drainOnce(outbox, processor, (row) => notifyDeadLetter(db, row), {
        batch: batchSize,
        maxRetries,
        backoffMs,
        errorCode: "HANDLER_ERROR",
      });
      if (result.claimed > 0) {
        console.log(
          JSON.stringify({
            service: "chaste-worker",
            action: "outbox_drained",
            ...result,
          }),
        );
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          service: "chaste-worker",
          action: "outbox_error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  // Graceful shutdown
  let running = true;
  process.on("SIGTERM", () => {
    console.log(JSON.stringify({ service: "chaste-worker", status: "shutting_down" }));
    running = false;
  });
  process.on("SIGINT", () => {
    console.log(JSON.stringify({ service: "chaste-worker", status: "shutting_down" }));
    running = false;
  });

  while (running) {
    try {
      await tick();
    } catch (err) {
      console.error(
        JSON.stringify({
          service: "chaste-worker",
          action: "tick_error",
          error: String(err),
        }),
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  await driver.close();
  try {
    await db.$client.end({ timeout: 5 });
  } catch (err) {
    console.error(
      JSON.stringify({
        service: "chaste-worker",
        action: "db_close_failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  console.log(JSON.stringify({ service: "chaste-worker", status: "stopped" }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
