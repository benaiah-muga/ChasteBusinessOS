# ADR 0082: Verified-session organization bootstrap in Go

## Status

Accepted

## Context

Workspace creation runs before a request has an organization scope. The Go
runtime role is `NOBYPASSRLS`, and ordinary business SQL must run through
`dbx.WithOrgTx`, so the runtime role cannot safely create the first
organization using its regular table access. The legacy route can create this
initial state with broader database authority, but a future Go endpoint must
derive ownership from authentication rather than accept a client-supplied user
or organization ID.

## Decision

- Put the initial organization, seed records, and bootstrap receipt in one
  narrowly scoped `SECURITY DEFINER` database function. The function accepts a
  Better Auth session token and derives the domain user and existing
  organization memberships through the trusted verified-session resolver.
- Serialize bootstrap attempts with an advisory transaction lock derived from
  that verified user. Matching intent and payload replays return the original
  organization; conflicting payloads fail; a second distinct bootstrap is
  rejected after a membership exists.
- Set `app.org_id` transaction-locally to the generated organization before
  inserting organization-scoped rows. Keep the function owner in the
  dedicated `chaste_bootstrap_owner` role, configured `NOLOGIN`, `NOINHERIT`,
  and `NOBYPASSRLS`, with no role memberships and only the required table
  privileges. Pin `search_path` to `pg_catalog`, revoke execution from
  `PUBLIC`, and grant execution only to `chaste_app`.
- Expose creation through the fixed `iam.bootstrapOrganization` capability
  and a separate pre-organization Go executor entrypoint. Its shared
  `executionScope` classification prevents ordinary organization execution
  and agent tool discovery from dispatching the capability. The entrypoint
  checks the live verified session against the HTTP resolver identity, calls
  the database function, verifies the returned organization has the session
  user's membership and intent receipt, and appends `organization.created`
  only for a first execution in the same transaction. The event records the
  Better Auth session in a separate nullable `auth_session_id` reference,
  distinct from the agent-only `session_id`; non-null auth-session attribution
  is included in the hash material. This is a bounded text reference without a
  foreign key: sign-out deletes auth-session rows, and `ON DELETE SET NULL`
  would rewrite hash-covered historical ledger data, while `RESTRICT` would
  prevent sign-out. The executor revalidates the live verified session in the
  transaction immediately before appending the event. Embedding upgrade runs
  best-effort after commit.
- The capability has no inverse. Deleting the initial organization would
  invalidate its immutable creation event and receipts, and would erase the
  first owner relationship needed to govern the workspace. Future workspace
  closure must be a separate lifecycle action that retains audit history.
- Before routing the public endpoint to Go, make legacy bootstrap calls share
  this serialization boundary or remove that route. A simultaneous legacy
  call with a different intent does not acquire the function's advisory lock.

## Consequences

The migration principal must be able to provision and assign the restricted
function owner. Migration fails atomically if it cannot establish that
boundary. The Go handler remains opt-in until Vite routing changes and legacy
bootstrap shares the same serialization boundary or is removed; otherwise a
simultaneous legacy request with a different intent can race the Go path.
