-- Recoverable queue leases and one idempotent occurrence per recurring invoice tick.
ALTER TABLE "jobs" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "fencing_token" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "job_available_idx" ON "jobs" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE TABLE "recurring_invoice_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"recurring_invoice_id" uuid NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"invoice_id" uuid,
	"status" text DEFAULT 'completed' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "recurring_invoice_runs" ADD CONSTRAINT "recurring_invoice_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_runs" ADD CONSTRAINT "recurring_runs_template_fk" FOREIGN KEY ("recurring_invoice_id") REFERENCES "public"."recurring_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_runs" ADD CONSTRAINT "recurring_invoice_runs_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_invoice_run_occurrence_idx" ON "recurring_invoice_runs" USING btree ("org_id","recurring_invoice_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "recurring_invoice_run_org_idx" ON "recurring_invoice_runs" USING btree ("org_id","created_at");--> statement-breakpoint
ALTER TABLE "recurring_invoice_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "recurring_invoice_runs"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);
