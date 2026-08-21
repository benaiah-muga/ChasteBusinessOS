ALTER TABLE "pos_sessions" ALTER COLUMN "expected_cash_minor" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "pos_sessions" ALTER COLUMN "expected_cash_minor" SET NOT NULL;