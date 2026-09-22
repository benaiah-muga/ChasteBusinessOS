CREATE TABLE "ai_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "provider" text NOT NULL DEFAULT 'nim',
  "encrypted_api_key" text,
  "key_last4" text,
  "base_url" text,
  "model_routing" jsonb NOT NULL DEFAULT '{}',
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_settings_org_idx" ON "ai_settings" USING btree ("org_id");
--> statement-breakpoint

ALTER TABLE "ai_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "ai_settings";
CREATE POLICY "tenant_isolation" ON "ai_settings"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
