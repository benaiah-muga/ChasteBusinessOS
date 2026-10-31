ALTER TABLE "approvals" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "supersedes_approval_id" uuid;--> statement-breakpoint
CREATE INDEX "approval_org_capability_requester_idx" ON "approvals" USING btree ("org_id","capability_id","requested_by_user_id","created_at");