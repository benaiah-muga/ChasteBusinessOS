CREATE TABLE "action_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"intent_key" text NOT NULL,
	"capability_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"ok" boolean NOT NULL,
	"outcome" text NOT NULL,
	"data" jsonb,
	"error" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "action_receipts" ADD CONSTRAINT "action_receipts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE RESTRICT;--> statement-breakpoint
CREATE UNIQUE INDEX "action_receipt_org_intent_idx" ON "action_receipts" USING btree ("org_id","intent_key");--> statement-breakpoint
ALTER TABLE "action_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "action_receipts"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
