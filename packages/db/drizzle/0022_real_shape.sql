DROP INDEX "fx_rate_org_pair_idx";--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "data_region" text;--> statement-breakpoint
CREATE INDEX "fx_rate_org_pair_idx" ON "fx_rates" USING btree ("org_id","base","quote","effective_at");