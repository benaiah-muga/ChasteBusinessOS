CREATE OR REPLACE FUNCTION public.chaste_resolve_support_embed_token(p_embed_token text)
RETURNS TABLE (org_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT settings.org_id
  FROM public.support_settings AS settings
  WHERE p_embed_token IS NOT NULL
    AND length(p_embed_token) BETWEEN 16 AND 512
    AND settings.embed_token = p_embed_token
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.chaste_resolve_support_embed_token(text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaste_app') THEN
    GRANT EXECUTE ON FUNCTION public.chaste_resolve_support_embed_token(text) TO chaste_app;
  END IF;
END $$;
