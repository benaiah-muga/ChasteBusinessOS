CREATE TABLE "goods_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "po_id" uuid NOT NULL,
  "number" integer NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "received_by_actor_type" text NOT NULL,
  "received_by_actor_id" uuid,
  "note" text
);
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_po_id_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "purchase_orders"("id") ON DELETE cascade;
--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_org_number_idx" ON "goods_receipts" USING btree ("org_id","number");
--> statement-breakpoint
CREATE INDEX "goods_receipt_po_idx" ON "goods_receipts" USING btree ("org_id","po_id");
--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "receipt_id" uuid NOT NULL,
  "po_line_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "accepted_thousandths" integer NOT NULL,
  "rejected_thousandths" integer NOT NULL DEFAULT 0,
  "returned_thousandths" integer NOT NULL DEFAULT 0,
  "rejection_note" text
);
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "goods_receipts"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_po_line_id_po_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "po_lines"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX "goods_receipt_line_receipt_idx" ON "goods_receipt_lines" USING btree ("org_id","receipt_id");
--> statement-breakpoint
CREATE INDEX "goods_receipt_line_po_line_idx" ON "goods_receipt_lines" USING btree ("org_id","po_line_id");
--> statement-breakpoint
ALTER TABLE "po_lines" ADD COLUMN "position" integer;
--> statement-breakpoint
-- Stable display positions: line 1 of an order is line 1 forever, whatever
-- the storage order of rows does. Backfill preserves the existing id order,
-- which is what every consumer assumed before positions existed.
UPDATE "po_lines" SET "position" = r.rn
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "po_id" ORDER BY "id") AS rn FROM "po_lines"
) r
WHERE "po_lines"."id" = r."id";
--> statement-breakpoint
ALTER TABLE "po_lines" ALTER COLUMN "position" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "po_line_po_position_idx" ON "po_lines" USING btree ("po_id","position");
--> statement-breakpoint

-- Tenant isolation matches the house shape: org rows are invisible and
-- unwritable unless the transaction declared its org context.
ALTER TABLE "goods_receipts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "goods_receipts";
CREATE POLICY "tenant_isolation" ON "goods_receipts"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "goods_receipt_lines";
CREATE POLICY "tenant_isolation" ON "goods_receipt_lines"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
