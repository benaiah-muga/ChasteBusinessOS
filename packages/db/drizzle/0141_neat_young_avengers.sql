CREATE TABLE "evaluation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scenario_id" text NOT NULL,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"final_answer" text DEFAULT '' NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cached_tokens" bigint DEFAULT 0 NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluation_run_status_valid" CHECK ("evaluation_runs"."status" IN ('passed', 'failed', 'error')),
	CONSTRAINT "evaluation_run_duration_nonnegative" CHECK ("evaluation_runs"."duration_ms" >= 0),
	CONSTRAINT "evaluation_run_tokens_nonnegative" CHECK ("evaluation_runs"."input_tokens" >= 0 AND "evaluation_runs"."output_tokens" >= 0 AND "evaluation_runs"."cached_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evaluation_run_org_created_idx" ON "evaluation_runs" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "evaluation_run_org_scenario_idx" ON "evaluation_runs" USING btree ("org_id","scenario_id","created_at");--> statement-breakpoint
ALTER TABLE "evaluation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "evaluation_runs" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
