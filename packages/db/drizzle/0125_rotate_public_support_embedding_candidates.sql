DROP FUNCTION jobs_worker.list_public_support_embedding_orgs(integer);
--> statement-breakpoint
CREATE FUNCTION jobs_worker.list_public_support_embedding_orgs(p_limit integer, p_after_org_id uuid DEFAULT NULL)
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
    ORDER BY CASE
               WHEN p_after_org_id IS NULL OR organization.id > p_after_org_id THEN 0
               ELSE 1
             END,
             organization.id
  LOOP
    PERFORM pg_catalog.set_config('app.org_id', tenant_id::text, true);
    SELECT COALESCE(
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('orgId', due.org_id)
        ORDER BY due.queued_at, due.article_id),
      '[]'::jsonb
    )
    INTO tenant_due
    FROM (
      SELECT job.org_id, job.article_id, job.queued_at
      FROM public.support_kb_article_embedding_jobs AS job
      WHERE job.org_id = tenant_id AND job.available_at <= pg_catalog.clock_timestamp()
      ORDER BY job.queued_at, job.article_id
      LIMIT 1
    ) AS due;

    IF pg_catalog.jsonb_array_length(selected_due) < p_limit THEN
      selected_due := selected_due || tenant_due;
    END IF;
    EXIT WHEN pg_catalog.jsonb_array_length(selected_due) >= p_limit;
  END LOOP;

  RETURN QUERY
    SELECT (candidate.item ->> 'orgId')::uuid
    FROM pg_catalog.jsonb_array_elements(selected_due) WITH ORDINALITY AS candidate(item, position)
    ORDER BY candidate.position;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION jobs_worker.list_public_support_embedding_orgs(integer, uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION jobs_worker.list_public_support_embedding_orgs(integer, uuid) FROM chaste_app;
