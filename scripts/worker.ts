import { getDb } from "@chaste/db";
import { logger } from "@chaste/kernel";
import { processOneJob } from "./apps/web/src/server/jobs";

/**
 * Background worker: drains the capability-job queue.
 * Run with `pnpm worker`.
 */

const POLL_INTERVAL_MS = 2_000;

async function main(): Promise<void> {
  const db = getDb().db;
  logger.info("worker started", { pollIntervalMs: POLL_INTERVAL_MS });
  let running = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info("worker shutting down");
      running = false;
    });
  }
  while (running) {
    try {
      const worked = await processOneJob(db, logger);
      if (!worked) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    } catch (err) {
      logger.error("worker loop error", { error: err instanceof Error ? err.message : String(err) });
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

void main();
