CREATE OR REPLACE FUNCTION public.chaste_resolve_better_auth_session(
  p_token text,
  p_now timestamptz
)
RETURNS TABLE (
  auth_session_id text,
  user_id uuid,
  email text,
  name text,
  email_verified boolean,
  org_ids text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_session_id text;
  v_email text;
  v_domain_email text;
  v_name text;
  v_email_verified boolean;
  v_domain_user_id uuid;
  v_org_ids text[];
BEGIN
  IF p_token IS NULL OR p_token = '' OR p_now IS NULL THEN
    RETURN;
  END IF;

  SELECT s.id::text, u.email, u.name, u.email_verified
  INTO v_session_id, v_email, v_name, v_email_verified
  FROM public.auth_session AS s
  JOIN public.auth_user AS u ON u.id = s.user_id
  WHERE s.token = p_token AND s.expires_at > p_now;

  IF NOT FOUND OR v_email IS NULL OR btrim(v_email) = '' THEN
    RETURN;
  END IF;

  v_domain_email := lower(btrim(v_email));
  INSERT INTO public.users (email, name)
  VALUES (v_domain_email, v_name)
  ON CONFLICT ON CONSTRAINT users_email_unique DO NOTHING;

  SELECT u.id INTO v_domain_user_id
  FROM public.users AS u
  WHERE u.email = v_domain_email;

  IF v_domain_user_id IS NULL THEN
    RAISE EXCEPTION 'domain identity could not be resolved';
  END IF;

  IF v_email_verified THEN
    SELECT COALESCE(array_agg(m.org_id::text), ARRAY[]::text[])
    INTO v_org_ids
    FROM public.memberships AS m
    WHERE m.user_id = v_domain_user_id;
  ELSE
    v_org_ids := ARRAY[]::text[];
  END IF;

  RETURN QUERY SELECT v_session_id, v_domain_user_id, v_email, v_name, v_email_verified, v_org_ids;
END;
$$;

REVOKE ALL ON FUNCTION public.chaste_resolve_better_auth_session(text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chaste_resolve_better_auth_session(text, timestamptz) TO chaste_app;
