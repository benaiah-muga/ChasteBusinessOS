CREATE TABLE "agent_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "session_id" uuid,
  "goal" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "contract_revision" integer DEFAULT 1 NOT NULL,
  "registry_version" text NOT NULL,
  "model_ref" text,
  "current_step" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "initiated_by_actor_type" text NOT NULL,
  "initiated_by_actor_id" uuid,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "step_index" integer NOT NULL,
  "kind" text DEFAULT 'capability' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "capability_id" text,
  "capability_version" text,
  "input_hash" text,
  "input" jsonb,
  "output" jsonb,
  "receipt_id" uuid,
  "approval_id" uuid,
  "error" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_receipt_id_action_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."action_receipts"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_run_steps" ADD CONSTRAINT "agent_run_steps_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_step_unique_idx" ON "agent_run_steps" USING btree ("run_id", "step_index");
--> statement-breakpoint
CREATE INDEX "agent_run_step_org_idx" ON "agent_run_steps" USING btree ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX "agent_run_org_status_idx" ON "agent_runs" USING btree ("org_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "agent_run_session_idx" ON "agent_runs" USING btree ("session_id");
--> statement-breakpoint
ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_runs"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "agent_run_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_run_steps"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
