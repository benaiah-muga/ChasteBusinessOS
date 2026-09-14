# ADR 0045: Commit scheduled routine occurrences with their jobs

Status: Accepted

Date: 2026-09-14

## Context

The scheduler previously marked a routine running, advanced its next run, and
inserted its execution job in separate operations. A crash between those
operations could lose a due run, while concurrent ticks had no durable
occurrence identity to reconcile.

## Decision

Store each scheduled occurrence in `routine_occurrences`, unique by routine and
scheduled instant. In one database transaction, lock due routines with
`SKIP LOCKED`, create the occurrence and job, link them, advance the routine,
and return the claimed work. Execution updates the linked occurrence to `done`
or `failed` together with the routine's last-run status.

## Consequences

- Competing scheduler ticks cannot create two records for the same scheduled
  occurrence.
- A scheduler crash rolls back the occurrence, job, and schedule advance
  together, allowing the occurrence to be claimed again.
- Webhook and manual triggers continue to use ordinary jobs and are not
  silently converted into scheduled occurrences.
- Mandates, lease/fencing semantics at the occurrence level, cancellation
  policy, and recipient authorization remain follow-up work.
