CREATE OR REPLACE FUNCTION public.chaste_marketplace_uninstall_listing(p_listing_id uuid)
RETURNS TABLE (installed_by_org_ids jsonb, uninstalled boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org_id uuid;
  v_installed_by_org_ids jsonb;
  v_next_installed_by_org_ids jsonb := '[]'::jsonb;
  v_entry jsonb;
  v_installer_org_id uuid;
BEGIN
  v_org_id := NULLIF(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'app.org_id is required for marketplace uninstall';
  END IF;

  SELECT listing.installed_by_org_ids
    INTO v_installed_by_org_ids
    FROM public.marketplace_listings AS listing
    WHERE listing.id = p_listing_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'listing not found';
  END IF;
  IF pg_catalog.jsonb_typeof(v_installed_by_org_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'listing installation state is malformed';
  END IF;

  FOR v_entry IN SELECT value FROM pg_catalog.jsonb_array_elements(v_installed_by_org_ids) AS entries(value)
  LOOP
    IF pg_catalog.jsonb_typeof(v_entry) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'listing installation state contains a non-string organization ID';
    END IF;
    BEGIN
      v_installer_org_id := (v_entry #>> '{}')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'listing installation state contains an invalid organization ID';
    END;
    IF v_installer_org_id <> v_org_id THEN
      v_next_installed_by_org_ids := v_next_installed_by_org_ids || pg_catalog.jsonb_build_array(v_entry #>> '{}');
    END IF;
  END LOOP;

  UPDATE public.marketplace_listings AS listing
    SET installed_by_org_ids = v_next_installed_by_org_ids,
        updated_at = pg_catalog.clock_timestamp()
    WHERE listing.id = p_listing_id
    RETURNING listing.installed_by_org_ids INTO v_installed_by_org_ids;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'listing not found';
  END IF;
  IF v_installed_by_org_ids @> pg_catalog.jsonb_build_array(v_org_id::text) THEN
    RETURN QUERY SELECT v_installed_by_org_ids, false;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_installed_by_org_ids, true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.chaste_marketplace_uninstall_listing(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.chaste_marketplace_uninstall_listing(uuid) TO chaste_app;
