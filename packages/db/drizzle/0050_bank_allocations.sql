-- N14 slice 2: the bank-reconciliation allocation model. A statement line
-- is explained by explicit allocations (payment, entry, reviewed fee, FX
-- difference) that share the line's sign and fit inside its amount; a
-- statement period is reconciled when the unexplained difference is zero.
-- Existing single-claim matches backfill as full-amount allocations, then
-- the claim columns and their unique indexes retire.

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "bank_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payment_id" uuid,
	"entry_id" uuid,
	"amount_minor" bigint NOT NULL,
	"note" text,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "bank_allocations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "bank_allocations_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "bank_allocations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action
);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "bank_allocation_tx_idx" ON "bank_allocations" USING btree ("org_id","transaction_id");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "bank_allocation_payment_idx" ON "bank_allocations" USING btree ("org_id","payment_id");

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "bank_allocation_entry_idx" ON "bank_allocations" USING btree ("org_id","entry_id");

--> statement-breakpoint

-- Tenant isolation matches the house shape: org rows are invisible and
-- unwritable unless the transaction declared its org context.
ALTER TABLE "bank_allocations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "bank_allocations";
CREATE POLICY "tenant_isolation" ON "bank_allocations"
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid);

--> statement-breakpoint

-- Backfill: every existing claim matched the full line exactly, so it
-- becomes one full-amount allocation of the matching kind.
INSERT INTO "bank_allocations" ("org_id", "transaction_id", "kind", "payment_id", "entry_id", "amount_minor")
SELECT "org_id", "id",
       CASE WHEN "matched_payment_id" IS NOT NULL THEN 'payment' ELSE 'entry' END,
       "matched_payment_id", "matched_entry_id", "amount_minor"
FROM "bank_transactions"
WHERE "status" = 'matched';

--> statement-breakpoint

DROP INDEX IF EXISTS "bank_tx_payment_claim_idx";

--> statement-breakpoint

DROP INDEX IF EXISTS "bank_tx_entry_claim_idx";

--> statement-breakpoint

ALTER TABLE "bank_transactions" DROP COLUMN IF EXISTS "matched_payment_id";

--> statement-breakpoint

ALTER TABLE "bank_transactions" DROP COLUMN IF EXISTS "matched_entry_id";
