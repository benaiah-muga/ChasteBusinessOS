-- Module switchboard: per-org enabled module list (NULL = all standard
-- modules). Enforcement lives in KernelExecutor via the modules gate.
-- Cleans a stray column from an aborted generation while here.
ALTER TABLE "marketplace_listings" DROP COLUMN IF EXISTS "enabled_modules";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "enabled_modules" jsonb;
