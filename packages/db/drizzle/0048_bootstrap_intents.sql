-- B01/T08: bootstrap intent receipts. One row per tenant-creation attempt,
-- written in the same transaction as the organization itself, keyed by
-- (user_id, intent_id). A wizard retry after a lost response replays the
-- receipt instead of creating a second org; a conflicting reuse of the same
-- intent id is refused by the unique pair plus payload hash comparison in
-- the service. RLS mirrors the tenant_isolation shape: pre-org rows carry a
-- NULL org_id and are invisible to the runtime role, which is correct -
-- there is no tenant to isolate yet, and the server path reads receipts as
-- the owner role.
CREATE TABLE "bootstrap_intents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "intent_id" text NOT NULL,
  "payload_hash" text NOT NULL,
  "org_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "bootstrap_intents" ADD CONSTRAINT "bootstrap_intents_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;
ALTER TABLE "bootstrap_intents" ADD CONSTRAINT "bootstrap_intents_org_id_organizations_id_fk"
  FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE SET NULL;
CREATE UNIQUE INDEX "bootstrap_intents_user_intent_uq" ON "bootstrap_intents"
  USING btree ("user_id", "intent_id");
ALTER TABLE "bootstrap_intents" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "bootstrap_intents";
CREATE POLICY "tenant_isolation" ON "bootstrap_intents"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
