ALTER TABLE "customers" ADD COLUMN "merged_into_customer_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_merged_into_customer_id_customers_id_fk" FOREIGN KEY ("merged_into_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_org_merge_idx" ON "customers" USING btree ("org_id","merged_into_customer_id");