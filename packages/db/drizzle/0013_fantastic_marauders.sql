CREATE TABLE "bom_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"assembly_item_id" uuid NOT NULL,
	"component_item_id" uuid NOT NULL,
	"quantity_thousandths" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "marketplace_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	"summary" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"signature" text NOT NULL,
	"publisher_public_key" text NOT NULL,
	"capability_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"submitted_by_org_id" uuid,
	"installed_by_org_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketplace_listings_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"label" text DEFAULT 'IdP provisioning' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sso_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"protocol" text NOT NULL,
	"label" text NOT NULL,
	"idp_entity_id" text NOT NULL,
	"sso_url" text NOT NULL,
	"idp_certificate" text,
	"domain" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_assembly_item_id_items_id_fk" FOREIGN KEY ("assembly_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_component_item_id_items_id_fk" FOREIGN KEY ("component_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "marketplace_listings" ADD CONSTRAINT "marketplace_listings_submitted_by_org_id_organizations_id_fk" FOREIGN KEY ("submitted_by_org_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bom_line_assembly_idx" ON "bom_lines" USING btree ("org_id","assembly_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bom_line_edge_idx" ON "bom_lines" USING btree ("assembly_item_id","component_item_id");--> statement-breakpoint
CREATE INDEX "listing_status_idx" ON "marketplace_listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "scim_token_org_idx" ON "scim_tokens" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sso_conn_org_idx" ON "sso_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "sso_conn_domain_idx" ON "sso_connections" USING btree ("domain");