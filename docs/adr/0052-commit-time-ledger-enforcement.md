# ADR 0052: Commit-time ledger enforcement with a declared maintenance context

Status: Accepted

Date: 2026-09-16

## Context

The audit's N09 finding (Module Audit §2, reproduced by
`apps/web/.w0-probes/probe-n09.mts`) was structural: no migration created a
trigger or constraint that enforced the two rules the architecture prose
claims as database-guaranteed. "Debits equal credits" lived only in
`erp-core`'s `assertBalanced`, called by the posting service; "posted
financial documents are immutable" lived only in convention. A probe on a
clean fixture database committed a 10000/5000 entry, updated a posted line
and deleted another - the books' defining invariants had no negative proof
below the application layer. Any future write path that skipped the posting
service (a new module, a migration, a hand-written route) could silently
break the ledger.

## Decision

Migration 0046 enforces at commit time what application code used to assert:

1. **Line shape** (CHECK constraints, validated): amounts nonnegative, a
   line is single-sided, a line is nonzero - the same rules as
   `assertBalanced`, now un-bypassable.
2. **Balance and completeness at commit** (deferred constraint triggers):
   an entry must carry at least two lines, `sum(debit) = sum(credit) > 0`,
   and every line's account must belong to the entry's org. Deferred means
   the check sees the entry as it commits, not as each statement runs, so
   the posting service's insert-then-lines sequence is unaffected and
   intra-transaction staging never produces false refusals.
3. **Append-only storage**: `UPDATE`/`DELETE`/`TRUNCATE` on
   `journal_entries`, `journal_lines`, and `ledger_events` are refused by
   triggers; corrections are reversal entries (ADR 0049/0051), never edits.
   The runtime role additionally loses `UPDATE`/`DELETE`/`TRUNCATE` on these
   tables (`APPEND_ONLY_TABLES` in `@chaste/db/roles`, re-revoked after
   every `ensureAppRole` grant), and the RLS conformance sweep now asserts
   that absence mechanically.
4. **One declared escape hatch**: teardowns and out-of-band repairs opt out
   per transaction by setting `app.ledger_maintenance = 'on'` through
   `beginLedgerMaintenance`/`purgeTenantFinancials` (`@chaste/db`). Every
   use is a greppable, intentional act; the runtime application never sets
   it. The immutability guards honor the context; the balance, completeness
   and tenancy guards do not - maintenance may delete history, but nothing
   broken can ever commit. A repair that must re-add rows stages balanced
   rows or leaves them out.

The POS sale path was the one legitimate writer that mutated the journal
after insert (patching `sourceId` after the invoice row existed). It now
inserts the invoice before posting, so the entry carries its source link at
insert time - the patch path no longer exists anywhere in production code.

## Consequences

- Fixture teardowns go through `purgeTenantFinancials` instead of hand-rolled
  journal/event deletes; deleting an organization whose journal rows remain
  would otherwise be refused (the cascade fires the immutability triggers).
- A dirty legacy database fails migration 0046's validation stage with the
  offending entry ids named - reconcile or quarantine deliberately, never
  silently rewrite history (N09 migration protocol).
- `assertBalanced` stays: it produces domain-level error messages before any
  SQL runs. The database guard is the backstop, not the UX.
- Stock-ledger immutability (`stock_movements`) is a deliberate follow-up:
  same mechanism, separate slice, after its writers are audited the way the
  journal's were.

## Proof

`packages/db/src/journal-guards.test.ts` runs the audit's negative proofs
against a clean fixture database: unbalanced, single-line, line-less and
cross-org commits refused; posted rows and event-ledger rows refuse
mutation, deletion and truncation outside maintenance; valid entries,
governed reversals, and declared maintenance teardowns succeed. The
runtime-role suite pins the privilege boundary including survival across
`ensureAppRole` re-grants; the conformance sweep pins it mechanically for
future tables. The probe asserts the discharged state on a fresh fixture.
