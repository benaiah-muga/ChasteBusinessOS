ALTER TABLE support_auto_reply_draft_limits
  ADD CONSTRAINT support_auto_reply_draft_limits_conversation_fk
  FOREIGN KEY (conversation_id) REFERENCES support_conversations(id) ON DELETE CASCADE;--> statement-breakpoint

CREATE INDEX support_auto_reply_draft_limits_retention_idx
  ON support_auto_reply_draft_limits (org_id, window_started_at);--> statement-breakpoint

CREATE TABLE support_auto_reply_org_draft_limits (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  draft_count integer NOT NULL DEFAULT 0 CHECK (draft_count BETWEEN 0 AND 30)
);--> statement-breakpoint

CREATE TABLE support_auto_reply_reservations (
  reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);--> statement-breakpoint

CREATE INDEX support_auto_reply_reservations_org_expiry_idx
  ON support_auto_reply_reservations (org_id, expires_at);--> statement-breakpoint

ALTER TABLE support_auto_reply_org_draft_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_auto_reply_org_draft_limits
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

ALTER TABLE support_auto_reply_reservations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_auto_reply_reservations
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON support_auto_reply_draft_limits TO chaste_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON support_auto_reply_org_draft_limits TO chaste_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON support_auto_reply_reservations TO chaste_app;
