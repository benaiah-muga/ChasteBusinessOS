ALTER TABLE "ledger_events" ADD COLUMN "session_id" uuid REFERENCES "agent_sessions"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- Attribution metadata for agent actions: which replayable session produced
-- the event. Deliberately NOT part of the hash chain input (computeEntryHash):
-- existing entries stay verifiable, and a session pointer is context, not
-- tamper-evident content. The chain still covers actor, kind, capability,
-- payload, and time.
CREATE INDEX IF NOT EXISTS "ledger_session_idx" ON "ledger_events" ("session_id");
