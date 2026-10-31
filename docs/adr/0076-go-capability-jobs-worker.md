# ADR 0076: Go capability jobs worker

Status: accepted

## Context

The durable jobs table contains tenant payloads for capability work and agent
run links. The Go API has executor support for some capabilities, while the
TypeScript worker still owns routines and capabilities without an established
Go executor. A global queue claim needs to choose only work the Go worker can
execute without making tenant payloads globally visible.

## Decision

- Add a standalone Go jobs worker, but keep the TypeScript jobs worker as the
  only default. Operators must explicitly start the Go command; both workers
  must not claim the same capability set concurrently.
- Maintain a reviewed allowlist of capability IDs backed by the Go executor.
  The SQL claim function and Go worker allowlist must stay aligned. Routine
  and document jobs remain TypeScript-owned.
- Use a dedicated `chaste_jobs_worker` login with no role memberships,
  `NOINHERIT`, and `NOBYPASSRLS`. It can read payload and update lease fields
  only within a transaction that sets `app.org_id`.
- Use a separate `chaste_jobs_claim_owner` `NOLOGIN`, `NOBYPASSRLS` role for a
  fixed-search-path `SECURITY DEFINER` global claim function. It has only
  metadata column access, and the function returns lease metadata without the
  payload. The function claims supported rows with `FOR UPDATE SKIP LOCKED`
  and increments a fencing token.
- Execute effects through `Executor.ExecuteSystem`. The caller supplies only
  organization, supported capability, exact permission, job UUID intent, and
  an optional approval ID. The executor fixes actor type to `system`, leaves
  actor and session IDs NULL, verifies approval against organization,
  capability, status, expiry, and canonical payload when policy requires it,
  and shares the governed effect, ledger, and receipt transaction.
- Keep queue claim, payload read, lease heartbeat, and acknowledgement fenced
  by owner and token. Reuse the stable job ID for action receipt replay.
  Preserve legacy retry delays, approval pauses, and linked durable run and
  step transitions.

## Consequences

The provisioner must create and constrain both worker roles and transfer
ownership of the claim function. The Go worker requires separate queue and
application runtime database URLs. Go execution is opt-in while parity proofs
are established. The queue provides at-least-once delivery; the stable
capability receipt prevents a crash after effect commit from duplicating that
effect on redelivery.
