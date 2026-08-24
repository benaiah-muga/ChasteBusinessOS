CREATE TABLE "fx_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"rate_num" bigint NOT NULL,
	"rate_den" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"recorded_by_actor_type" text NOT NULL,
	"recorded_by_actor_id" uuid
);
--> statement-breakpoint
CREATE TABLE "fx_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"currency" text NOT NULL,
	"settled_foreign_minor" integer NOT NULL,
	"base_settled_minor" integer NOT NULL,
	"gain_loss_minor" integer NOT NULL,
	"settle_rate_num" bigint NOT NULL,
	"settle_rate_den" integer NOT NULL,
	"base_entry_id" uuid NOT NULL,
	"foreign_entry_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fx_rate_num" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fx_rate_den" integer;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_settlements" ADD CONSTRAINT "fx_settlements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_settlements" ADD CONSTRAINT "fx_settlements_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_settlements" ADD CONSTRAINT "fx_settlements_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fx_rate_org_pair_idx" ON "fx_rates" USING btree ("org_id","base","quote","created_at");--> statement-breakpoint
CREATE INDEX "fx_settlement_org_idx" ON "fx_settlements" USING btree ("org_id","currency");
-- Tenant isolation for FX tables (0014 pattern)
ALTER TABLE "fx_rates" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "fx_rates";
CREATE POLICY "tenant_isolation" ON "fx_rates" USING (
	"org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
) WITH CHECK (
	"org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
);
ALTER TABLE "fx_settlements" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "fx_settlements";
CREATE POLICY "tenant_isolation" ON "fx_settlements" USING (
	"org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
) WITH CHECK (
	"org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
);
