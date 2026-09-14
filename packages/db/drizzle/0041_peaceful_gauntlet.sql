CREATE TABLE "routine_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"job_id" uuid,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routine_occurrences" ADD CONSTRAINT "routine_occurrences_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_occurrences" ADD CONSTRAINT "routine_occurrences_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_occurrences" ADD CONSTRAINT "routine_occurrences_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "routine_occurrence_unique_idx" ON "routine_occurrences" USING btree ("routine_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "routine_occurrence_org_idx" ON "routine_occurrences" USING btree ("org_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "routine_occurrence_job_idx" ON "routine_occurrences" USING btree ("job_id");--> statement-breakpoint
ALTER TABLE "routine_occurrences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "routine_occurrences"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
