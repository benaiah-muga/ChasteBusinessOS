# 0020 - Trust-spine hardening: atomic approvals, verified gates, declared money amounts

Date: 2026-08-24
Status: Accepted

## Context

A principal-level architecture review found three defects that invalidated the
product's core promise ("the harness disposes; enterprises can trust it"):

1. **Approval double-execution.** The approve route read the row, checked
   `pending`, executed, then updated status. Two concurrent approvers could
   both pass the check; gated money moved twice.
2. **Hash-chain fork under concurrency.** The event ledger computed each
   entry's `prevHash` from a separate non-transactional read of the chain
   tail. Concurrent appends chained off stale hashes, silently breaking the
   tamper-evidence guarantee.
3. **Fail-open money gating.** The policy engine inferred the governing amount
   by finding the largest input field named `*Minor`. An input that named its
   amount anything else bypassed thresholds entirely.
4. **Caller-trust approval bypass.** The executor accepted any
   `approvedApprovalId` without checking it matched the capability or payload.
5. **RLS never invoked.** `withOrgContext()` existed but no capability used
   it; tenant isolation rested on hand-written `orgId` predicates alone.
6. **Divergent posting logic.** Four private copies of the period-open guard
   and six copy-pasted entry+lines insert blocks had already drifted apart.

## Decision

- **Approvals are claimed, then executed.** `decideApproval`
  (`apps/web/src/server/approvals.ts`) transitions the row atomically
  (`UPDATE ... WHERE status = 'pending'`) to `executing` before execution,
  finalizing to `executed` / `failed`. Losers get 409. A crash between claim
  and finalize leaves `executing`, which is visible state to re-drive, never
  silent double-fire.
- **The kernel verifies claimed approvals.** `ApprovalFlow.verify()`
  confirms org, capability, claimable status, and canonical-payload equality;
  the executor refuses unverified ids and fails closed when `verify` is
  unimplemented. Callers are never trusted.
- **Money amounts are declared.** `Capability.moneyAmount(input)` extracts
  the gating amount from validated input; conformance rejects `risk:"money"`
  capabilities without one. `null` (amount unknowable up front, e.g.
  reversals) gates unconditionally: fail closed.
- **Ledger appends are serialized per transaction.** `PgLedgerStore.append`
  takes a transaction-scoped advisory lock before reading the head and
  inserting, so the chain can never fork.
- **Capabilities run inside tenant scope.** All module transactions go
  through `withOrgContext(db, ctx.actor.orgId, ...)`, setting `app.org_id`
  for RLS; application-level predicates remain as defense in depth.
- **One posting service.** `@chaste/module-accounting/posting` owns period
  guard, COA resolution, balance assertion, and entry+line insertion. Cross-
  module imports (hr/pos/purchasing) are deliberate: posting is accounting's
  bounded context.

## Consequences

- Approvals gain transient `executing` / `failed` states; the inbox shows
  pending only, so crashed claims need manual re-drive (acceptable vs. silent
  double-payment).
- jsonb normalizes key order, so payload comparison uses sorted-key
  canonical JSON on both sides.
- New money capabilities must declare `moneyAmount` or refuse to boot; this
  is the same staged-fatal posture as inverse conformance.
