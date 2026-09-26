ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_quantity_positive" CHECK ("pos_return_lines"."quantity" > 0);--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_subtotal_nonnegative" CHECK ("pos_return_lines"."subtotal_minor" >= 0);--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_tax_nonnegative" CHECK ("pos_return_lines"."tax_minor" >= 0);--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_refund_positive" CHECK ("pos_returns"."refund_minor" > 0);--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_method_valid" CHECK ("pos_returns"."refund_method" in ('cash', 'card', 'mobile_money', 'unknown'));--> statement-breakpoint
ALTER TABLE "pos_returns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "pos_returns" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "pos_return_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "pos_return_lines" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
