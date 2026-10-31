DO $$
DECLARE
  function_definition text;
  boundary_count integer;
  extended_boundary_count integer;
  allowlist_boundary constant text := '''crm.moveDealStage'', ''crm.convertLead'', ''crm.createTask''';
  extended_boundary constant text := '''crm.moveDealStage'', ''crm.convertLead'', ''crm.undoLeadConversion'', ''crm.reapplyLeadConversion'', ''crm.createTask''';
  policy_using text;
  policy_check text;
  policy_boundary constant text := '''crm.convertLead''::text, ''crm.createTask''::text';
  extended_policy_boundary constant text := '''crm.convertLead''::text, ''crm.undoLeadConversion''::text, ''crm.reapplyLeadConversion''::text, ''crm.createTask''::text';
BEGIN
  SELECT pg_get_functiondef('jobs_worker.claim_capability_job(text, integer)'::regprocedure)
  INTO function_definition;

  IF function_definition IS NULL THEN
    RAISE EXCEPTION 'jobs_worker.claim_capability_job(text, integer) is missing';
  END IF;

  boundary_count := (length(function_definition) - length(replace(function_definition, allowlist_boundary, ''))) / length(allowlist_boundary);
  extended_boundary_count := (length(function_definition) - length(replace(function_definition, extended_boundary, ''))) / length(extended_boundary);
  IF NOT ((boundary_count = 2 AND extended_boundary_count = 0) OR (boundary_count = 0 AND extended_boundary_count = 2)) THEN
    RAISE EXCEPTION 'unexpected crm capability allowlists in jobs_worker.claim_capability_job';
  END IF;

  IF boundary_count = 2 THEN
    function_definition := replace(function_definition, allowlist_boundary, extended_boundary);
    EXECUTE function_definition;
  END IF;

  SELECT pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)
  INTO policy_using, policy_check
  FROM pg_policy
  WHERE polrelid = 'public.jobs'::regclass
    AND polname = 'jobs_go_worker_supported_capabilities';

  IF policy_using IS NULL OR policy_check IS NULL THEN
    RAISE EXCEPTION 'jobs_go_worker_supported_capabilities policy is missing';
  END IF;

  boundary_count := (length(policy_using) - length(replace(policy_using, policy_boundary, ''))) / length(policy_boundary);
  extended_boundary_count := (length(policy_using) - length(replace(policy_using, extended_policy_boundary, ''))) / length(extended_policy_boundary);
  IF NOT ((boundary_count = 1 AND extended_boundary_count = 0) OR (boundary_count = 0 AND extended_boundary_count = 1)) THEN
    RAISE EXCEPTION 'unexpected CRM capability allowlists in jobs_go_worker_supported_capabilities';
  END IF;
  IF (length(policy_check) - length(replace(policy_check, policy_boundary, ''))) / length(policy_boundary) <> boundary_count
    OR (length(policy_check) - length(replace(policy_check, extended_policy_boundary, ''))) / length(extended_policy_boundary) <> extended_boundary_count THEN
    RAISE EXCEPTION 'USING and WITH CHECK capability allowlists differ';
  END IF;

  IF boundary_count = 1 THEN
    policy_using := replace(policy_using, policy_boundary, extended_policy_boundary);
    policy_check := replace(policy_check, policy_boundary, extended_policy_boundary);
    EXECUTE 'DROP POLICY jobs_go_worker_supported_capabilities ON public.jobs';
    EXECUTE format(
      'CREATE POLICY jobs_go_worker_supported_capabilities ON public.jobs AS RESTRICTIVE FOR ALL TO PUBLIC USING (%s) WITH CHECK (%s)',
      policy_using,
      policy_check
    );
  END IF;
END;
$$;
