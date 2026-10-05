CREATE FUNCTION jobs_worker.list_public_support_embedding_orgs(p_limit integer)
RETURNS TABLE (org_id uuid)
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
    RAISE EXCEPTION 'support embedding candidate limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  FOR tenant_id IN
    SELECT organization.id
    FROM public.organizations AS organization
    ORDER BY organization.id
  LOOP
    PERFORM pg_catalog.set_config('app.org_id', tenant_id::text, true);
    SELECT COALESCE(
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('orgId', due.org_id, 'queuedAt', due.queued_at)
        ORDER BY due.queued_at, due.article_id),
      '[]'::jsonb
    )
    INTO tenant_due
    FROM (
      SELECT job.org_id, job.article_id, job.queued_at
      FROM public.support_kb_article_embedding_jobs AS job
      WHERE job.org_id = tenant_id
      ORDER BY job.queued_at, job.article_id
      LIMIT 1
    ) AS due;

    SELECT COALESCE(
      pg_catalog.jsonb_agg(candidate.item ORDER BY (candidate.item ->> 'queuedAt')::timestamptz,
                                                    (candidate.item ->> 'orgId')::uuid),
      '[]'::jsonb
    )
    INTO selected_due
    FROM (
      SELECT entry.item
      FROM pg_catalog.jsonb_array_elements(selected_due || tenant_due) AS entry(item)
      ORDER BY (entry.item ->> 'queuedAt')::timestamptz,
               (entry.item ->> 'orgId')::uuid
      LIMIT p_limit
    ) AS candidate;
  END LOOP;

  RETURN QUERY
    SELECT DISTINCT (candidate.item ->> 'orgId')::uuid
    FROM pg_catalog.jsonb_array_elements(selected_due) AS candidate(item)
    ORDER BY 1;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION jobs_worker.list_public_support_embedding_orgs(integer) FROM PUBLIC;
