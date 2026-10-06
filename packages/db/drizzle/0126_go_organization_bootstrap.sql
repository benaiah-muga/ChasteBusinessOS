DO $$
DECLARE
  v_role_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'chaste_bootstrap_owner') THEN
    EXECUTE 'CREATE ROLE chaste_bootstrap_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  ELSE
    EXECUTE 'ALTER ROLE chaste_bootstrap_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  FOR v_role_name IN
    SELECT granted.rolname
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
    WHERE member.rolname = 'chaste_bootstrap_owner'
  LOOP
    EXECUTE pg_catalog.format('REVOKE %I FROM chaste_bootstrap_owner', v_role_name);
  END LOOP;
  FOR v_role_name IN
    SELECT member.rolname
    FROM pg_catalog.pg_auth_members AS membership
    JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
    JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
    WHERE granted.rolname = 'chaste_bootstrap_owner'
  LOOP
    EXECUTE pg_catalog.format('REVOKE chaste_bootstrap_owner FROM %I', v_role_name);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.chaste_bootstrap_organization(
  p_session_token text,
  p_org_name text,
  p_business_description text,
  p_base_currency text,
  p_path text,
  p_deferred_steps text[],
  p_intent_id text
)
RETURNS TABLE (org_id uuid, replayed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_user_id uuid;
  v_locked_user_id uuid;
  v_email_verified boolean;
  v_org_ids text[];
  v_existing_org_id text;
  v_previous_org_id text;
  v_path text;
  v_currency text;
  v_steps text[] := COALESCE(p_deferred_steps, ARRAY[]::text[]);
  v_payload text;
  v_payload_hash text;
  v_receipt_hash text;
  v_receipt_org_id uuid;
  v_base_slug text;
  v_slug text;
  v_org_id uuid;
  v_org_inserted boolean := false;
  v_owner_role_id uuid;
  v_constraint_name text;
  v_attempt integer;
  v_started_at text;
BEGIN
  IF p_session_token IS NULL OR length(p_session_token) < 16 OR length(p_session_token) > 512 THEN
    RAISE EXCEPTION 'verified session required' USING ERRCODE = '28000';
  END IF;

  IF p_org_name IS NULL OR length(p_org_name) < 2 OR length(p_org_name) > 80
     OR octet_length(p_org_name) > 320 THEN
    RAISE EXCEPTION 'invalid organization name' USING ERRCODE = '22023';
  END IF;
  IF p_business_description IS NULL OR length(p_business_description) < 20
     OR length(p_business_description) > 8000 OR octet_length(p_business_description) > 32000 THEN
    RAISE EXCEPTION 'invalid business description' USING ERRCODE = '22023';
  END IF;

  IF p_base_currency IS NULL THEN
    RAISE EXCEPTION 'base currency is required' USING ERRCODE = '22023';
  END IF;
  v_currency := upper(p_base_currency);
  IF v_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'unsupported base currency' USING ERRCODE = '22023';
  END IF;
  IF p_path IS NULL THEN
    RAISE EXCEPTION 'onboarding path is required' USING ERRCODE = '22023';
  END IF;
  v_path := p_path;
  IF v_path NOT IN ('fresh', 'import', 'connect') THEN
    RAISE EXCEPTION 'invalid onboarding path' USING ERRCODE = '22023';
  END IF;
  IF p_intent_id IS NOT NULL AND (length(p_intent_id) < 8 OR length(p_intent_id) > 100) THEN
    RAISE EXCEPTION 'invalid bootstrap intent' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_steps) > 100 OR EXISTS (
    SELECT 1 FROM unnest(v_steps) AS supplied(step)
    WHERE supplied.step IS NULL OR length(supplied.step) > 128
  ) THEN
    RAISE EXCEPTION 'invalid deferred setup steps' USING ERRCODE = '22023';
  END IF;

  -- The trusted resolver validates the live session, derives its domain user,
  -- and returns that user's organizations. The caller cannot choose an owner.
  SELECT resolved.user_id, resolved.email_verified, resolved.org_ids
  INTO v_user_id, v_email_verified, v_org_ids
  FROM public.chaste_resolve_better_auth_session(p_session_token, pg_catalog.clock_timestamp()) AS resolved;

  IF NOT FOUND OR v_email_verified IS DISTINCT FROM true OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'verified session required' USING ERRCODE = '28000';
  END IF;
  v_previous_org_id := pg_catalog.current_setting('app.org_id', true);

  -- Serialize every bootstrap for this verified identity. This protects both
  -- receipt replays and no-intent calls from concurrent duplicate workspaces.
  v_locked_user_id := v_user_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user_id::text, 0));

  -- Re-resolve after acquiring the lock. Another bootstrap may have committed
  -- a membership while this transaction waited, and a different intent must
  -- then be rejected rather than creating a second workspace.
  SELECT resolved.user_id, resolved.email_verified, resolved.org_ids
  INTO v_user_id, v_email_verified, v_org_ids
  FROM public.chaste_resolve_better_auth_session(p_session_token, pg_catalog.clock_timestamp()) AS resolved;
  IF NOT FOUND OR v_email_verified IS DISTINCT FROM true OR v_user_id IS NULL
     OR v_user_id IS DISTINCT FROM v_locked_user_id THEN
    RAISE EXCEPTION 'verified session required' USING ERRCODE = '28000';
  END IF;

  -- Match the legacy JSON.stringify property order and SHA-256 receipt format.
  -- Deferred values are sorted with bytewise ordering, which matches the
  -- ASCII setup-step identifiers sent by the onboarding client.
  v_payload := '{"orgName":' || pg_catalog.to_json(p_org_name)::text
    || ',"businessDescription":' || pg_catalog.to_json(p_business_description)::text
    || ',"baseCurrency":' || pg_catalog.to_json(v_currency)::text
    || ',"path":' || pg_catalog.to_json(v_path)::text
    || ',"deferredSteps":[' || COALESCE((
      SELECT pg_catalog.string_agg(pg_catalog.to_json(supplied.step)::text, ',' ORDER BY supplied.step COLLATE "C")
      FROM unnest(v_steps) AS supplied(step)
    ), '') || ']}';
  v_payload_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload, 'UTF8')), 'hex');

  IF p_intent_id IS NOT NULL THEN
    FOREACH v_existing_org_id IN ARRAY COALESCE(v_org_ids, ARRAY[]::text[]) LOOP
      PERFORM pg_catalog.set_config('app.org_id', v_existing_org_id, true);
      SELECT receipt.payload_hash, receipt.org_id
      INTO v_receipt_hash, v_receipt_org_id
      FROM public.bootstrap_intents AS receipt
      WHERE receipt.user_id = v_user_id AND receipt.intent_id = p_intent_id
      ;
      IF FOUND THEN
        PERFORM pg_catalog.set_config('app.org_id', COALESCE(v_previous_org_id, ''), true);
        IF v_receipt_hash <> v_payload_hash THEN
          RAISE EXCEPTION 'bootstrap intent conflict' USING ERRCODE = '23505';
        END IF;
        IF v_receipt_org_id IS NULL THEN
          RAISE EXCEPTION 'bootstrap receipt has no organization' USING ERRCODE = '23505';
        END IF;
        RETURN QUERY SELECT v_receipt_org_id, true;
        RETURN;
      END IF;
    END LOOP;
    PERFORM pg_catalog.set_config('app.org_id', COALESCE(v_previous_org_id, ''), true);
  END IF;

  IF cardinality(COALESCE(v_org_ids, ARRAY[]::text[])) > 0 THEN
    RAISE EXCEPTION 'user already belongs to an organization' USING ERRCODE = '23505';
  END IF;

  -- Slug retries use a subtransaction for each unique constraint collision.
  -- Same-runtime retries serialize on the verified identity lock.
  v_base_slug := pg_catalog.left(
    COALESCE(NULLIF(pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(p_org_name), '[^a-z0-9]+', '-', 'g'), '-'), ''), 'org'),
    40
  );
  v_slug := v_base_slug;
  v_started_at := pg_catalog.to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  v_org_id := pg_catalog.gen_random_uuid();
  PERFORM pg_catalog.set_config('app.org_id', v_org_id::text, true);

  FOR v_attempt IN 0..4 LOOP
    BEGIN
      INSERT INTO public.organizations (id, name, slug, profile_description, base_currency, settings)
      VALUES (
        v_org_id,
        p_org_name,
        v_slug,
        p_business_description,
        v_currency,
        pg_catalog.jsonb_build_object(
          'onboarding', pg_catalog.jsonb_build_object(
            'path', v_path,
            'steps', COALESCE((
              SELECT pg_catalog.jsonb_object_agg(supplied.step, pg_catalog.to_jsonb('pending'::text))
              FROM unnest(v_steps) AS supplied(step)
              WHERE supplied.step IN ('business_profile', 'import_customers', 'import_products', 'connect_source', 'invite_team')
            ), '{}'::jsonb),
            'startedAt', v_started_at
          )
        )
      );
      v_org_inserted := true;
      EXIT;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
      IF v_constraint_name <> 'organizations_slug_unique' THEN
        RAISE;
      END IF;
      v_slug := v_base_slug || '-' || (v_attempt + 2)::text;
    END;
  END LOOP;

  IF NOT v_org_inserted THEN
    RAISE EXCEPTION 'failed to create organization' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.accounts (org_id, code, name, type) VALUES
    (v_org_id, '1000', 'Cash', 'asset'),
    (v_org_id, '1100', 'Accounts Receivable', 'asset'),
    (v_org_id, '1200', 'Inventory', 'asset'),
    (v_org_id, '2000', 'Accounts Payable', 'liability'),
    (v_org_id, '2100', 'Sales Tax Payable', 'liability'),
    (v_org_id, '2200', 'Payroll Liabilities', 'liability'),
    (v_org_id, '3000', 'Owner''s Equity', 'equity'),
    (v_org_id, '3100', 'Retained Earnings', 'equity'),
    (v_org_id, '4000', 'Sales Revenue', 'income'),
    (v_org_id, '5000', 'Cost of Goods Sold', 'expense'),
    (v_org_id, '6000', 'Operating Expenses', 'expense');

  INSERT INTO public.roles (org_id, key, name, is_system)
  VALUES (v_org_id, 'owner', 'Owner', true)
  RETURNING id INTO v_owner_role_id;
  IF v_owner_role_id IS NULL THEN
    RAISE EXCEPTION 'failed to create owner role';
  END IF;

  INSERT INTO public.role_permissions (role_id, permission_key, org_id)
  VALUES (v_owner_role_id, '*', v_org_id);
  INSERT INTO public.user_roles (user_id, role_id, org_id)
  VALUES (v_user_id, v_owner_role_id, v_org_id);
  INSERT INTO public.memberships (org_id, user_id)
  VALUES (v_org_id, v_user_id);
  INSERT INTO public.policies (org_id, capability_pattern, max_risk_autonomous, money_threshold_minor)
  VALUES (v_org_id, '*', 'write', 50000);
  INSERT INTO public.memories (org_id, kind, source, content, embedding)
  VALUES (
    v_org_id,
    'business_profile',
    'onboarding',
    p_business_description,
    pg_catalog.array_fill(0::real, ARRAY[1024])::public.vector(1024)
  );

  IF p_intent_id IS NOT NULL THEN
    INSERT INTO public.bootstrap_intents (user_id, intent_id, payload_hash, org_id)
    VALUES (v_user_id, p_intent_id, v_payload_hash, v_org_id);
  END IF;

  PERFORM pg_catalog.set_config('app.org_id', COALESCE(v_previous_org_id, ''), true);
  RETURN QUERY SELECT v_org_id, false;
END;
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO chaste_bootstrap_owner;
GRANT EXECUTE ON FUNCTION public.chaste_resolve_better_auth_session(text, timestamptz) TO chaste_bootstrap_owner;
GRANT INSERT ON public.organizations, public.accounts, public.roles, public.role_permissions,
  public.user_roles, public.memberships, public.policies, public.memories, public.bootstrap_intents
  TO chaste_bootstrap_owner;
GRANT SELECT (id) ON public.roles TO chaste_bootstrap_owner;
GRANT SELECT ON public.bootstrap_intents TO chaste_bootstrap_owner;
--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO chaste_bootstrap_owner;
ALTER FUNCTION public.chaste_bootstrap_organization(text, text, text, text, text, text[], text) OWNER TO chaste_bootstrap_owner;
REVOKE CREATE ON SCHEMA public FROM chaste_bootstrap_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.chaste_bootstrap_organization(text, text, text, text, text, text[], text) FROM PUBLIC, chaste_app;
GRANT EXECUTE ON FUNCTION public.chaste_bootstrap_organization(text, text, text, text, text, text[], text) TO chaste_app;
