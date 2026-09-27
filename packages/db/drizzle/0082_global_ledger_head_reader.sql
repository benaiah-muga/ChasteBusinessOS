-- The Go runtime role enforces tenant RLS and cannot see other tenants'
-- ledger rows. The hash chain is global, so expose only its current head.
CREATE OR REPLACE FUNCTION public.chaste_ledger_chain_head()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    (SELECT hash FROM public.ledger_events ORDER BY seq DESC LIMIT 1),
    repeat('0', 64)
  )
$$;

REVOKE ALL ON FUNCTION public.chaste_ledger_chain_head() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaste_app') THEN
    GRANT EXECUTE ON FUNCTION public.chaste_ledger_chain_head() TO chaste_app;
  END IF;
END $$;
