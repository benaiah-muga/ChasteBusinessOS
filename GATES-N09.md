# Gates: N09 - commit-time ledger enforcement

OWNS: packages/db/drizzle/0046_*.sql, packages/db/drizzle/meta/_journal.json, packages/db/src/ledger-maintenance.ts, packages/db/src/index.ts, packages/db/src/roles.ts, packages/db/src/journal-guards.test.ts, packages/db/src/runtime-role.test.ts, packages/db/src/rls-conformance.test.ts, packages/db/src/rls.test.ts, modules/pos/src/index.ts, apps/web/.w0-probes/probe-n09.mts, docs/adr/0052-commit-time-ledger-enforcement.md, docs/W0_EVIDENCE_REGISTER.md, CHANGELOG.md

Scope: migrations enforce at commit time what application code merely asserts - journals must balance, entries must be complete, lines must be single-sided and same-tenant, posted journal rows and the event ledger must be immutable, and the runtime role must hold append-only privileges; every refusal has a declared maintenance escape used only by teardown/repair.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-N09.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] N09.1-G1: on a clean migrated fixture DB the commit-time guards refuse an unbalanced entry, a single-line entry, a zero-line entry, and a line whose account belongs to another org; they accept a valid balanced multi-line entry, its governed reversal, and re-check balance when a line is added to an existing entry
  CHECK: pnpm --filter @chaste/db exec vitest run src/journal-guards.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=90819fcc5e68f8b9ed8c9329be3f9a4807232bf6d3d25f5b103709b2ab1d2acf; output-bytes=54560

- [x] N09.2-G1: posted journal rows and event-ledger rows refuse UPDATE, DELETE, and TRUNCATE outside the declared maintenance context, and every guarded delete succeeds inside it
  CHECK: pnpm --filter @chaste/db exec vitest run src/journal-guards.test.ts
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=357feb230696200705e84943d5a9b7169bce1b3891f4594151e4c01910e32ae9; output-bytes=54338

- [x] N09.3-G1: the runtime role chaste_app cannot UPDATE, DELETE, or TRUNCATE journal_entries, journal_lines, or ledger_events, and an ensureAppRole re-run restores that revocation after a broad grant
  CHECK: pnpm --filter @chaste/db exec vitest run src/runtime-role.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=4ca09a7ee6d4a0e8b4492fe3ea3128e1c5fd3caec87b4ec57011427877d1cb5f; output-bytes=23549

- [x] N09.4-G1: the RLS conformance sweep passes with the append-only carve-out and now asserts the runtime role lacks mutation rights on the append-only set
  CHECK: pnpm --filter @chaste/db exec vitest run src/rls-conformance.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0935a974bf4304c55154ec1edfcb80ae53bc78d2ad4dbe7e9da184e7acae4d7a; output-bytes=23552

- [x] N09.5-G1: the N09 probe no longer reproduces - against a fresh fixture DB it reports the discharged state (triggers present, unbalanced commit refused, posted-line mutation refused)
  CHECK: pnpm exec tsx apps/web/.w0-probes/probe-n09.mts
  EXPECT: N09 DISCHARGED
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=b6923b84d2a6d737f12212eba0a37cc185c5a6d69a58b4a4630a1de15a868ca1; output-bytes=23701

- [x] N09.6-G1: the POS sale path posts the entry with its invoice link at insert time - no post-hoc journal UPDATE - and the full POS suite (sales, returns, inverse, oversell, shifts) stays green
  CHECK: pnpm --filter @chaste/module-pos exec vitest run
  EXPECT: /Test Files\s+\d+ passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=78425325f602417c54472558bc9b8ba796620134478bfe11656ffb63ae607c07; output-bytes=23623

- [x] N09.7-G1: every suite that tears down journal or ledger rows uses the declared maintenance helper, and the affected module suites (accounting, inventory, sales, purchasing, hr) pass
  CHECK: pnpm --filter @chaste/module-accounting exec vitest run && pnpm --filter @chaste/module-inventory exec vitest run && pnpm --filter @chaste/module-sales exec vitest run && pnpm --filter @chaste/module-purchasing exec vitest run && pnpm --filter @chaste/module-hr exec vitest run && echo AFFECTED-MODULES-OK
  EXPECT: AFFECTED-MODULES-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=250f6b6fb5fb612673728d1e719ed6991d2ad1c5bd56aaeb28087fdbf4aa5fe6; output-bytes=119526

- [x] N09.8-G1: repo verification gate - typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck && pnpm lint && pnpm test && echo REPO-GATE-OK
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=49a538f27fa2327472c5771f298a0adf928fcc7b66f100b9f43993803d394c59; output-bytes=990496

- [x] N09.9-G1: the W0 evidence register marks N09 resolved with anchors, the CHANGELOG records the behavior change, and ADR 0052 records the enforcement design and the maintenance-context decision
  CHECK: grep -q "resolved" docs/W0_EVIDENCE_REGISTER.md && grep -q "N09" CHANGELOG.md && ls docs/adr/0052-*.md >/dev/null && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
