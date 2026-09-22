CREATE TABLE "module_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "module" text NOT NULL,
  "settings" jsonb NOT NULL DEFAULT '{}',
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "module_settings" ADD CONSTRAINT "module_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "module_settings_org_module_idx" ON "module_settings" USING btree ("org_id","module");
--> statement-breakpoint

-- One row per org per module: tenant isolation matches the house shape.
ALTER TABLE "module_settings" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "module_settings";
CREATE POLICY "tenant_isolation" ON "module_settings"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
--> statement-breakpoint

-- Policies get a real identity for upsert: one blanket rule per org.
DELETE FROM "policies" p
USING "policies" q
WHERE p."org_id" = q."org_id"
  AND p."capability_pattern" = q."capability_pattern"
  AND p."id" > q."id";
ALTER TABLE "policies" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "policies";
CREATE POLICY "tenant_isolation" ON "policies"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
CREATE UNIQUE INDEX "policies_org_pattern_idx" ON "policies" USING btree ("org_id","capability_pattern");
