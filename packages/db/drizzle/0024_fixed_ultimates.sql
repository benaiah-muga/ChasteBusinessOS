CREATE TABLE "support_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"embed_token" text NOT NULL,
	"auto_reply_enabled" boolean DEFAULT true NOT NULL,
	"greeting" text DEFAULT 'Hi — ask us anything and we''ll get right back to you.' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_settings" ADD CONSTRAINT "support_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_settings_token_idx" ON "support_settings" USING btree ("embed_token");