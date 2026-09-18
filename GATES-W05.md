# Gates: W0.5 — pilot cohort and workflow selection

OWNS: docs/w05-pilot-selection.md

Scope: the audit (§5, §6/I5) requires one pilot cohort starting with P01–P04, module-specific features only where that cohort needs them, and a measurement plan. This selection is grounded in delivered, pinned backend proofs and is recorded as the recommended default for owner confirmation.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-W05.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] W05-G1: the selection document names the cohort, the workflow chain, the first product ideas, alternatives considered, and the measurement plan
  CHECK: grep -q "Pilot cohort" docs/w05-pilot-selection.md && grep -q "Pilot workflow chain" docs/w05-pilot-selection.md && grep -q "Alternatives considered" docs/w05-pilot-selection.md && grep -q "Measurement plan" docs/w05-pilot-selection.md && echo DOC-OK
  EXPECT: DOC-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=32decc4e1abac49951887c4acfdbb44ad5b0ff8c9ae0dd3a2f00f781d6edace5; output-bytes=7

- [x] W05-G2: the recommended chain runs on delivered engines — the purchasing/inventory receipt and balance suites that power the pilot workflow pass
  CHECK: pnpm --filter @chaste/module-purchasing exec vitest run src/receipts.test.ts src/receiving.test.ts && pnpm --filter @chaste/module-inventory exec vitest run src/projections.test.ts && echo PILOT-ENGINE-OK
  EXPECT: PILOT-ENGINE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=c76df8789754df1fef4cd0d3a0a8c91ab55d74c2be71b65b60d003b9e2675111; output-bytes=50164

- [x] W05-G3: the cited proofs exist — the delivery ledgers the recommendation stands on are in the tree
  CHECK: test -f GATES-N16.md && test -f GATES-N11.md && test -f GATES-N12.md && test -f GATES-N22.md && echo PROOFS-OK
  EXPECT: PROOFS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=02cf3cb1c87fe29dd6ea26f9715f31e57f69ec8082831b2435ef8fc3741fefcd; output-bytes=10

- [x] W05-G4: repo verification gate — typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck >/dev/null 2>&1 && pnpm lint >/dev/null 2>&1 && pnpm test >/tmp/kilo/gate-w05-test.log 2>&1 && echo REPO-GATE-OK || { tail -30 /tmp/kilo/gate-w05-test.log; exit 1; }
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0c6e5dc74929b6f125a6dfc551264ea8e2e1ad046a1b29c7937ae29c3cc6b215; output-bytes=13

- [x] W05-G5: the evidence register records the selection and the CHANGELOG records it
  CHECK: grep -q "w05-pilot-selection" docs/W0_EVIDENCE_REGISTER.md && grep -qi "pilot cohort" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
