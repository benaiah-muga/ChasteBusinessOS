ALTER TABLE "vendor_bill_lines" ADD COLUMN "po_line_id" uuid;--> statement-breakpoint
CREATE INDEX "vendor_bill_line_poline_idx" ON "vendor_bill_lines" USING btree ("po_line_id");