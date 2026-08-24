CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"created_by_actor_type" text DEFAULT 'system' NOT NULL,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_status_idx" ON "jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "job_org_idx" ON "jobs" USING btree ("org_id");
-- Tenant isolation for the jobs queue, matching the 0014 pattern.
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "jobs";
CREATE POLICY "tenant_isolation" ON "jobs" USING (
	"org_id" = current_setting('app.org_id', true)::uuid
) WITH CHECK (
	"org_id" = current_setting('app.org_id', true)::uuid
);
