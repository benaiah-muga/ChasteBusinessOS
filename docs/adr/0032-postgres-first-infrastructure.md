# ADR 0032: Postgres-first infrastructure

Date: 2026-08-29
Status: Accepted

## Context

Chaste already runs on PostgreSQL 16 for everything relational, with pgvector
for org memory. The ecosystem offers a Postgres-native answer for nearly
every piece of auxiliary infrastructure a project like this usually accretes:

- **Queues**: `pgmq`, or a hand-rolled `FOR UPDATE SKIP LOCKED` table (we
  have the latter in production since the M6 hardening milestone).
- **Scheduling**: `pg_cron` inside the database, an external scheduler, or an
  application worker.
- **Full-text search**: `tsvector`/`tsquery` with GIN indexes; approximate
  matching via `pg_trgm`.
- **Caching**: unlogged tables, materialized views, or `hstore`/`jsonb`
  caches, versus Redis.
- **Pub/sub**: `LISTEN/NOTIFY`.

Each standalone service (Redis, RabbitMQ, Meilisearch, a cron sidecar) is
one more thing to deploy, back up, secure, and monitor — for a product whose
deployment story is "docker compose and go". But Postgres is not free of
costs either: long-running queries hurt OLTP, extensions need
superuser/maintenance windows, and some workloads (fan-out fan-in, large
payloads, multi-region) genuinely outgrow it.

## Decision

**Postgres is the default substrate; a new dependency must name the
workload Postgres cannot do before it is admitted.** Concretely:

1. **Job queue stays the hand-rolled `jobs` table** (SKIP LOCKED, attempts,
   dead-letter via `failed`). We evaluated `pgmq`: its value is
   high-throughput message semantics (visibility timeouts, archival
   partitions, read CTIs). Our jobs are low-volume, capability-shaped, and
   want relational observability (SELECT * FROM jobs in the same transaction
   as domain data). `pgmq` would add a schema and an extension to operate for
   zero gained invariants. Revisit only if job volume or payload size grows
   by orders of magnitude.
2. **Scheduling stays an application worker tick** (2s poll), with routines
   (ADR 0031) claimed via SKIP LOCKED. `pg_cron` was considered: it would
   remove the idle poll, but it runs statements as the database user, which
   cannot execute capabilities — the worker is where governance lives. A
   future optimization is `LISTEN/NOTIFY` to wake the worker on enqueue
   instead of polling; not needed at current volume.
3. **Text search adopts `pg_trgm` now.** Migration 0028 creates the
   extension and a GIN trigram index on `memories.content`, so the existing
   ILIKE fallback for semantic-search misses goes from sequential scans to
   index lookups. `tsvector` full-text (ranking, stemming, weightings) is
   the next step **if** keyword search quality becomes a complaint; trigram
   covers substring/typo-tolerant matching, which is what document recall
   needs first.
4. **Caching stays in the application for now.** The capability registry is
   cached per process; read-heavy dashboard aggregates are candidates for a
   materialized view before any cache server is considered. Redis is
   explicitly rejected for v1: nothing needs sub-millisecond shared state,
   and session/auth state is already relational (better-auth).
5. **`LISTEN/NOTIFY`** is approved for future use (worker wake-ups,
   in-process invalidation) since it needs no new infra. It is not wired
   yet: the 2s poll is invisible at current scale.

## Consequences

- Deployment stays "Postgres in a container and the app", which is the whole
  point: an ERP customer's ops team runs one database, not six services.
- Every adoption above is reversible at the seams: the queue is behind
  `enqueueCapabilityJob`/`processOneJob`; search behind two capability
  implementations; scheduling behind the worker loop.
- The risk to watch is coupling OLTP latency to background work on one
  instance. If background jobs degrade point-of-sale latency at customer
  scale, the answer is partitioning the worker onto a replica / dedicated
  instance first, and only then a separate store.
