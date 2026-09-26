CREATE TABLE "pos_return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"quantity" integer NOT NULL,
	"subtotal_minor" integer NOT NULL,
	"tax_minor" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pos_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"refund_method" text NOT NULL,
	"refund_minor" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "item_id" uuid;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_return_id_pos_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."pos_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_return_lines" ADD CONSTRAINT "pos_return_lines_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_returns" ADD CONSTRAINT "pos_returns_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_return_line_unique_idx" ON "pos_return_lines" USING btree ("return_id","invoice_line_id");--> statement-breakpoint
CREATE INDEX "pos_return_line_org_idx" ON "pos_return_lines" USING btree ("org_id","invoice_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pos_return_entry_idx" ON "pos_returns" USING btree ("org_id","entry_id");--> statement-breakpoint
CREATE INDEX "pos_return_org_invoice_idx" ON "pos_returns" USING btree ("org_id","invoice_id");--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;