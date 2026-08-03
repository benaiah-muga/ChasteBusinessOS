/**
 * Outbox worker — drains unprocessed domain events and routes them
 * to registered handlers. Each handler is idempotent and may be called
 * more than once for the same event.
 *
 * Secrets via env (DATABASE_URL); no elevated business privileges.
 */
import { loadConfig } from "@chaste/config";
import { createDb, PostgresOutboxWriter } from "@chaste/db";
import { createDefaultProcessor } from "@chaste/kernel";
import { createScheduleProcessor } from "@chaste/module-platform";

async function main() {
  const cfg = loadConfig();
  const db = createDb(cfg.databaseUrl);
  const outbox = new PostgresOutboxWriter(db);
  const processor = createDefaultProcessor();
  const schedule = createScheduleProcessor(db);
  const intervalMs = Number(process.env.WORKER_POLL_MS ?? 5_000);
  const maxRetries = Number(process.env.WORKER_MAX_RETRIES ?? 3);
  const retryDelayMs = Number(process.env.WORKER_RETRY_DELAY_MS ?? 1_000);

  console.log(
    JSON.stringify({
      service: "chaste-worker",
      status: "starting",
      region: cfg.region,
      pollMs: intervalMs,
      registeredHandlers: processor.registeredTypes(),
    }),
  );

  async function tick() {
    // C2/C5 — fire due reminders and claim due follow-ups before draining the
    // outbox, so the resulting notifications/events land in the same poll cycle.
    try {
      const fired = await schedule.processDueReminders();
      if (fired > 0) {
        console.log(JSON.stringify({ service: "chaste-worker", action: "reminders_fired", count: fired }));
      }
      const dueFollowUps = await schedule.claimDueFollowUps();
      for (const f of dueFollowUps) {
        // C5 — re-enter the agent harness. The goal is surfaced as a system
        // turn for the user's session; harness wiring is driven by the worker's
        // caller (today: log + outbox note; orchestrator re-entry lands with the
        // Postgres-backed session/inbox swap).
        console.log(
          JSON.stringify({
            service: "chaste-worker",
            action: "followup_due",
            followUpId: f.id,
            orgId: f.organizationId,
            userId: f.userId,
            goal: f.goal,
            sessionId: f.sessionId,
          }),
        );
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          service: "chaste-worker",
          action: "schedule_error",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }

    const batch = await outbox.listUnprocessed(50);
    for (const event of batch) {
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await processor.process({
            id: event.id,
            type: event.type,
            organizationId: event.organizationId,
            occurredAt: event.occurredAt.toISOString(),
            payload: event.payload,
            correlationId: event.correlationId ?? undefined,
            causationId: event.causationId ?? undefined,
          });
          lastError = null;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
          }
        }
      }

      if (lastError) {
        console.error(
          JSON.stringify({
            service: "chaste-worker",
            action: "event_failed",
            eventId: event.id,
            type: event.type,
            orgId: event.organizationId,
            error: lastError.message,
            retriesExhausted: true,
          }),
        );
      }

      // Always mark processed — failed events are logged, not re-queued.
      // For production: add a dead-letter queue or error_count column.
      await outbox.markProcessed(event.id);
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

  console.log(JSON.stringify({ service: "chaste-worker", status: "stopped" }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
