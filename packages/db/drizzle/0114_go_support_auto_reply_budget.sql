CREATE TABLE support_auto_reply_draft_limits (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  window_started_at timestamptz NOT NULL,
  draft_count integer NOT NULL CHECK (draft_count BETWEEN 1 AND 3),
  PRIMARY KEY (org_id, conversation_id)
);--> statement-breakpoint

ALTER TABLE support_auto_reply_draft_limits ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON support_auto_reply_draft_limits
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON support_auto_reply_draft_limits TO chaste_app;
