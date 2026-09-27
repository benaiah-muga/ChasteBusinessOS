# ADR 0070: Migrate the React UI to Vite and business runtime to Go

Date: 2026-09-27
Status: accepted direction, implementation underway and gated by parity

## Context

The current React UI runs on Next.js 16.3. Business routes, capability
implementations, agent orchestration, and background workers run in
TypeScript. The owner wants faster development builds, strong compile-time
typing across the API boundary, and a Go backend while preserving the ERP's
existing behavior and data. The system has a single governed execution path,
PostgreSQL RLS, immutable postings, hash-chained audit, and durable jobs.
A mechanical route rewrite would break those guarantees.

## Decision

- Use Vite to build the React browser app and Go for business APIs, domain
  modules, the capability kernel, agent runtime, and workers.
- Keep one public origin and the existing HTTP paths during migration. Publish
  a versioned API contract and generate typed Go and TypeScript bindings.
- Keep PostgreSQL, its data, RLS policies, ledger tables, and migration history.
  Port the transaction, audit, approval, and receipt behavior before moving
  a business write.
- Give each capability one active writer. Route unported actions to the legacy
  runtime; switch ownership only after parity and rollback evidence. Never
  shadow or dual-write production mutations.
- Preserve existing Better Auth credentials and sessions through a temporary
  auth bridge. Port auth to Go only when current passwords, cookies, verified
  identity binding, org selection, and permissions pass compatibility tests.
- Keep the demo commands and their assertions, but adapt their current direct
  TypeScript registry calls to exercise Go. Declare cutover complete only
  when all business APIs, workers, and auth run without the Next.js or
  TypeScript server.

## Consequences

The migration is a multi-phase port of domain behavior, not a quick frontend
build-tool change. Go and TypeScript coexist during the transition, so a
versioned ownership manifest and strict schema compatibility are required.
The auth bridge may remain longer than business APIs if session compatibility
needs more work. Browser types improve through generated contracts, while Go
must still validate all untrusted input at runtime. Development-speed claims
require measured baselines. The executable plan and cutover gates are in
`docs/REACT_GO_MIGRATION_PLAN.md`.
