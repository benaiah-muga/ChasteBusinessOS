CREATE TABLE "document_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity_thousandths" integer DEFAULT 1000 NOT NULL,
	"unit_price_minor" integer DEFAULT 0 NOT NULL,
	"suggested_account_code" text NOT NULL,
	"match_score" integer DEFAULT 0 NOT NULL,
	"matched_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"title" text NOT NULL,
	"source_type" text NOT NULL,
	"mime_type" text,
	"size_bytes" integer,
	"content_base64" text,
	"raw_text" text,
	"parsed_markdown" text,
	"parse_error" text,
	"status" text DEFAULT 'received' NOT NULL,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_suggestions" ADD CONSTRAINT "document_suggestions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_suggestion_doc_idx" ON "document_suggestions" USING btree ("document_id","status");--> statement-breakpoint
CREATE INDEX "document_org_status_idx" ON "documents" USING btree ("org_id","status");