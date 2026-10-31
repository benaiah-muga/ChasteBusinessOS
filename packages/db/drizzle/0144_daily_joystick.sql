CREATE TABLE "operational_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"stable_key" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"authority_ref" text,
	"approval_id" uuid,
	"owner_user_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "operational_record_kind_valid" CHECK ("operational_records"."kind" IN ('objective', 'exception', 'decision')),
	CONSTRAINT "operational_record_revision_positive" CHECK ("operational_records"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "operational_records" ADD CONSTRAINT "operational_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_records" ADD CONSTRAINT "operational_records_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_records" ADD CONSTRAINT "operational_records_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_records" ADD CONSTRAINT "operational_records_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operational_record_key_idx" ON "operational_records" USING btree ("org_id","kind","stable_key");--> statement-breakpoint
CREATE INDEX "operational_record_org_status_idx" ON "operational_records" USING btree ("org_id","kind","status","updated_at");--> statement-breakpoint
ALTER TABLE "operational_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "operational_records" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
