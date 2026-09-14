-- RLS for tables added after 0014's RLS-everywhere pass that never received
-- policies (found by the S01 conformance sweep, not by review). Same policy
-- shape as 0014.
DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'bank_accounts', 'bank_transactions', 'purchase_requests', 'rfqs',
    'sales_tax_filings', 'support_settings'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', 'tenant_isolation', t);
    EXECUTE format(
      $f$
      CREATE POLICY tenant_isolation ON %I
        USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
        WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), ''::text)::uuid)
      $f$, t, t);
  END LOOP;
END $$;
