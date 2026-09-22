CREATE TABLE "harness_compositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"profile_id" text NOT NULL,
	"profile_version" text NOT NULL,
	"environment" text NOT NULL,
	"profile_digest" text NOT NULL,
	"composition_digest" text NOT NULL,
	"profile" jsonb NOT NULL,
	"bundles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"patches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "harness_composition_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "harness_profile_id" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "harness_profile_version" text;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "harness_composition_digest" text;--> statement-breakpoint
ALTER TABLE "harness_compositions" ADD CONSTRAINT "harness_compositions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "harness_composition_org_digest_idx" ON "harness_compositions" USING btree ("org_id","composition_digest");--> statement-breakpoint
CREATE INDEX "harness_composition_org_idx" ON "harness_compositions" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_harness_composition_id_harness_compositions_id_fk" FOREIGN KEY ("harness_composition_id") REFERENCES "public"."harness_compositions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "harness_compositions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "harness_compositions"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
