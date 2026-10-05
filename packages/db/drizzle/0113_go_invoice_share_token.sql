CREATE OR REPLACE FUNCTION public.chaste_resolve_invoice_share_token(p_token text)
RETURNS TABLE (org_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT shares.org_id
  FROM public.invoice_shares AS shares
  WHERE p_token IS NOT NULL
    AND length(p_token) BETWEEN 20 AND 64
    AND shares.token = p_token
    AND shares.revoked_at IS NULL
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.chaste_resolve_invoice_share_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chaste_resolve_invoice_share_token(text) TO chaste_app;
