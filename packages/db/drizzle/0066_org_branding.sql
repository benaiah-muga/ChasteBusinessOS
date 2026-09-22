-- Phase 4: org print branding for server-rendered invoice/quote layouts.
CREATE TABLE "org_branding" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "logo_data_url" text,
  "accent_color" text,
  "invoice_footer" text,
  "layout" text DEFAULT 'classic' NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_branding" ADD CONSTRAINT "org_branding_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "org_branding_org_idx" ON "org_branding" USING btree ("org_id");
--> statement-breakpoint
ALTER TABLE "org_branding" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "org_branding";
CREATE POLICY "tenant_isolation" ON "org_branding"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
