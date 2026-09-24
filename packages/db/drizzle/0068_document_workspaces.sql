CREATE TABLE "doc_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"path" text NOT NULL,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authored_doc_versions" ADD COLUMN "page_settings" jsonb DEFAULT '{"size":"A4","orientation":"portrait","margin":"normal"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "authored_docs" ADD COLUMN "document_type" text;--> statement-breakpoint
ALTER TABLE "authored_docs" ADD COLUMN "linked_record_type" text;--> statement-breakpoint
ALTER TABLE "authored_docs" ADD COLUMN "linked_record_id" uuid;--> statement-breakpoint
ALTER TABLE "authored_docs" ADD COLUMN "linked_record_label" text;--> statement-breakpoint
ALTER TABLE "authored_docs" ADD COLUMN "page_settings" jsonb DEFAULT '{"size":"A4","orientation":"portrait","margin":"normal"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_drafts" ADD COLUMN "page_settings" jsonb DEFAULT '{"size":"A4","orientation":"portrait","margin":"normal"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_folders" ADD CONSTRAINT "doc_folders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "doc_folder_org_path_idx" ON "doc_folders" USING btree ("org_id","path");--> statement-breakpoint
ALTER TABLE "doc_folders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_isolation" ON "doc_folders";--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "doc_folders"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
