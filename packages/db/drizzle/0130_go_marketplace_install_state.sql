CREATE OR REPLACE FUNCTION public.chaste_marketplace_lock_listing(p_listing_id uuid)
RETURNS TABLE (
  id uuid,
  slug text,
  version text,
  status text,
  manifest jsonb,
  signature text,
  publisher_public_key text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org_id uuid;
  v_listing_id uuid;
  v_slug text;
  v_version text;
  v_status text;
  v_manifest jsonb;
  v_signature text;
  v_publisher_public_key text;
BEGIN
  v_org_id := NULLIF(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'app.org_id is required for marketplace installation';
  END IF;

  SELECT listing.id, listing.slug, listing.version, listing.status, listing.manifest,
         listing.signature, listing.publisher_public_key
    INTO v_listing_id, v_slug, v_version, v_status, v_manifest, v_signature, v_publisher_public_key
    FROM public.marketplace_listings AS listing
    WHERE listing.id = p_listing_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT v_listing_id, v_slug, v_version, v_status, v_manifest, v_signature, v_publisher_public_key;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.chaste_marketplace_lock_listing(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaste_app') THEN
    GRANT EXECUTE ON FUNCTION public.chaste_marketplace_lock_listing(uuid) TO chaste_app;
  END IF;
END $$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.chaste_marketplace_install_listing(uuid);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.chaste_marketplace_install_listing(p_listing_id uuid)
RETURNS TABLE (installed_by_org_ids jsonb, installed boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_org_id uuid;
  v_status text;
  v_installed_by_org_ids jsonb;
BEGIN
  v_org_id := NULLIF(pg_catalog.current_setting('app.org_id', true), '')::uuid;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'app.org_id is required for marketplace installation';
  END IF;

  SELECT listing.status, listing.installed_by_org_ids
    INTO v_status, v_installed_by_org_ids
    FROM public.marketplace_listings AS listing
    WHERE listing.id = p_listing_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'listing not found';
  END IF;
  IF v_status <> 'verified' THEN
    RAISE EXCEPTION 'listing is %; refusing install', v_status;
  END IF;
  IF pg_catalog.jsonb_typeof(v_installed_by_org_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'listing installation state is malformed';
  END IF;

  IF NOT (v_installed_by_org_ids @> pg_catalog.jsonb_build_array(v_org_id::text)) THEN
    v_installed_by_org_ids := v_installed_by_org_ids || pg_catalog.jsonb_build_array(v_org_id::text);
  END IF;

  UPDATE public.marketplace_listings AS listing
    SET installed_by_org_ids = v_installed_by_org_ids,
        updated_at = pg_catalog.clock_timestamp()
    WHERE listing.id = p_listing_id AND listing.status = 'verified'
    RETURNING listing.installed_by_org_ids INTO v_installed_by_org_ids;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'listing is no longer verified; refusing install';
  END IF;

  RETURN QUERY SELECT v_installed_by_org_ids, true;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.chaste_marketplace_install_listing(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaste_app') THEN
    GRANT EXECUTE ON FUNCTION public.chaste_marketplace_install_listing(uuid) TO chaste_app;
  END IF;
END $$;
