CREATE TABLE "marketing_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"outbox_id" uuid NOT NULL,
	"email_snapshot" text NOT NULL,
	"content_digest" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "marketing_deliveries" ADD CONSTRAINT "marketing_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_deliveries" ADD CONSTRAINT "marketing_deliveries_campaign_id_marketing_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."marketing_campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_deliveries" ADD CONSTRAINT "marketing_deliveries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketing_deliveries" ADD CONSTRAINT "marketing_deliveries_outbox_id_outbox_messages_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."outbox_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_delivery_campaign_customer_idx" ON "marketing_deliveries" USING btree ("campaign_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "marketing_delivery_outbox_idx" ON "marketing_deliveries" USING btree ("outbox_id");--> statement-breakpoint
CREATE INDEX "marketing_delivery_org_idx" ON "marketing_deliveries" USING btree ("org_id","queued_at");--> statement-breakpoint
ALTER TABLE "marketing_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "marketing_deliveries"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
