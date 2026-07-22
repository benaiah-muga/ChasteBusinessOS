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

async function main() {
  const cfg = loadConfig();
  const db = createDb(cfg.databaseUrl);
  const outbox = new PostgresOutboxWriter(db);
  const processor = createDefaultProcessor();
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
