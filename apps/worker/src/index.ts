/**
 * Outbox worker — drains unprocessed domain events.
 * Secrets via env (DATABASE_URL); no elevated business privileges.
 */
import { loadConfig } from "@chaste/config";
import { createDb, PostgresOutboxWriter } from "@chaste/db";

async function main() {
  const cfg = loadConfig();
  const db = createDb(cfg.databaseUrl);
  const outbox = new PostgresOutboxWriter(db);
  const intervalMs = Number(process.env.WORKER_POLL_MS ?? 5_000);

  console.log(
    JSON.stringify({
      service: "chaste-worker",
      status: "starting",
      region: cfg.region,
      pollMs: intervalMs,
    }),
  );

  async function tick() {
    const batch = await outbox.listUnprocessed(50);
    for (const event of batch) {
      // Future: route by event.type to module handlers / webhooks
      console.log(
        JSON.stringify({
          service: "chaste-worker",
          action: "process_outbox",
          type: event.type,
          id: event.id,
          organizationId: event.organizationId,
        }),
      );
      await outbox.markProcessed(event.id);
    }
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error(JSON.stringify({ service: "chaste-worker", error: String(err) }));
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
