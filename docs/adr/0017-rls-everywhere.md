# ADR 0017, RLS everywhere: policies now, scoped role enforcement at deploy

Date: 2026-08-23
Status: Accepted

## Context

The roadmap's enterprise-hardening milestone calls for "RLS everywhere". Every
tenant table already filters by `org_id` at the application layer, but a single
buggy query could read across tenants. Defense-in-depth requires the database
itself to refuse cross-tenant rows.

## Decision

Migration `0014_rls_everywhere.sql` enables row-level security and installs a
`tenant_isolation` policy on every tenant-owned table (46 tables). Tables that
carry no `org_id` of their own (`session_events`, `journal_lines`,
`invoice_lines`, `vendor_bill_lines`, `po_lines`, `conversation_members`) get an
EXISTS policy through their parent row. `marketplace_listings` is intentionally
public-readable; writes are limited to the submitting org. `users` is visible to
co-members of one's org only.

Scoping key: `current_setting('app.org_id', true)`. The application opts into
enforcement per transaction with `withOrgContext(db, orgId, fn)` from
`@chaste/db`, which runs `set_config('app.org_id', $1, true)` inside the
transaction, SET LOCAL semantics mean the value cannot leak back into the pool.

**Enforcement model, stated honestly:** Postgres RLS always applies except to
table owners and superusers. The dev/migration connection owns the tables and
therefore bypasses RLS today; in that configuration the policies are inert but
verified-correct. Enforcement becomes real when the application connects as a
dedicated `NOBYPASSRLS` role with plain DML grants (no ownership), which is a
deployment-time change: create the role, grant, connect. `packages/db`'s
`rls.test.ts` proves policy correctness under exactly such a probe role.

## Consequences

- Cross-tenant isolation is enforced by the database for any non-owner role,
  regardless of application bugs.
- All queries must run inside `withOrgContext` when connected via the scoped
  role; unscoped reads return zero rows rather than leaking.
- Migration authoring must remember new tenant tables need the policy added.
