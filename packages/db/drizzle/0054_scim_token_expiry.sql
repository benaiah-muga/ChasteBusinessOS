ALTER TABLE "scim_tokens" ADD COLUMN "expires_at" timestamp with time zone;
--> statement-breakpoint

-- Expiry policy: a provisioning token lives 90 days by default (creation
-- route), and rotation is create-new + deactivate-old. Legacy rows with a
-- null expiry stay valid until deactivated; the IdP route refuses anything
-- past its expiry regardless of the active flag.
COMMENT ON COLUMN "scim_tokens"."expires_at" IS 'null = pre-policy token, valid until deactivated';
