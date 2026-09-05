ALTER TABLE "invoices" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "credited_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "credited_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "payment_term_days" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "reminder_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "payment_term_days" integer;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "promised_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD COLUMN "backordered" boolean DEFAULT false NOT NULL;
