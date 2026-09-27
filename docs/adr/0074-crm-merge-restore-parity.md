# ADR 0074: Preserve the CRM merge restore contract during runtime migration

Status: accepted for migration parity
Date: 2026-09-27

## Context

`crm.restoreCustomerMerge` accepts customer snapshots supplied in the request.
It verifies that every referenced customer exists in the active organization,
then restores the snapshot fields. It does not prove that the snapshot came
from a prior merge or check whether the customer profile changed since that
merge. A caller with `crm.write` can overwrite later profile changes or
reactivate same-organization records using a caller-created snapshot.

The React and Go migration must preserve existing behavior, including inverse
actions, audit history, and agent flows. Tightening this capability in only one
runtime would change behavior during the language migration and make rollback
inconsistent.

## Decision

The Go implementation preserves the current snapshot schema, organization
check, restored fields, and inverse output. The user-supplied behavior
preservation requirement applies to this action. No new snapshot authenticity
or drift check is introduced as part of the runtime port.

Record the snapshot trust gap as known risk in Go and TypeScript parity
fixtures. Any hardening is a separate, versioned behavior change that updates
both runtimes and its callers together.

## Consequences

- The migration does not silently narrow the ability of `crm.write` callers to
  invoke merge restore.
- The behavior needs a golden test for exact snapshot restoration and inverse
  output, alongside organization isolation, permission, and audit tests.
- A later hardening proposal should consider an opaque server-generated merge
  receipt or version check, specify compatibility for existing snapshots, and
  add tests proving that unrelated rows and later profile edits cannot be
  overwritten.
- This decision does not relax the route cutover gates for approval decisions,
  agent-tool dispatch, audit failure outcomes, or public API parity.
