import { runMigrations } from "@chaste/db/migrate";

export async function registerNodeRuntime(): Promise<void> {
  try {
    const result = await runMigrations();
    console.info("[boot] database schema up to date");
    if (result.backupSkippedReason) console.warn(`[boot] ${result.backupSkippedReason}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (process.env.NODE_ENV === "production") throw new Error(`boot migration failed: ${message}`);
    console.error(`[boot] migration skipped: ${message}`);
  }
}
