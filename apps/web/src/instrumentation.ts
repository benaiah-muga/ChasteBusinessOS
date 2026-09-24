// Runs once per server instance, before the app accepts requests
// (Next.js instrumentation hook). Migrating at boot removes the classic
// self-hosted failure mode: new code serving against an old schema because
// the operator forgot `turbo db:migrate`. Idempotent by construction.
export function register(): void | Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.AUTO_MIGRATE_ON_BOOT === "0") return;
  // Next's instrumentation runtime split requires this Node-only module load.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("./instrumentation.node").registerNodeRuntime();
}
