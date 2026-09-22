-- Phase 4: authored documents - rich text the org writes itself, with an
-- append-only published history, ephemeral autosave drafts and presence
-- written OUTSIDE the ledger (ADR 0056), and parameterized templates.

CREATE TABLE "authored_docs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "title" text NOT NULL,
  "content_json" jsonb NOT NULL,
  "html" text DEFAULT '' NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "template_id" uuid,
  "total_minor" integer,
  "currency" text,
  "created_by_actor_type" text NOT NULL,
  "created_by_actor_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authored_docs" ADD CONSTRAINT "authored_docs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "authored_doc_org_idx" ON "authored_docs" USING btree ("org_id","status");
--> statement-breakpoint

CREATE TABLE "authored_doc_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "content_json" jsonb NOT NULL,
  "html" text NOT NULL,
  "note" text,
  "created_by_actor_type" text NOT NULL,
  "created_by_actor_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "authored_doc_versions" ADD CONSTRAINT "authored_doc_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "authored_doc_versions" ADD CONSTRAINT "authored_doc_versions_document_id_authored_docs_id_fk" FOREIGN KEY ("document_id") REFERENCES "authored_docs"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "authored_doc_version_idx" ON "authored_doc_versions" USING btree ("document_id","version");
--> statement-breakpoint

CREATE TABLE "doc_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "content_json" jsonb NOT NULL,
  "rev" integer DEFAULT 1 NOT NULL,
  "locked_by_user_id" uuid,
  "locked_by_name" text,
  "lock_until" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_drafts" ADD CONSTRAINT "doc_drafts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "doc_drafts" ADD CONSTRAINT "doc_drafts_document_id_authored_docs_id_fk" FOREIGN KEY ("document_id") REFERENCES "authored_docs"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "doc_draft_doc_idx" ON "doc_drafts" USING btree ("document_id");
--> statement-breakpoint

CREATE TABLE "doc_presence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "display_name" text NOT NULL,
  "color" text DEFAULT '#b45309' NOT NULL,
  "seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_presence" ADD CONSTRAINT "doc_presence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "doc_presence" ADD CONSTRAINT "doc_presence_document_id_authored_docs_id_fk" FOREIGN KEY ("document_id") REFERENCES "authored_docs"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "doc_presence_doc_user_idx" ON "doc_presence" USING btree ("document_id","user_id");
--> statement-breakpoint

CREATE TABLE "doc_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "content_json" jsonb NOT NULL,
  "placeholders" jsonb DEFAULT '[]' NOT NULL,
  "is_system" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doc_templates" ADD CONSTRAINT "doc_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "doc_template_org_idx" ON "doc_templates" USING btree ("org_id");
--> statement-breakpoint

-- Tenant isolation on every new table (same policy shape as ai_settings).
ALTER TABLE "authored_docs" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "authored_docs";
CREATE POLICY "tenant_isolation" ON "authored_docs"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
--> statement-breakpoint
ALTER TABLE "authored_doc_versions" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "authored_doc_versions";
CREATE POLICY "tenant_isolation" ON "authored_doc_versions"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
--> statement-breakpoint
ALTER TABLE "doc_drafts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "doc_drafts";
CREATE POLICY "tenant_isolation" ON "doc_drafts"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
--> statement-breakpoint
ALTER TABLE "doc_presence" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "doc_presence";
CREATE POLICY "tenant_isolation" ON "doc_presence"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
--> statement-breakpoint
ALTER TABLE "doc_templates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "doc_templates";
CREATE POLICY "tenant_isolation" ON "doc_templates"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
