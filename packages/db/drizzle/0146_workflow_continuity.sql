ALTER TABLE "invoices" ADD COLUMN "sales_order_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "converted_order_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "quote_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_converted_order_id_sales_orders_id_fk" FOREIGN KEY ("converted_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE set null ON UPDATE no action;
