CREATE TABLE "coding_agent_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text,
	"encrypted_credential" text,
	"model_id" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"run_count" bigint DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coding_agent_connections" ADD CONSTRAINT "coding_agent_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coding_agent_connections" ADD CONSTRAINT "coding_agent_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "coding_agent_connection_org_user_provider_idx" ON "coding_agent_connections" USING btree ("org_id","user_id","provider");--> statement-breakpoint
CREATE INDEX "coding_agent_connection_owner_idx" ON "coding_agent_connections" USING btree ("org_id","user_id");