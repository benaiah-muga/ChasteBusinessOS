CREATE TABLE "stock_balances" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "location_id" uuid,
  "lot_id" uuid,
  "quantity" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE cascade;
--> statement-breakpoint
-- One balance row per (org, item, location, lot); the coalesce keys make
-- "no location" and "no lot" collide like a value, so the unique net holds
-- even though the columns themselves are nullable.
CREATE UNIQUE INDEX "stock_balance_key_idx" ON "stock_balances" (
  "org_id", "item_id",
  coalesce("location_id", '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce("lot_id", '00000000-0000-0000-0000-000000000000'::uuid)
);
--> statement-breakpoint
CREATE INDEX "stock_balance_item_idx" ON "stock_balances" USING btree ("org_id","item_id");
--> statement-breakpoint
-- Backfill: the ledger is the source of truth; the projection replays it.
INSERT INTO "stock_balances" ("org_id", "item_id", "location_id", "lot_id", "quantity")
SELECT "org_id", "item_id", "location_id", "lot_id", sum("quantity_delta")::integer
FROM "stock_movements"
GROUP BY "org_id", "item_id", "location_id", "lot_id";
--> statement-breakpoint
CREATE TABLE "doc_counters" (
  "org_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "next" integer NOT NULL,
  CONSTRAINT "doc_counters_pk" PRIMARY KEY ("org_id","kind")
);
--> statement-breakpoint
ALTER TABLE "doc_counters" ADD CONSTRAINT "doc_counters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE cascade;
--> statement-breakpoint

-- The projection is maintained by the database itself: every ledger insert
-- lands in stock_balances atomically, whatever wrote it, so the read model
-- cannot drift from the ledger except by a bug — and the rebuild replays
-- the ledger to prove it.
CREATE OR REPLACE FUNCTION stock_balances_apply() RETURNS trigger AS $$
BEGIN
  INSERT INTO stock_balances (org_id, item_id, location_id, lot_id, quantity)
  VALUES (NEW.org_id, NEW.item_id, NEW.location_id, NEW.lot_id, NEW.quantity_delta)
  ON CONFLICT (org_id, item_id,
    coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER stock_movements_project_balance
AFTER INSERT ON "stock_movements"
FOR EACH ROW EXECUTE FUNCTION stock_balances_apply();
--> statement-breakpoint

-- Tenant isolation matches the house shape: org rows are invisible and
-- unwritable unless the transaction declared its org context.
ALTER TABLE "stock_balances" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "stock_balances";
CREATE POLICY "tenant_isolation" ON "stock_balances"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
--> statement-breakpoint
ALTER TABLE "doc_counters" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "doc_counters";
CREATE POLICY "tenant_isolation" ON "doc_counters"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
