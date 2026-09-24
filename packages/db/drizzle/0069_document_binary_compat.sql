ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "content_base64" text;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN IF NOT EXISTS "content_base64" text;
