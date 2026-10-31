ALTER TABLE "ledger_events" ADD COLUMN "auth_session_id" text;
--> statement-breakpoint
ALTER TABLE "ledger_events"
  ADD CONSTRAINT "ledger_events_auth_session_id_check"
  CHECK ("auth_session_id" IS NULL OR length("auth_session_id") BETWEEN 1 AND 200);
