CREATE TABLE "creator_evolution_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"candidate_digest" text NOT NULL,
	"artifact_ref" text NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"staged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"promoted_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creator_evolution_releases" ADD CONSTRAINT "creator_evolution_releases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_evolution_releases" ADD CONSTRAINT "creator_evolution_releases_proposal_id_creator_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."creator_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creator_evolution_org_status_idx" ON "creator_evolution_releases" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "creator_evolution_proposal_idx" ON "creator_evolution_releases" USING btree ("org_id","proposal_id","candidate_digest");
--> statement-breakpoint
ALTER TABLE "creator_evolution_releases" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "creator_evolution_releases"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
