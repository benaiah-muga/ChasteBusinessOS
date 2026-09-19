# Gates: N22B - stock projections, bin-scoped counts, and one numbering allocator

OWNS: packages/db/drizzle/0053_stock_projections.sql, packages/db/drizzle/meta/_journal.json, packages/db/src/schema/index.ts, packages/db/src/numbering.ts, modules/inventory/src/service.ts, modules/inventory/src/shared.ts, modules/inventory/src/index.ts, modules/inventory/src/projections.test.ts, scripts/n22-projection-review.ts

Scope: the stock ledger gains a `stock_balances` read projection - one row per org+item+location+lot, maintained by a database trigger so it is consistent with the ledger whatever wrote the movement - and every on-hand read (inventory, transfers, manufacturing, POS, purchasing, sales) goes through it instead of re-summing the ledger. `inventory.rebuildStockProjections` replays the ledger into the projection under the command locks. Cycle counts can scope to one location: expected quantities snapshot per bin and the adjustment lands on that bin, while the movement watermark stays item-global (stricter is safe). Document numbers come from one per-org allocator (`nextDocNumber`) backed by `doc_counters`, seeded from existing maxima, replacing per-module MAX+1 races.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-N22.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] N22B-G1: the projection tracks the ledger whatever wrote the movement - raw seeds and service movements alike land in stock_balances, org-wide and per-location reads match the ledger
  CHECK: pnpm --filter @chaste/module-inventory exec vitest run src/projections.test.ts -t "keeps the projection consistent"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=b89091f66142358b41f6657e128e34cb0102a17a8438f4c15a03bdceeb015dc0; output-bytes=25026

- [x] N22B-G2: a corrupted projection is repaired by replaying the ledger - rebuildStockProjections restores every balance to the ledger's numbers
  CHECK: pnpm --filter @chaste/module-inventory exec vitest run src/projections.test.ts -t "rebuild replays the ledger"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=cf1a665921c7868c9284606148b0f3bb1fafbbd1f7fc55053cd70b783c936072; output-bytes=25026

- [x] N22B-G3: a cycle count can scope to one location - expected quantities snapshot per bin, posting adjusts only that bin's balance, and the count records its location
  CHECK: pnpm --filter @chaste/module-inventory exec vitest run src/projections.test.ts -t "cycle counts can scope to one location"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=6ca687c9806e1bb042c98ff343365a133483204b0754ba41b3a6f33a95254521; output-bytes=25026

- [x] N22B-G4: document numbers come from one allocator - unknown sequences refuse, fresh sequences start at 1 and march, and a fresh counter seeds past a legacy document's number
  CHECK: pnpm --filter @chaste/module-inventory exec vitest run src/projections.test.ts -t "allocates document numbers"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=37ade44c105404392dd679c19e4fd89aec62fd843d8d298b0d36d56f86330193; output-bytes=25026

- [x] N22B-G5: the standing inventory floor holds - command-service guards, lot binding, non-negative balances, watermark drift detection, transfers and valuation all pass reading the projection
  CHECK: pnpm --filter @chaste/module-inventory exec vitest run && pnpm --filter @chaste/module-purchasing exec vitest run && pnpm --filter @chaste/module-pos exec vitest run && pnpm --filter @chaste/module-sales exec vitest run && pnpm --filter @chaste/module-manufacturing exec vitest run && echo N22-FLOOR-OK
  EXPECT: N22-FLOOR-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0542e3178fae3a108275ec0089374dc985f89b624a3669eedd277210074e3d9b; output-bytes=126836

- [x] N22B-G6: the lock/query-plan review is committed and reproducible - the seeded-history script runs green and its plans show the projection read on the balance index
  CHECK: pnpm exec tsx scripts/n22-projection-review.ts | tee /tmp/kilo/n22-review-gate.log && grep -q "stock_balance_item_idx" /tmp/kilo/n22-review-gate.log && grep -q "projection rows for 200 items" /tmp/kilo/n22-review-gate.log && echo REVIEW-OK
  EXPECT: REVIEW-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=9adea083843857c1baafe156099945c96838443dcaf4fdd8e7f2567b2de5058c; output-bytes=1371

- [x] N22B-G7: repo verification gate - typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck >/dev/null 2>&1 && pnpm lint >/dev/null 2>&1 && pnpm test >/tmp/kilo/gate-n22-test.log 2>&1 && echo REPO-GATE-OK || { tail -30 /tmp/kilo/gate-n22-test.log; exit 1; }
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0c6e5dc74929b6f125a6dfc551264ea8e2e1ad046a1b29c7937ae29c3cc6b215; output-bytes=13

- [x] N22B-G8: the evidence register records the projection delivery and the CHANGELOG records the behavior change
  CHECK: grep -q "stock_balances" docs/W0_EVIDENCE_REGISTER.md && grep -qi "projection" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
