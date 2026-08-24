-- Row-Level Security everywhere: defense-in-depth under the application's
-- org filters. Policies scope every tenant table to current_setting('app.org_id').
-- The app connects as a role that does NOT bypass RLS (see ADR 0017);
-- superuser/owner connections bypass RLS by Postgres design and are for
-- migrations and administration only.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'memberships', 'roles', 'role_permissions', 'user_roles',
    'ledger_events', 'agent_sessions', 'approvals',
    'policies', 'memories', 'tickets',
    'accounts', 'customers', 'invoices', 'payments',
    'journal_entries',
    'vendors', 'vendor_bills', 'vendor_payments',
    'pos_sessions', 'deals',
    'items', 'stock_movements', 'purchase_orders', 'periods',
    'conversations', 'messages',
    'documents', 'document_suggestions',
    'employees', 'leave_requests', 'payroll_runs', 'payslips',
    'creator_proposals', 'invitations',
    'bom_lines', 'sso_connections', 'scim_tokens'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- Idempotent replace: policy may already exist from a prior partial run.
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'tenant_isolation', t);
    EXECUTE format(
      $f$
      CREATE POLICY tenant_isolation ON %I
        USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
        WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid)
      $f$, t, t);
  END LOOP;
END $$;

-- Child tables without their own org_id inherit tenancy from their parent row.
-- The joins are keyed on the same columns the FKs enforce.

ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON session_events;
CREATE POLICY tenant_isolation ON session_events USING (
  EXISTS (
    SELECT 1 FROM agent_sessions s
    WHERE s.id = session_events.session_id
      AND s.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  )
);

ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON invoice_lines;
CREATE POLICY tenant_isolation ON invoice_lines USING (
  EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.id = invoice_lines.invoice_id
      AND i.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  )
);

ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON journal_lines;
CREATE POLICY tenant_isolation ON journal_lines USING (
  EXISTS (
    SELECT 1 FROM journal_entries e
    WHERE e.id = journal_lines.entry_id
      AND e.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  )
);

ALTER TABLE vendor_bill_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON vendor_bill_lines;
CREATE POLICY tenant_isolation ON vendor_bill_lines USING (
  EXISTS (
    SELECT 1 FROM vendor_bills b
    WHERE b.id = vendor_bill_lines.bill_id
      AND b.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  )
);

ALTER TABLE po_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON po_lines;
CREATE POLICY tenant_isolation ON po_lines USING (
  EXISTS (
    SELECT 1 FROM purchase_orders p
    WHERE p.id = po_lines.po_id
      AND p.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  )
);

ALTER TABLE conversation_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON conversation_members;
CREATE POLICY tenant_isolation ON conversation_members USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = conversation_members.conversation_id
      AND c.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  )
);

-- Global tables have no org_id; RLS on them would hide everything from the
-- scoped role. They are guarded by FKs into tenant tables where relevant.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON organizations;
CREATE POLICY tenant_isolation ON organizations
  USING (id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Marketplace is intentionally global-readable (that's the point of one).
ALTER TABLE marketplace_listings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS marketplace_public_read ON marketplace_listings;
CREATE POLICY marketplace_public_read ON marketplace_listings FOR SELECT USING (true);
DROP POLICY IF EXISTS marketplace_submitter_write ON marketplace_listings;
CREATE POLICY marketplace_submitter_write ON marketplace_listings
  USING (
    submitted_by_org_id IS NULL
    OR submitted_by_org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  );

-- Users table: a member sees co-members of their own org only.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_coworkers_only ON users;
CREATE POLICY org_coworkers_only ON users USING (
  EXISTS (
    SELECT 1 FROM memberships m1
    WHERE m1.user_id = users.id
      AND m1.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  )
);
