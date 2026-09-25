CREATE TABLE IF NOT EXISTS "authored_doc_versions" (
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
CREATE TABLE IF NOT EXISTS "authored_docs" (
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
CREATE TABLE IF NOT EXISTS "doc_drafts" (
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
CREATE TABLE IF NOT EXISTS "doc_presence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"color" text DEFAULT '#b45309' NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "doc_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"content_json" jsonb NOT NULL,
	"placeholders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_system" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "module_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"module" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "org_branding" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"logo_data_url" text,
	"accent_color" text,
	"invoice_footer" text,
	"layout" text DEFAULT 'classic' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_settings" ALTER COLUMN "greeting" SET DEFAULT 'Hi - ask us anything and we''ll get right back to you.';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "notes" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'goods' NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD COLUMN IF NOT EXISTS "session_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authored_doc_versions_org_id_organizations_id_fk' AND conrelid = '"public"."authored_doc_versions"'::regclass) THEN ALTER TABLE "authored_doc_versions" ADD CONSTRAINT "authored_doc_versions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authored_doc_versions_document_id_authored_docs_id_fk' AND conrelid = '"public"."authored_doc_versions"'::regclass) THEN ALTER TABLE "authored_doc_versions" ADD CONSTRAINT "authored_doc_versions_document_id_authored_docs_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."authored_docs"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'authored_docs_org_id_organizations_id_fk' AND conrelid = '"public"."authored_docs"'::regclass) THEN ALTER TABLE "authored_docs" ADD CONSTRAINT "authored_docs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'doc_drafts_org_id_organizations_id_fk' AND conrelid = '"public"."doc_drafts"'::regclass) THEN ALTER TABLE "doc_drafts" ADD CONSTRAINT "doc_drafts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'doc_drafts_document_id_authored_docs_id_fk' AND conrelid = '"public"."doc_drafts"'::regclass) THEN ALTER TABLE "doc_drafts" ADD CONSTRAINT "doc_drafts_document_id_authored_docs_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."authored_docs"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'doc_presence_org_id_organizations_id_fk' AND conrelid = '"public"."doc_presence"'::regclass) THEN ALTER TABLE "doc_presence" ADD CONSTRAINT "doc_presence_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'doc_presence_document_id_authored_docs_id_fk' AND conrelid = '"public"."doc_presence"'::regclass) THEN ALTER TABLE "doc_presence" ADD CONSTRAINT "doc_presence_document_id_authored_docs_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."authored_docs"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'doc_templates_org_id_organizations_id_fk' AND conrelid = '"public"."doc_templates"'::regclass) THEN ALTER TABLE "doc_templates" ADD CONSTRAINT "doc_templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'module_settings_org_id_organizations_id_fk' AND conrelid = '"public"."module_settings"'::regclass) THEN ALTER TABLE "module_settings" ADD CONSTRAINT "module_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_branding_org_id_organizations_id_fk' AND conrelid = '"public"."org_branding"'::regclass) THEN ALTER TABLE "org_branding" ADD CONSTRAINT "org_branding_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "authored_doc_version_idx" ON "authored_doc_versions" USING btree ("document_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authored_doc_org_idx" ON "authored_docs" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "doc_draft_doc_idx" ON "doc_drafts" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "doc_presence_doc_user_idx" ON "doc_presence" USING btree ("document_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "doc_template_org_idx" ON "doc_templates" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "module_settings_org_module_idx" ON "module_settings" USING btree ("org_id","module");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_branding_org_idx" ON "org_branding" USING btree ("org_id");--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_owner_user_id_users_id_fk' AND conrelid = '"public"."customers"'::regclass) THEN ALTER TABLE "customers" ADD CONSTRAINT "customers_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_events_session_id_agent_sessions_id_fk' AND conrelid = '"public"."ledger_events"'::regclass) THEN ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_session_id_agent_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE set null ON UPDATE no action; END IF; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_org_owner_idx" ON "customers" USING btree ("org_id","owner_user_id");