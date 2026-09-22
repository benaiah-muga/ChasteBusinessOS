ALTER TABLE "jobs" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "run_step_index" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "approved_approval_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_approved_approval_id_approvals_id_fk" FOREIGN KEY ("approved_approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_run_idx" ON "jobs" USING btree ("run_id","run_step_index");