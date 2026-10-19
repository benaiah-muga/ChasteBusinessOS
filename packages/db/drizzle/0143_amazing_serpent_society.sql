CREATE TABLE "rfq_quote_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"rfq_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"quantity_thousandths" bigint NOT NULL,
	"unit_price_minor" bigint NOT NULL,
	"sku" text,
	CONSTRAINT "rfq_quote_line_quantity_positive" CHECK ("rfq_quote_lines"."quantity_thousandths" > 0),
	CONSTRAINT "rfq_quote_line_price_nonnegative" CHECK ("rfq_quote_lines"."unit_price_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "rfq_quote_lines" ADD CONSTRAINT "rfq_quote_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfq_quote_lines" ADD CONSTRAINT "rfq_quote_lines_rfq_id_rfqs_id_fk" FOREIGN KEY ("rfq_id") REFERENCES "public"."rfqs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rfq_quote_line_position_idx" ON "rfq_quote_lines" USING btree ("rfq_id","position");--> statement-breakpoint
CREATE INDEX "rfq_quote_line_org_idx" ON "rfq_quote_lines" USING btree ("org_id","rfq_id");--> statement-breakpoint
ALTER TABLE "rfq_quote_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "rfq_quote_lines" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
