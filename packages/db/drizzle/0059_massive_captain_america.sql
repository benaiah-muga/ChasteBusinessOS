CREATE TABLE "creator_evolution_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"gap_ticket_id" uuid NOT NULL,
	"candidate_digest" text NOT NULL,
	"phase" text DEFAULT 'canary' NOT NULL,
	"verdict" text NOT NULL,
	"evidence_ref" text NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creator_evolution_releases" ADD COLUMN "gap_ticket_id" uuid;--> statement-breakpoint
ALTER TABLE "creator_evolution_outcomes" ADD CONSTRAINT "creator_evolution_outcomes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_evolution_outcomes" ADD CONSTRAINT "creator_evolution_outcomes_release_id_creator_evolution_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."creator_evolution_releases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_evolution_outcomes" ADD CONSTRAINT "creator_evolution_outcomes_gap_ticket_id_tickets_id_fk" FOREIGN KEY ("gap_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "creator_outcome_release_phase_idx" ON "creator_evolution_outcomes" USING btree ("release_id","phase");--> statement-breakpoint
CREATE INDEX "creator_outcome_org_gap_idx" ON "creator_evolution_outcomes" USING btree ("org_id","gap_ticket_id","created_at");--> statement-breakpoint
ALTER TABLE "creator_evolution_releases" ADD CONSTRAINT "creator_evolution_releases_gap_ticket_id_tickets_id_fk" FOREIGN KEY ("gap_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "creator_evolution_outcomes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "creator_evolution_outcomes"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
