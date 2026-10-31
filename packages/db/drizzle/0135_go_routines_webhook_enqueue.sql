CREATE FUNCTION jobs_worker.enqueue_routine_webhook(p_token text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  tenant_id uuid;
  routine_id uuid;
BEGIN
  IF p_token IS NULL OR pg_catalog.char_length(p_token) <> 36 THEN
    RETURN false;
  END IF;

  FOR tenant_id IN SELECT organization.id FROM public.organizations AS organization ORDER BY organization.id LOOP
    PERFORM pg_catalog.set_config('app.org_id', tenant_id::text, true);
    SELECT routine.id
      INTO routine_id
      FROM public.routines AS routine
     WHERE routine.org_id = tenant_id
       AND routine.webhook_token = p_token
       AND routine.enabled = true
       AND routine.trigger_type = 'webhook'
     LIMIT 1;

    IF routine_id IS NOT NULL THEN
      INSERT INTO public.jobs(org_id, type, payload)
      VALUES (
        tenant_id,
        'routines.executeRoutine',
        pg_catalog.jsonb_build_object('routineId', routine_id, 'trigger', 'webhook')
      );
      RETURN true;
    END IF;
    routine_id := NULL;
  END LOOP;

  RETURN false;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION jobs_worker.enqueue_routine_webhook(text) FROM PUBLIC;
