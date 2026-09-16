# Gates: B01/T08 — intent-keyed bootstrap, atomic setup, async embedding

OWNS: packages/db/drizzle/0048_bootstrap_intents.sql, packages/db/drizzle/meta/_journal.json, packages/db/src/schema/index.ts, apps/web/src/server/onboarding.ts, apps/web/src/server/onboarding-bootstrap.test.ts, apps/web/src/app/api/onboarding/route.ts, apps/web/src/components/onboarding/wizard.tsx, docs/W0_EVIDENCE_REGISTER.md, CHANGELOG.md

Scope: tenant creation is the one declared bootstrap exception to the governed command path, and its honesty is mechanical: a retry after a lost response replays the receipt committed atomically with the organization (keyed by user + client intent id, payload-hash conflict-checked), slug uniqueness settles inside the transaction under savepoints, the embedding call never holds the transaction hostage, and the wizard persists the intent id until the workspace exists.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-B01.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] B01-G1: the receipt commits with the org; a retry with the same intent id replays it even though the session now resolves the org; exactly one org, membership, and receipt exist; a conflicting reuse of the intent id with a different payload is refused; no intent id means the second attempt refuses as already onboarded
  CHECK: pnpm --filter web exec vitest run src/server/onboarding-bootstrap.test.ts
  EXPECT: /Tests\s+5 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=84c8dd3de5336f78b98237bc50ab9cb19892a932eaa2ab4833fc268fa0739838; output-bytes=23804

- [x] B01-G2: slug uniqueness is decided by the unique constraint inside the transaction — a bootstrap whose desired slug is taken commits with the deterministic suffixed slug instead of failing
  CHECK: pnpm --filter web exec vitest run src/server/onboarding-bootstrap.test.ts --reporter=verbose
  EXPECT: /settles slug uniqueness/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=97c9118284ef6a382bae2b77928113e6543d45d8aca9a556435e3a2f66f64ec6; output-bytes=24591

- [x] B01-G3: the embedding upgrade lands after commit — the business-profile memory ends with a real vector and the org is never lost to a provider failure
  CHECK: pnpm --filter web exec vitest run src/server/onboarding-bootstrap.test.ts --reporter=verbose
  EXPECT: /upgrades the zero-vector/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=8ec6772d646af0b1f77bd819c064a021b479f998fe43310a075d19dbe2bdae54; output-bytes=24591

- [x] B01-G4: the wizard stamps the create with a persisted intent id, retries the same id after a failed create, and clears it once the workspace exists
  CHECK: pnpm --filter web exec vitest run src/components/onboarding/wizard.test.tsx
  EXPECT: /Tests\s+19 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=487442ec119de9800c5dbd869e49aaf9aebc6b080836ace1ada456d90f569fc4; output-bytes=23932

- [x] B01-G5: the migration applies cleanly and the RLS conformance sweep still passes with bootstrap_intents in the org-scoped set
  CHECK: pnpm --filter @chaste/db db:migrate && pnpm --filter @chaste/db exec vitest run src/rls-conformance.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=76eec667ed854978250e512392f90d5c8b97b94f763c011600f6221ee55a6ab0; output-bytes=24260

- [x] B01-G6: repo verification gate — typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck >/dev/null 2>&1 && pnpm lint >/dev/null 2>&1 && pnpm test >/tmp/kilo/gate-b01-test.log 2>&1 && echo REPO-GATE-OK || { tail -30 /tmp/kilo/gate-b01-test.log; exit 1; }
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0c6e5dc74929b6f125a6dfc551264ea8e2e1ad046a1b29c7937ae29c3cc6b215; output-bytes=13

- [x] B01-G7: the W0 evidence register records the bootstrap delivery (the I1 section's standing exception is discharged) and the CHANGELOG records the behavior change
  CHECK: grep -q "B01/T08" docs/W0_EVIDENCE_REGISTER.md && grep -qi "bootstrap" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
