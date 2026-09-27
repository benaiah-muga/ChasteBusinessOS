# ADR 0072: Dedicated least-privilege Go database runtime role

Date: 2026-09-27
Status: accepted for migration runtime

## Context

The current database owner can bypass row-level security. The Go API will run
beside the existing application during migration, so sharing its owner URL
would make PostgreSQL tenant policies ineffective for Go queries. Adding a
tenant id to a query or transaction does not repair that missing database
boundary.

## Decision

- Keep `DATABASE_URL` or `MIGRATION_DATABASE_URL` for migrations and the
  existing application. Go receives a separate `GO_DATABASE_URL`.
- Provision the `chaste_app` role explicitly with `pnpm db:provision-runtime`.
  It must have no superuser, `BYPASSRLS`, replication, or role-membership
  privilege. Its direct table rights follow the existing least-privilege role
  contract, including append-only financial table restrictions.
- Production provisioning requires an explicit `CHASTE_APP_DB_PASSWORD`.
  The provisioner preserves TLS query options on the owner URL and repairs
  the role's password and attributes when it already exists.
- The Go API refuses to start unless its connection is exactly `chaste_app`
  and PostgreSQL reports no superuser, RLS bypass, or inherited role
  memberships. Tenant reads still set `app.org_id` with transaction-local
  scope and rely on the existing row-level security policies.
- The role changes database access controls only. It does not change schema,
  business rows, migration history, authentication records, or audit history.

## Consequences

Go cannot start with the owner credentials by accident, and the database
remains the enforcement point for tenant isolation during the transition.
Deployment must provision the role and configure its matching runtime URL
before starting Go. The old application can keep its current database owner
until its own runtime credential is migrated through a separately verified
step.
