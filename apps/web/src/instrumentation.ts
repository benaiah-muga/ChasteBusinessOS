// Runs once per server instance, before the app accepts requests
// (Next.js instrumentation hook). Migrating at boot removes the classic
// self-hosted failure mode: new code serving against an old schema because
// the operator forgot `turbo db:migrate`. Idempotent by construction.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.AUTO_MIGRATE_ON_BOOT === "0") return;

  try {
    const { runMigrations } = await import("@chaste/db/migrate");
    const result = await runMigrations();
    console.log("[boot] database schema up to date");
    if (result.backupSkippedReason) console.warn(`[boot] ${result.backupSkippedReason}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Production refuses to serve on an unmigrated/unreachable database:
    // half-migrated schemas corrupt accounting data silently. Development
    // stays usable when Postgres is simply not running yet.
    if (process.env.NODE_ENV === "production") throw new Error(`boot migration failed: ${message}`);
    console.error(`[boot] migration skipped: ${message}`);
  }
}
