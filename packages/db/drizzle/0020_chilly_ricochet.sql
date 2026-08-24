CREATE TABLE "cycle_count_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"count_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"expected_thousandths" integer NOT NULL,
	"counted_thousandths" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"location_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"posted_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_by_actor_type" text,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"lot_code" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity_thousandths" integer NOT NULL,
	"reason" text NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by_actor_type" text,
	"created_by_actor_id" uuid,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"assembly_item_id" uuid NOT NULL,
	"planned_qty_thousandths" integer NOT NULL,
	"produced_qty_thousandths" integer DEFAULT 0 NOT NULL,
	"yield_pct_thousandths" integer DEFAULT 1000000 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"note" text,
	"released_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_by_actor_type" text,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bom_lines" ADD COLUMN "scrap_pct_thousandths" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "lot_id" uuid;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_count_id_cycle_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."cycle_counts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_count_lines" ADD CONSTRAINT "cycle_count_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle_counts" ADD CONSTRAINT "cycle_counts_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lots" ADD CONSTRAINT "lots_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_locations" ADD CONSTRAINT "stock_locations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_assembly_item_id_items_id_fk" FOREIGN KEY ("assembly_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cycle_count_line_unique_idx" ON "cycle_count_lines" USING btree ("count_id","item_id");--> statement-breakpoint
CREATE INDEX "cycle_count_org_status_idx" ON "cycle_counts" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "lot_org_item_code_idx" ON "lots" USING btree ("org_id","item_id","lot_code");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_location_org_code_idx" ON "stock_locations" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "stock_reservation_org_item_status_idx" ON "stock_reservations" USING btree ("org_id","item_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "work_order_org_number_idx" ON "work_orders" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "work_order_org_status_idx" ON "work_orders" USING btree ("org_id","status");--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_location_id_stock_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."stock_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_lot_id_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."lots"("id") ON DELETE set null ON UPDATE no action;
-- Tenant isolation for manufacturing tables (0014 pattern)
ALTER TABLE "stock_locations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "stock_locations";
CREATE POLICY "tenant_isolation" ON "stock_locations" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE "lots" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "lots";
CREATE POLICY "tenant_isolation" ON "lots" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE "work_orders" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "work_orders";
CREATE POLICY "tenant_isolation" ON "work_orders" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE "stock_reservations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "stock_reservations";
CREATE POLICY "tenant_isolation" ON "stock_reservations" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE "cycle_counts" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "cycle_counts";
CREATE POLICY "tenant_isolation" ON "cycle_counts" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
ALTER TABLE "cycle_count_lines" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "cycle_count_lines";
CREATE POLICY "tenant_isolation" ON "cycle_count_lines" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint

-- RLS tenant isolation for the new manufacturing tables (same policy shape
-- as 0014): every one carries org_id directly, so a single tenant_isolation
-- policy keyed on app.org_id covers reads and writes.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'stock_locations', 'lots', 'work_orders',
    'stock_reservations', 'cycle_counts', 'cycle_count_lines'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'tenant_isolation', t);
    EXECUTE format(
      $f$
      CREATE POLICY tenant_isolation ON %I
        USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
        WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid)
      $f$, t, t);
  END LOOP;
END $$;