# Gates: N11 — one document-balance contract, locked money application

OWNS: packages/erp-core/src/aging.ts, packages/erp-core/src/aging.test.ts, modules/accounting/src/balance-reconciliation.test.ts, modules/accounting/src/signals.ts, modules/accounting/src/index.ts, modules/purchasing/src/index.ts, apps/web/src/server/balances.ts, apps/web/src/server/n11-reconciliation.test.ts, apps/web/src/app/api/accounting/route.ts, apps/web/src/app/api/dashboard/route.ts, apps/web/src/app/api/purchasing/route.ts, apps/web/src/app/api/portal/invoice/[token]/route.ts, docs/W0_EVIDENCE_REGISTER.md, CHANGELOG.md

Scope: the credit-adjusted document balance (already the payment gate) becomes the one outstanding every surface shows — module lists, AR aging, FX exposure, overdue signals, dashboard, accounting and purchasing pages, customer portal — money application serializes per document so simultaneous payments cannot race the cap, and collections aging runs from the due date with an explicit as-of instant.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-N11.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] N11-G1: the pure contract ages collections from the due date (not-yet-due stays current), buckets partition exactly, and the erp-core suite passes
  CHECK: pnpm --filter @chaste/erp-core exec vitest run src/aging.test.ts src/document-balance.test.ts
  EXPECT: /Tests\s+13 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=ddbb8ac2e1578cd3c009818ff7c744e3062695e960c6c2892aefe309586667c6; output-bytes=348

- [x] N11-G2: two simultaneous payments that are each valid alone but not together serialize on the document lock — exactly one commits, the loser is refused with the outstanding cap, and the stored paid amount equals the single winner
  CHECK: pnpm --filter @chaste/module-accounting exec vitest run src/balance-reconciliation.test.ts
  EXPECT: /Tests\s+4 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2d74dc53c39da8e80b4eb997ae6f93910b4471e80200a0ab3a3e3b6d5a5d0666; output-bytes=23808

- [x] N11-G3: module surfaces chase the credit-adjusted balance — listInvoices, arAging (past-due buckets), unrealizedFxExposure — and the full accounting and purchasing suites stay green with the locks in place
  CHECK: pnpm --filter @chaste/module-accounting exec vitest run && pnpm --filter @chaste/module-purchasing exec vitest run && echo MODULES-OK
  EXPECT: MODULES-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=4177ae7259971c22e75213d94a6584af51f06c7f2ecbc724e9d7c4df6eacc7f9; output-bytes=48954

- [x] N11-G4: one seeded invoice (credited and partially paid) shows the same outstanding from the pure contract, arAging, the analytics aging capability, the support invoice lookup, and the customer portal, with credits visible rather than clamped away
  CHECK: pnpm --filter web exec vitest run src/server/n11-reconciliation.test.ts
  EXPECT: /Tests\s+5 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=1a2c8caaaa474a4afed65edd6c5325b55231de451fc46312b2329ce52f30a321; output-bytes=38242

- [x] N11-G5: no named web surface computes outstanding from raw total minus paid — the accounting, dashboard, purchasing and portal routes all route through the shared credit-adjusted helper
  CHECK: grep -L creditedMinor apps/web/src/app/api/accounting/route.ts apps/web/src/app/api/dashboard/route.ts apps/web/src/app/api/purchasing/route.ts "apps/web/src/app/api/portal/invoice/[token]/route.ts" | grep -q . && echo STALE-SURFACES || echo SURFACES-CREDIT-AWARE
  EXPECT: SURFACES-CREDIT-AWARE
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=21b9d6efa712d8dcdc5c55e82230047eec3a826d9c537e4f6819922cde03396d; output-bytes=22

- [x] N11-G6: repo verification gate — typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck >/dev/null 2>&1 && pnpm lint >/dev/null 2>&1 && pnpm test >/tmp/kilo/gate-n11-test.log 2>&1 && echo REPO-GATE-OK || { tail -30 /tmp/kilo/gate-n11-test.log; exit 1; }
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0c6e5dc74929b6f125a6dfc551264ea8e2e1ad046a1b29c7937ae29c3cc6b215; output-bytes=13

- [x] N11-G7: the W0 evidence register records the N11 delivery and the CHANGELOG records the behavior change
  CHECK: grep -q "N11" docs/W0_EVIDENCE_REGISTER.md && grep -qi "credit-adjusted" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
