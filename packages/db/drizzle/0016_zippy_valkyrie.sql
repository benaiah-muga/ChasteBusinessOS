CREATE TABLE "support_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assigned_user_id" uuid,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sender_type" text NOT NULL,
	"sender_user_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_conversations" ADD CONSTRAINT "support_conversations_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_conversation_id_support_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."support_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_conv_org_status_idx" ON "support_conversations" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "support_conv_customer_idx" ON "support_conversations" USING btree ("org_id","customer_id");--> statement-breakpoint
CREATE INDEX "support_msg_conversation_idx" ON "support_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint

-- Tenant isolation for the support desk (0014 pattern; defense-in-depth
-- under the application's org filters — see ADR 0024 for the owner-role gap).
ALTER TABLE "support_conversations" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "support_conversations";
CREATE POLICY "tenant_isolation" ON "support_conversations" USING (
	"org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
) WITH CHECK (
	"org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
);
ALTER TABLE "support_messages" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "support_messages";
CREATE POLICY "tenant_isolation" ON "support_messages" USING (
	"org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
) WITH CHECK (
	"org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
);