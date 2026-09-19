# Gates: STOCK - stock-ledger immutability at commit time (ADR 0052 extension)

OWNS: packages/db/drizzle/0049_stock_ledger_immutability.sql, packages/db/drizzle/meta/_journal.json, packages/db/src/roles.ts, packages/db/src/ledger-maintenance.ts, packages/db/src/stock-guards.test.ts, modules/inventory/src/service.test.ts, apps/web/src/server/analytics.test.ts, docs/W0_EVIDENCE_REGISTER.md, CHANGELOG.md

Scope: quantity truth joins the financial ledger as append-only. Inserts (including compensating reversal movements) are ordinary writes; UPDATE, DELETE, and TRUNCATE refuse outside the declared maintenance context and succeed inside it; the runtime role holds the same append-only privilege shape as the journal tables; every teardown that removes stock history does so through the declared purge helper.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-STOCK.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] STOCK-G1: appending movements - including compensating reversals - stays an ordinary write, while UPDATE, DELETE, and TRUNCATE refuse outside the maintenance context and a declared-maintenance delete succeeds
  CHECK: pnpm --filter @chaste/db exec vitest run src/stock-guards.test.ts
  EXPECT: /Tests\s+3 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=96d8f214bbe7f7ad8b73e5a70d76ed1e57cc9656c2e054ab4cc924d9dca2ff6e; output-bytes=23792

- [x] STOCK-G2: the runtime role chaste_app cannot UPDATE, DELETE, or TRUNCATE stock_movements, and the RLS conformance sweep passes with the extended append-only set
  CHECK: pnpm --filter @chaste/db exec vitest run src/runtime-role.test.ts src/rls-conformance.test.ts
  EXPECT: /Test Files\s+2 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=b63971aefc0210d5420df41c05c980490f18cffd5387fa1533aaacac58cc76a6; output-bytes=23843

- [x] STOCK-G3: the inventory module suites (service, valuation, transfers) and the seeded analytics/degradation suites pass with purge-through-maintenance teardowns
  CHECK: pnpm --filter @chaste/module-inventory exec vitest run && pnpm --filter web exec vitest run src/server/analytics.test.ts src/server/degradation.test.ts && echo STOCK-TEARDOWNS-OK
  EXPECT: STOCK-TEARDOWNS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=d9d05360a0bf1f52f212a8cb9b0318b0f6f35f29371998f22b3babbcd0bdbd60; output-bytes=76842

- [x] STOCK-G4: repo verification gate - typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck >/dev/null 2>&1 && pnpm lint >/dev/null 2>&1 && pnpm test >/tmp/kilo/gate-stock-test.log 2>&1 && echo REPO-GATE-OK || { tail -30 /tmp/kilo/gate-stock-test.log; exit 1; }
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0c6e5dc74929b6f125a6dfc551264ea8e2e1ad046a1b29c7937ae29c3cc6b215; output-bytes=13

- [x] STOCK-G5: the W0 evidence register records the stock-immutability delivery and the CHANGELOG records the behavior change
  CHECK: grep -q "stock" docs/W0_EVIDENCE_REGISTER.md && grep -qi "stock ledger" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
