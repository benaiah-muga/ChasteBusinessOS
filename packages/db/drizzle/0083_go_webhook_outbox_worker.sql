-- The webhook dispatcher is the only non-tenant-scoped outbox reader. Its
-- claim function returns lease metadata only; payload access stays under RLS.
CREATE SCHEMA IF NOT EXISTS outbox_worker;
REVOKE ALL ON SCHEMA outbox_worker FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY outbox_webhook_worker_only
ON public.outbox_messages
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (current_user <> 'chaste_outbox_worker' OR kind = 'webhook')
WITH CHECK (current_user <> 'chaste_outbox_worker' OR kind = 'webhook');
--> statement-breakpoint
CREATE POLICY outbox_worker_claim_select
ON public.outbox_messages
FOR SELECT
TO PUBLIC
USING (current_user = 'chaste_outbox_claim_owner');
--> statement-breakpoint
CREATE POLICY outbox_worker_claim_update
ON public.outbox_messages
FOR UPDATE
TO PUBLIC
USING (current_user = 'chaste_outbox_claim_owner')
WITH CHECK (current_user = 'chaste_outbox_claim_owner');
--> statement-breakpoint
CREATE FUNCTION outbox_worker.claim_webhook(
  p_worker_id text,
  p_lease_ms integer
)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  kind text,
  provider_operation_id uuid,
  attempts integer,
  max_attempts integer,
  fencing_token integer,
  lease_owner text,
  lease_expires_at timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
SET row_security = on
AS $$
DECLARE
  claim_time timestamptz := clock_timestamp();
BEGIN
  IF p_worker_id IS NULL OR p_worker_id !~ '[^[:space:]]' OR length(p_worker_id) > 128 THEN
    RAISE EXCEPTION 'invalid outbox worker id' USING ERRCODE = '22023';
  END IF;
  IF p_lease_ms IS NULL OR p_lease_ms < 1000 OR p_lease_ms > 300000 THEN
    RAISE EXCEPTION 'outbox lease must be between 1000 and 300000 milliseconds' USING ERRCODE = '22023';
  END IF;

  UPDATE public.outbox_messages AS expired
  SET status = 'unknown',
      last_error = 'outbox lease expired during external delivery; provider outcome is unknown',
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = claim_time
  WHERE expired.kind = 'webhook'
    AND expired.status = 'processing'
    AND expired.lease_expires_at <= claim_time;

  RETURN QUERY
  WITH candidate AS (
    SELECT pending.id
    FROM public.outbox_messages AS pending
    WHERE pending.kind = 'webhook'
      AND pending.status = 'pending'
      AND pending.attempts < pending.max_attempts
      AND pending.available_at <= claim_time
    ORDER BY pending.available_at, pending.created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.outbox_messages AS claimed
  SET status = 'processing',
      attempts = claimed.attempts + 1,
      lease_owner = p_worker_id,
      lease_expires_at = claim_time + (p_lease_ms * interval '1 millisecond'),
      fencing_token = claimed.fencing_token + 1,
      updated_at = claim_time
  FROM candidate
  WHERE claimed.id = candidate.id
  RETURNING claimed.id,
            claimed.org_id,
            claimed.kind,
            claimed.provider_operation_id,
            claimed.attempts,
            claimed.max_attempts,
            claimed.fencing_token,
            claimed.lease_owner,
            claimed.lease_expires_at;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbox_worker.claim_webhook(text, integer) FROM PUBLIC;
