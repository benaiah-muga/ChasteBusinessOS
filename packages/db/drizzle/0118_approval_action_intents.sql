ALTER TABLE "approvals"
  ADD COLUMN "intent_id" text,
  ADD COLUMN "input_hash" text;
--> statement-breakpoint
ALTER TABLE "approvals"
  ADD CONSTRAINT "approval_intent_digest_pair_check"
  CHECK (("intent_id" IS NULL) = ("input_hash" IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_org_intent_idx"
  ON "approvals" USING btree ("org_id", "intent_id")
  WHERE "intent_id" IS NOT NULL;
