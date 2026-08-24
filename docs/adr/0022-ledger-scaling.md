# 0022 - Event ledger scaling: per-org chain heads and time partitioning

Date: 2026-08-24
Status: Accepted (design; implementation deferred)

## Context

The audit ledger uses a single global hash chain serialized by an advisory
lock (ADR 0020 fixed its fork-under-concurrency defect). Two scaling limits
remain:

1. **Throughput**: all tenants' audit writes contend on one chain tail. The
   lock is held for microseconds so this is tolerable for years, but it caps
   horizontal scale by design.
2. **Cross-tenant coupling**: every entry's hash depends on all prior global
   entries, including other orgs' activity. Auditors of tenant A must
   conceptually trust that no other tenant's traffic altered A's chain
   positions, and GDPR reviewers may read hash dependencies as data sharing.

## Decision

When write volume or compliance review demands it, switch to **per-org chain
heads**: each org's `prevHash` follows only its own previous entry.

- Schema: replace the advisory-lock-on-global-tail with a `ledger_heads`
  table keyed by `org_id`, updated inside the same transaction as the insert
  (`SELECT ... FOR UPDATE` on the head row). No cross-tenant locking remains.
- Verification: chain verification becomes per-org; the viewer groups by org
  already, so UI changes are minimal.
- Migration of history: existing entries keep their global-chain hashes;
  each org's first new entry anchors a fresh segment whose `prevHash` is the
  last hash *that org* observed. Verifiers accept both segment roots during a
  documented transition window.
- Volume: once per-org heads exist, declarative range partitioning of
  `ledger_events` by `occurred_at` (monthly) becomes safe; old partitions can
  move to cheaper storage or be exported with their chain segments intact.

## Why not now

Current write volume is orders of magnitude below the limit, and the fix
touches immutable-data semantics best done deliberately, not opportunistically.
