CREATE TABLE "budget_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scenario_id" uuid NOT NULL,
	"month" integer NOT NULL,
	"account_code" text NOT NULL,
	"planned_minor" bigint NOT NULL,
	"note" text,
	CONSTRAINT "budget_line_month_valid" CHECK ("budget_lines"."month" BETWEEN 1 AND 12),
	CONSTRAINT "budget_line_amount_nonnegative" CHECK ("budget_lines"."planned_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budget_scenarios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"scenario_key" text NOT NULL,
	"name" text NOT NULL,
	"fiscal_year" integer NOT NULL,
	"version" integer NOT NULL,
	"currency" text NOT NULL,
	"assumptions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_scenario_version_positive" CHECK ("budget_scenarios"."version" > 0),
	CONSTRAINT "budget_scenario_year_valid" CHECK ("budget_scenarios"."fiscal_year" BETWEEN 2000 AND 2100)
);
--> statement-breakpoint
CREATE TABLE "payment_run_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"payment_run_id" uuid NOT NULL,
	"vendor_bill_id" uuid NOT NULL,
	"vendor_payment_id" uuid,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_run_line_amount_positive" CHECK ("payment_run_lines"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"currency" text NOT NULL,
	"total_minor" bigint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"journal_entry_id" uuid,
	"memo" text,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_id" uuid,
	"instructed_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"reversal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_run_total_positive" CHECK ("payment_runs"."total_minor" > 0),
	CONSTRAINT "payment_run_status_valid" CHECK ("payment_runs"."status" IN ('draft', 'cancelled', 'instructed', 'confirmed', 'reversed'))
);
--> statement-breakpoint
CREATE TABLE "period_close_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"task_key" text NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"note" text,
	"updated_by_actor_type" text NOT NULL,
	"updated_by_actor_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "period_close_year_valid" CHECK ("period_close_checks"."year" BETWEEN 2000 AND 2100),
	CONSTRAINT "period_close_month_valid" CHECK ("period_close_checks"."month" BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE TABLE "period_fx_revaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"month" integer NOT NULL,
	"entry_id" uuid,
	"reversal_entry_id" uuid,
	"total_adjustment_minor" bigint DEFAULT 0 NOT NULL,
	"rate_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	CONSTRAINT "period_fx_revaluation_year_valid" CHECK ("period_fx_revaluations"."year" BETWEEN 2000 AND 2100),
	CONSTRAINT "period_fx_revaluation_month_valid" CHECK ("period_fx_revaluations"."month" BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE TABLE "tax_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"jurisdiction_code" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"direction" text NOT NULL,
	"rate_basis_points" integer NOT NULL,
	"price_includes_tax" boolean DEFAULT false NOT NULL,
	"recoverable" boolean DEFAULT true NOT NULL,
	"liability_account_code" text DEFAULT '2100' NOT NULL,
	"asset_account_code" text DEFAULT '1205' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_code_jurisdiction_format" CHECK ("tax_codes"."jurisdiction_code" ~ '^[A-Z]{2}(-[A-Z0-9]{1,8})?$'),
	CONSTRAINT "tax_code_direction_valid" CHECK ("tax_codes"."direction" IN ('output', 'input')),
	CONSTRAINT "tax_code_rate_nonnegative" CHECK ("tax_codes"."rate_basis_points" BETWEEN 0 AND 1000000)
);
--> statement-breakpoint
CREATE TABLE "tax_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"jurisdiction_code" text NOT NULL,
	"registration_number" text,
	"filing_frequency" text DEFAULT 'monthly' NOT NULL,
	"provider_mode" text DEFAULT 'manual' NOT NULL,
	"provider_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_profile_jurisdiction_format" CHECK ("tax_profiles"."jurisdiction_code" ~ '^[A-Z]{2}(-[A-Z0-9]{1,8})?$'),
	CONSTRAINT "tax_profile_frequency_valid" CHECK ("tax_profiles"."filing_frequency" IN ('monthly', 'quarterly', 'annual')),
	CONSTRAINT "tax_profile_provider_mode_valid" CHECK ("tax_profiles"."provider_mode" IN ('manual', 'connected'))
);
--> statement-breakpoint
CREATE TABLE "tax_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"jurisdiction_code" text NOT NULL,
	"period_from" timestamp with time zone NOT NULL,
	"period_to" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"tax_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_tax_minor" bigint NOT NULL,
	"input_tax_minor" bigint NOT NULL,
	"tax_minor" bigint NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"submission_reference" text,
	"acknowledgment" jsonb,
	"evidence_reference" text,
	"amends_return_id" uuid,
	"settlement_entry_id" uuid,
	"submitted_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_return_window_valid" CHECK ("tax_returns"."period_to" > "tax_returns"."period_from"),
	CONSTRAINT "tax_return_status_valid" CHECK ("tax_returns"."status" IN ('draft', 'submitted', 'unknown', 'accepted', 'rejected', 'amended', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "tax_code_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "tax_rate_basis_points" integer;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "price_includes_tax" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "po_lines" ADD COLUMN "expense_account_code" text DEFAULT '6000' NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_tax_filings" ADD COLUMN "tax_return_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_bill_lines" ADD COLUMN "tax_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_bill_lines" ADD COLUMN "tax_code_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_bill_lines" ADD COLUMN "tax_rate_basis_points" integer;--> statement-breakpoint
ALTER TABLE "vendor_bill_lines" ADD COLUMN "price_includes_tax" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "payment_run_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "status" text DEFAULT 'settled' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "reversal_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_scenario_id_budget_scenarios_id_fk" FOREIGN KEY ("scenario_id") REFERENCES "public"."budget_scenarios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_scenarios" ADD CONSTRAINT "budget_scenarios_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_run_lines" ADD CONSTRAINT "payment_run_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_run_lines" ADD CONSTRAINT "payment_run_lines_payment_run_id_payment_runs_id_fk" FOREIGN KEY ("payment_run_id") REFERENCES "public"."payment_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_run_lines" ADD CONSTRAINT "payment_run_lines_vendor_bill_id_vendor_bills_id_fk" FOREIGN KEY ("vendor_bill_id") REFERENCES "public"."vendor_bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_run_lines" ADD CONSTRAINT "payment_run_lines_vendor_payment_id_vendor_payments_id_fk" FOREIGN KEY ("vendor_payment_id") REFERENCES "public"."vendor_payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_reversal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_close_checks" ADD CONSTRAINT "period_close_checks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_fx_revaluations" ADD CONSTRAINT "period_fx_revaluations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_fx_revaluations" ADD CONSTRAINT "period_fx_revaluations_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "period_fx_revaluations" ADD CONSTRAINT "period_fx_revaluations_reversal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_profiles" ADD CONSTRAINT "tax_profiles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_returns" ADD CONSTRAINT "tax_returns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_returns" ADD CONSTRAINT "tax_returns_amends_return_id_tax_returns_id_fk" FOREIGN KEY ("amends_return_id") REFERENCES "public"."tax_returns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_returns" ADD CONSTRAINT "tax_returns_settlement_entry_id_journal_entries_id_fk" FOREIGN KEY ("settlement_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_line_scenario_period_account_idx" ON "budget_lines" USING btree ("scenario_id","month","account_code");--> statement-breakpoint
CREATE INDEX "budget_line_org_scenario_idx" ON "budget_lines" USING btree ("org_id","scenario_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_scenario_version_idx" ON "budget_scenarios" USING btree ("org_id","scenario_key","version");--> statement-breakpoint
CREATE INDEX "budget_scenario_org_current_idx" ON "budget_scenarios" USING btree ("org_id","fiscal_year","is_current");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_run_bill_idx" ON "payment_run_lines" USING btree ("payment_run_id","vendor_bill_id");--> statement-breakpoint
CREATE INDEX "payment_run_line_org_idx" ON "payment_run_lines" USING btree ("org_id","payment_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_run_org_ref_idx" ON "payment_runs" USING btree ("org_id","reference");--> statement-breakpoint
CREATE INDEX "payment_run_org_status_idx" ON "payment_runs" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "period_close_check_key_idx" ON "period_close_checks" USING btree ("org_id","year","month","task_key");--> statement-breakpoint
CREATE UNIQUE INDEX "period_fx_revaluation_org_month_idx" ON "period_fx_revaluations" USING btree ("org_id","year","month");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_code_org_code_idx" ON "tax_codes" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "tax_code_org_active_idx" ON "tax_codes" USING btree ("org_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_profile_org_idx" ON "tax_profiles" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "tax_return_org_period_idx" ON "tax_returns" USING btree ("org_id","period_from","period_to");--> statement-breakpoint
CREATE INDEX "tax_return_org_status_idx" ON "tax_returns" USING btree ("org_id","status");--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_tax_filings" ADD CONSTRAINT "sales_tax_filings_tax_return_id_tax_returns_id_fk" FOREIGN KEY ("tax_return_id") REFERENCES "public"."tax_returns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bill_lines" ADD CONSTRAINT "vendor_bill_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_payment_run_id_payment_runs_id_fk" FOREIGN KEY ("payment_run_id") REFERENCES "public"."payment_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_tax_filing_return_idx" ON "sales_tax_filings" USING btree ("tax_return_id");--> statement-breakpoint
ALTER TABLE "budget_scenarios" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "budget_scenarios" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "budget_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "budget_lines" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "payment_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_runs" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "payment_run_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "payment_run_lines" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "period_close_checks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "period_close_checks" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "period_fx_revaluations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "period_fx_revaluations" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tax_profiles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tax_profiles" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tax_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tax_codes" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "tax_returns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tax_returns" USING ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid) WITH CHECK ("org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
UPDATE "vendor_bills" AS bill
SET "currency" = org."base_currency"
FROM "organizations" AS org
WHERE bill."org_id" = org."id"
  AND bill."currency" = 'USD'
  AND org."base_currency" <> 'USD';
