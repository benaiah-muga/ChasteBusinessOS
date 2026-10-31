-- Go capability approval emails use the generic notification:approval.email
-- key and are isolated from webhook and marketing delivery credentials.
CREATE SCHEMA IF NOT EXISTS outbox_worker;
REVOKE ALL ON SCHEMA outbox_worker FROM PUBLIC;
--> statement-breakpoint
CREATE POLICY outbox_notification_email_worker_only
ON public.outbox_messages
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (current_user <> 'chaste_notification_email_worker'
  OR (kind = 'email' AND dedupe_key LIKE 'notification:approval.email:%'))
WITH CHECK (current_user <> 'chaste_notification_email_worker'
  OR (kind = 'email' AND dedupe_key LIKE 'notification:approval.email:%'));
--> statement-breakpoint
CREATE POLICY outbox_notification_email_claim_select
ON public.outbox_messages
FOR SELECT
TO PUBLIC
USING (current_user = 'chaste_notification_email_claim_owner');
--> statement-breakpoint
CREATE POLICY outbox_notification_email_claim_update
ON public.outbox_messages
FOR UPDATE
TO PUBLIC
USING (current_user = 'chaste_notification_email_claim_owner')
WITH CHECK (current_user = 'chaste_notification_email_claim_owner');
--> statement-breakpoint
CREATE FUNCTION outbox_worker.claim_notification_email(
  p_worker_id text,
  p_lease_ms integer
)
RETURNS TABLE (
  id uuid,
  org_id uuid,
  kind text,
  dedupe_key text,
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
    RAISE EXCEPTION 'invalid notification email worker id' USING ERRCODE = '22023';
  END IF;
  IF p_lease_ms IS NULL OR p_lease_ms < 1000 OR p_lease_ms > 300000 THEN
    RAISE EXCEPTION 'notification email lease must be between 1000 and 300000 milliseconds' USING ERRCODE = '22023';
  END IF;

  UPDATE public.outbox_messages AS expired
  SET status = 'unknown',
      last_error = 'outbox lease expired during external delivery; provider outcome is unknown',
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = claim_time
  WHERE expired.kind = 'email'
    AND expired.dedupe_key LIKE 'notification:approval.email:%'
    AND expired.status = 'processing'
    AND expired.lease_expires_at <= claim_time;

  RETURN QUERY
  WITH candidate AS (
    SELECT pending.id
    FROM public.outbox_messages AS pending
    WHERE pending.kind = 'email'
      AND pending.dedupe_key LIKE 'notification:approval.email:%'
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
            claimed.dedupe_key,
            claimed.provider_operation_id,
            claimed.attempts,
            claimed.max_attempts,
            claimed.fencing_token,
            claimed.lease_owner,
            claimed.lease_expires_at;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbox_worker.claim_notification_email(text, integer) FROM PUBLIC;
