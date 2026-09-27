# ADR 0075: Go webhook outbox worker privilege boundary

Status: accepted

## Context

The existing outbox contains tenant payloads for both webhooks and email. A
dispatcher must claim work across organizations, but a normal NOBYPASSRLS
connection has no global tenant context. A worker also must not gain access to
the rest of the ERP database or to email payloads.

## Decision

- Run webhooks in a separate Go executable using the dedicated
  `chaste_outbox_worker` login. It is NOBYPASSRLS, has no role memberships, and
  receives only the outbox columns needed for webhook payload reads and fenced
  status updates.
- Every payload read, acknowledgement, lease check, and unknown-outcome
  reconciliation runs inside `dbx.WithOrgTx`. The existing tenant policy
  scopes the login to `app.org_id`; a restrictive policy also hides email rows
  from this role.
- A separate `chaste_outbox_claim_owner` NOLOGIN, NOBYPASSRLS role owns the
  fixed-search-path SECURITY DEFINER claim function. Its only table privileges
  are column-level reads and updates required to reap expired webhook leases
  and claim one due webhook with `FOR UPDATE SKIP LOCKED`. It cannot read the
  payload column or access other tables.
- The claim function returns lease metadata only. PUBLIC and `chaste_app`
  cannot execute it; provisioning grants execute only to the dedicated worker
  login. The migration does not grant the new roles until the runtime-role
  provisioner has set their attributes, ownership, and exact ACLs.
- Provider operation IDs remain stable across retries and are sent as the
  idempotency key. Successful responses become sent, 429 responses return to
  pending with the legacy 1 to 300 second retry clamp, other 4xx responses
  become failed, and 5xx or transport failures become unknown. Expired
  processing leases also become unknown, never pending, so uncertain external
  effects are not blindly resent. Only an org-scoped reconciliation can settle
  an unknown webhook.
- Email, durable jobs, and routines remain outside this executable and keep
  their existing dispatcher until their own migration proofs pass.

## Consequences

Provisioning requires the migration/admin connection to create the roles and
transfer the function owner. The worker requires `OUTBOX_WORKER_DATABASE_URL`
and the provisioner requires `CHASTE_OUTBOX_WORKER_DB_PASSWORD`. The Go proof
checks both role catalogs and the behavior of row-level security, fencing,
provider responses, retry idempotency, and reconciliation against PostgreSQL.

The database still provides at-least-once delivery. Provider idempotency keys
and the unknown state make crash windows explicit, but cannot guarantee that a
third-party provider honors idempotency.
