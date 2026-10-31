ALTER TABLE "quotes" ADD COLUMN "deal_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_deal_id_deals_id_fk" FOREIGN KEY ("deal_id") REFERENCES "public"."deals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_org_deal_idx" ON "quotes" USING btree ("org_id","deal_id");