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
- Keep the function as an internal database foundation. The future Go handler
  must append `organization.created` only for a first execution and perform
  the legacy best-effort embedding upgrade after commit.
- Before routing the public endpoint to Go, make legacy bootstrap calls share
  this serialization boundary or remove that route. A simultaneous legacy
  call with a different intent does not acquire the function's advisory lock.

## Consequences

The migration principal must be able to provision and assign the restricted
function owner. Migration fails atomically if it cannot establish that
boundary. The public cutover remains incomplete until the handler preserves
the audit and post-commit embedding behavior and the legacy concurrency gap is
resolved.
