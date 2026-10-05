DROP FUNCTION public.chaste_resolve_scim_token(text);
--> statement-breakpoint
CREATE FUNCTION public.chaste_resolve_scim_token(p_token_hash text)
RETURNS TABLE (token_id uuid, org_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_token_hash IS NULL OR length(p_token_hash) <> 64 OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;

  RETURN QUERY
    UPDATE public.scim_tokens AS token
    SET last_used_at = clock_timestamp()
    WHERE token.token_hash = p_token_hash
      AND token.active = true
      AND (token.expires_at IS NULL OR token.expires_at > clock_timestamp())
    RETURNING token.id, token.org_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.chaste_resolve_scim_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chaste_resolve_scim_token(text) TO chaste_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.chaste_resolve_or_create_scim_user(
  p_token_id uuid,
  p_org_id uuid,
  p_email text,
  p_name text
)
RETURNS TABLE (user_id uuid, email text, name text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  normalized_email text;
  matching_users integer;
BEGIN
  IF p_token_id IS NULL OR p_org_id IS NULL
     OR p_org_id IS DISTINCT FROM NULLIF(current_setting('app.org_id', true), '')::uuid
     OR p_email IS NULL OR length(p_email) < 5 OR length(p_email) > 320
     OR p_email <> lower(btrim(p_email)) OR position('@' IN p_email) < 2 THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.scim_tokens AS token
    WHERE token.id = p_token_id AND token.org_id = p_org_id
      AND token.active = true
      AND (token.expires_at IS NULL OR token.expires_at > clock_timestamp())
  ) THEN
    RETURN;
  END IF;

  normalized_email := p_email;
  SELECT count(*) INTO matching_users
  FROM public.users AS existing
  WHERE lower(existing.email) = normalized_email;
  IF matching_users > 1 THEN
    RAISE EXCEPTION 'SCIM email identity is ambiguous';
  END IF;

  INSERT INTO public.users (email, name)
  VALUES (normalized_email, NULLIF(btrim(p_name), ''))
  ON CONFLICT ON CONSTRAINT users_email_unique DO NOTHING;

  RETURN QUERY
    SELECT existing.id, existing.email, existing.name
    FROM public.users AS existing
    WHERE lower(existing.email) = normalized_email
    LIMIT 1;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.chaste_resolve_or_create_scim_user(uuid, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chaste_resolve_or_create_scim_user(uuid, uuid, text, text) TO chaste_app;
