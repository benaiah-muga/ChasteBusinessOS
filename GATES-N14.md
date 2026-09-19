# Gates: N14B - bank-reconciliation allocation model and the reconciled definition

OWNS: packages/db/drizzle/0050_bank_allocations.sql, packages/db/drizzle/meta/_journal.json, packages/db/src/schema/index.ts, packages/erp-core/src/bankrec.ts, packages/erp-core/src/bankrec.test.ts, modules/accounting/src/index.ts, modules/accounting/src/bank-matching.test.ts, modules/accounting/src/bankrec.test.ts

Scope: a statement line is explained by explicit allocations - a payment (whole, partial split, or grouped with other payments), a journal entry, a reviewed fee, or an FX difference - that share the line's sign and fit inside its amount; payment and entry claims are enforced transactionally by row locks and remaining-amount budgets instead of unique single-claim indexes; a statement period is reconciled when the unexplained difference is exactly zero, and `accounting.bankReconciliation` reports that number per line and per period.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-N14.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] N14B-G1: the pure allocation math conserves money - allocations never exceed the line or the payment, opposite-direction slices refuse, splits may consume a payment exactly, excluded lines carry nothing, and reconciled means zero unexplained
  CHECK: pnpm --filter @chaste/erp-core exec vitest run src/bankrec.test.ts
  EXPECT: /Tests\s+8 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=f481932736451b2e9a3ed63ef1501f115f185573fb95db5abb3ddb8d67b65c7e; output-bytes=297

- [x] N14B-G2: the equivalence floor holds under the allocation model - exact matches succeed, amount/direction/currency mismatches refuse, a payment's remaining amount caps its claims, unmatching restores availability, and an entry cannot be double-explained
  CHECK: pnpm --filter @chaste/module-accounting exec vitest run src/bank-matching.test.ts
  EXPECT: /Tests\s+6 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=9fee2ea700aa0f26e6926646e604208f99759e041c6716827fe5464ef6310ecd; output-bytes=24180

- [x] N14B-G3: reviewed fees and FX differences explain gaps explicitly, grouped settlements land several payments on one line, unmatch releases fee allocations too, and the reconciliation capability flips to reconciled=true only at zero unexplained difference
  CHECK: pnpm --filter @chaste/module-accounting exec vitest run src/bankrec.test.ts
  EXPECT: /Tests\s+6 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=942040986538a6281a97ef4c66df39eaadc39ba35b86e649d731947ba2f52eab; output-bytes=24147

- [x] N14B-G4: the migration builds the allocation table with tenant-isolation RLS, backfills existing single-claim matches as full-amount allocations, and retires the claim columns and indexes - the RLS conformance sweep passes
  CHECK: pnpm --filter @chaste/db exec vitest run src/rls-conformance.test.ts
  EXPECT: /Tests\s+1 passed|passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=a9826d5cd4084d5cc203790c3efb7f3c7b13c08a536e19ada3b7639b5f889eaa; output-bytes=24037

- [x] N14B-G5: repo verification gate - typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck >/dev/null 2>&1 && pnpm lint >/dev/null 2>&1 && pnpm test >/tmp/kilo/gate-n14-test.log 2>&1 && echo REPO-GATE-OK || { tail -30 /tmp/kilo/gate-n14-test.log; exit 1; }
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0c6e5dc74929b6f125a6dfc551264ea8e2e1ad046a1b29c7937ae29c3cc6b215; output-bytes=13

- [x] N14B-G6: the evidence register records the allocation-model delivery and the CHANGELOG records the behavior change
  CHECK: grep -q "bank_allocations" docs/W0_EVIDENCE_REGISTER.md && grep -qi "statement line" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
