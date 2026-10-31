-- Link each durable recurring invoice occurrence to the job which executes it.
ALTER TABLE public.recurring_invoice_runs
  ADD COLUMN job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX recurring_invoice_run_job_idx
  ON public.recurring_invoice_runs(job_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION jobs_worker.list_due_recurring_invoice_candidates(p_limit integer, p_org_id uuid DEFAULT NULL)
RETURNS TABLE (recurring_invoice_id uuid, org_id uuid, scheduled_for timestamptz)
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
    RAISE EXCEPTION 'recurring invoice candidate limit must be between 1 and 100'
      USING ERRCODE = '22023';
  END IF;

  FOR tenant_id IN
    SELECT organization.id
    FROM public.organizations AS organization
    WHERE p_org_id IS NULL OR organization.id = p_org_id
    ORDER BY organization.id
  LOOP
    PERFORM pg_catalog.set_config('app.org_id', tenant_id::text, true);
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'recurringInvoiceId', due.id,
          'orgId', due.org_id,
          'scheduledFor', due.next_run_at
        ) ORDER BY due.next_run_at, due.id
      ),
      '[]'::jsonb
    )
    INTO tenant_due
    FROM (
      SELECT invoice.id, invoice.org_id, invoice.next_run_at
      FROM public.recurring_invoices AS invoice
      WHERE invoice.org_id = tenant_id
        AND invoice.active = true
        AND invoice.next_run_at <= pg_catalog.clock_timestamp()
        AND NOT EXISTS (
          SELECT 1
          FROM public.recurring_invoice_runs AS run
          WHERE run.org_id = invoice.org_id
            AND run.recurring_invoice_id = invoice.id
            AND run.scheduled_for = invoice.next_run_at
            AND run.status IN ('queued', 'completed')
        )
      ORDER BY invoice.next_run_at, invoice.id
      LIMIT p_limit
    ) AS due;

    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        candidate.item
        ORDER BY (candidate.item ->> 'scheduledFor')::timestamptz,
                 (candidate.item ->> 'recurringInvoiceId')::uuid
      ),
      '[]'::jsonb
    )
    INTO selected_due
    FROM (
      SELECT entry.item
      FROM pg_catalog.jsonb_array_elements(selected_due || tenant_due) AS entry(item)
      ORDER BY (entry.item ->> 'scheduledFor')::timestamptz,
               (entry.item ->> 'recurringInvoiceId')::uuid
      LIMIT p_limit
    ) AS candidate;
  END LOOP;

  RETURN QUERY
    SELECT (candidate.item ->> 'recurringInvoiceId')::uuid,
           (candidate.item ->> 'orgId')::uuid,
           (candidate.item ->> 'scheduledFor')::timestamptz
    FROM pg_catalog.jsonb_array_elements(selected_due) AS candidate(item)
    ORDER BY (candidate.item ->> 'scheduledFor')::timestamptz,
             (candidate.item ->> 'recurringInvoiceId')::uuid;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION jobs_worker.list_due_recurring_invoice_candidates(integer, uuid) FROM PUBLIC;
