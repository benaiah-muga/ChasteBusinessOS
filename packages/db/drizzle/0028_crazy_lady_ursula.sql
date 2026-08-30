CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"schedule_text" text,
	"schedule" jsonb NOT NULL,
	"trigger_type" text DEFAULT 'schedule' NOT NULL,
	"webhook_token" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"created_by_actor_type" text DEFAULT 'user' NOT NULL,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "agent_soul" text;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_due_idx" ON "routines" USING btree ("org_id","enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "routine_webhook_token_idx" ON "routines" USING btree ("webhook_token");
--> statement-breakpoint
ALTER TABLE "routines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "routines" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
-- Postgres-first text search: trigram index accelerates the ILIKE fallback
-- used by documents.searchMemory and support.searchKnowledge when embeddings
-- are unavailable, and enables future similarity ranking without a new service.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX "memory_content_trgm_idx" ON "memories" USING gin ("content" gin_trgm_ops);
