-- Opt in to Go-owned due routine discovery without widening the jobs worker's
-- direct access to tenant business tables or changing the default claim path.
CREATE POLICY jobs_go_routine_agent_runner_gate
ON public.jobs
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (
  session_user <> 'chaste_jobs_worker'
  OR type <> 'routines.executeRoutine'
  OR COALESCE(current_setting('app.go_routine_agent_runner', true), '0') = '1'
)
WITH CHECK (
  session_user <> 'chaste_jobs_worker'
  OR type <> 'routines.executeRoutine'
  OR COALESCE(current_setting('app.go_routine_agent_runner', true), '0') = '1'
);
--> statement-breakpoint
CREATE FUNCTION jobs_worker.list_due_routine_candidates(p_limit integer)
RETURNS TABLE (routine_id uuid, org_id uuid, scheduled_at timestamptz)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $$
DECLARE
  tenant_id uuid;
  tenant_due jsonb;
  selected_due jsonb := '[]'::jsonb;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'routine candidate limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  FOR tenant_id IN
    SELECT organization.id
    FROM public.organizations AS organization
    ORDER BY organization.id
  LOOP
    PERFORM pg_catalog.set_config('app.org_id', tenant_id::text, true);
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'routineId', due.id,
          'orgId', due.org_id,
          'scheduledAt', due.next_run_at
        ) ORDER BY due.next_run_at, due.id
      ),
      '[]'::jsonb
    )
    INTO tenant_due
    FROM (
      SELECT routine.id, routine.org_id, routine.next_run_at
      FROM public.routines AS routine
      WHERE routine.org_id = tenant_id
        AND routine.enabled = true
        AND routine.trigger_type = 'schedule'
        AND routine.next_run_at <= pg_catalog.clock_timestamp()
      ORDER BY routine.next_run_at, routine.id
      LIMIT p_limit
    ) AS due;

    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        candidate.item
        ORDER BY (candidate.item ->> 'scheduledAt')::timestamptz,
                 (candidate.item ->> 'routineId')::uuid
      ),
      '[]'::jsonb
    )
    INTO selected_due
    FROM (
      SELECT entry.item
      FROM pg_catalog.jsonb_array_elements(selected_due || tenant_due) AS entry(item)
      ORDER BY (entry.item ->> 'scheduledAt')::timestamptz,
               (entry.item ->> 'routineId')::uuid
      LIMIT p_limit
    ) AS candidate;
  END LOOP;

  RETURN QUERY
    SELECT (candidate.item ->> 'routineId')::uuid,
           (candidate.item ->> 'orgId')::uuid,
           (candidate.item ->> 'scheduledAt')::timestamptz
    FROM pg_catalog.jsonb_array_elements(selected_due) AS candidate(item)
    ORDER BY (candidate.item ->> 'scheduledAt')::timestamptz,
             (candidate.item ->> 'routineId')::uuid;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION jobs_worker.list_due_routine_candidates(integer) FROM PUBLIC;
