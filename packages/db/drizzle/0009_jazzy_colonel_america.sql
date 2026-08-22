CREATE TABLE "creator_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"diff_text" text NOT NULL,
	"test_evidence" text,
	"risk_assessment" text,
	"status" text DEFAULT 'in_review' NOT NULL,
	"session_id" uuid,
	"proposed_by_actor_type" text NOT NULL,
	"proposed_by_actor_id" uuid,
	"reviewed_by_user_id" uuid,
	"review_comment" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creator_proposals" ADD CONSTRAINT "creator_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_proposals" ADD CONSTRAINT "creator_proposals_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creator_proposals" ADD CONSTRAINT "creator_proposals_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creator_proposal_org_status_idx" ON "creator_proposals" USING btree ("org_id","status");