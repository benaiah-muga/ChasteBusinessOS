-- The createdAt() helper hardcodes the column name "created_at"; four
-- non-createdAt fields were accidentally mapped onto it, so drizzle emitted
-- duplicate columns in inserts (fx_rates broke recordFxRate). Rename them to
-- real column names. Tables without a separate created_at property get a
-- rename; fx_rates keeps its created_at and gains effective_at.
ALTER TABLE "user_roles" RENAME COLUMN "created_at" TO "assigned_at";--> statement-breakpoint
ALTER TABLE "pos_sessions" RENAME COLUMN "created_at" TO "opened_at";--> statement-breakpoint
ALTER TABLE "conversation_members" RENAME COLUMN "created_at" TO "joined_at";--> statement-breakpoint
ALTER TABLE "fx_rates" ADD COLUMN "effective_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "fx_rates" SET "effective_at" = "created_at";
