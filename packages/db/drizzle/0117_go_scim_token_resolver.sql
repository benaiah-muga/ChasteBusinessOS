CREATE OR REPLACE FUNCTION public.chaste_resolve_scim_token(p_token_hash text)
RETURNS TABLE (org_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  resolved_org_id uuid;
BEGIN
  IF p_token_hash IS NULL OR length(p_token_hash) <> 64 OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  UPDATE public.scim_tokens AS token
  SET last_used_at = clock_timestamp()
  WHERE token.token_hash = p_token_hash
    AND token.active = true
    AND (token.expires_at IS NULL OR token.expires_at > clock_timestamp())
  RETURNING token.org_id INTO resolved_org_id;

  IF resolved_org_id IS NOT NULL THEN
    RETURN QUERY SELECT resolved_org_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.chaste_resolve_scim_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chaste_resolve_scim_token(text) TO chaste_app;
