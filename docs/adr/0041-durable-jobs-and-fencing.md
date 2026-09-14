# 0041 - Durable jobs use leases, fencing and occurrence idempotency

Date: 2026-09-14
Status: Accepted

## Context

The Postgres-backed queue claimed rows as `processing` but had no lease. A
worker crash could strand a job indefinitely, and a late worker had no
authoritative boundary preventing it from finalizing a reclaimed row. Recurring
invoice expansion also had no durable identity for a scheduled occurrence.

## Decision

Queue rows now carry `available_at`, `lease_owner`, `lease_expires_at` and a
monotonically increasing `fencing_token`. Claims include pending work that is
available and processing work whose lease has expired. Heartbeats renew only
the matching owner/token pair. Completion and retry updates use the same
owner/token predicate, so a late worker cannot acknowledge or overwrite a
reclaimed job. Retryable failures return to `pending` with capped exponential
backoff; exhausted expired leases become terminal `failed` rows.

Every queued capability receives the job id as its governed action intent, so a
redelivery can replay an existing effect receipt instead of posting a second
business effect. External effects still require a separate outbox/provider
receipt contract; this decision does not claim exactly-once delivery outside
the database.

Recurring invoice expansion creates a row in `recurring_invoice_runs` keyed by
`(org_id, recurring_invoice_id, scheduled_for)`, posts the invoice, marks the
occurrence complete and advances the template in one transaction. The unique
key is a second line of defense alongside row locking and makes a repeated
scheduled instant a no-op.

## Consequences

- Worker crashes become reclaimable after the lease expires.
- A stale worker may finish its in-flight computation, but its queue receipt
  update is fenced and queued capability retries use the action receipt.
- Backoff prevents a bad dependency or payload from being hammered.
- Recurring schedules advance from the scheduled occurrence, preserving
  calendar semantics and avoiding duplicate invoices.
- Queue-wide fairness, waiting-approval states, external outboxes and durable
  agent-run checkpoints remain follow-up B03/B04 work.
