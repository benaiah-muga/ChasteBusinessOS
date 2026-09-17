ALTER TABLE "journal_entries" ADD COLUMN "entry_kind" text NOT NULL DEFAULT 'operational';
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "business_at" timestamp with time zone;
--> statement-breakpoint

-- Year-end rolls and their in-year reversals are bookkeeping machinery, not
-- operations: reports exclude them from operating results, and at most one
-- live roll (reversal_of_id null) exists per sealed year. Corrections carry
-- the original business date in business_at while posting into an open
-- period, so a backdated fix never lies about when it landed.
COMMENT ON COLUMN "journal_entries"."entry_kind" IS 'operational | year_end_close | correction';
COMMENT ON COLUMN "journal_entries"."business_at" IS 'original business date this correction reverses activity from';
