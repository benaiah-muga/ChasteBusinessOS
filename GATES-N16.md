# Gates: N16B - receipt documents, stable positions, and authoritative overreceipt

OWNS: packages/db/drizzle/0052_goods_receipts.sql, packages/db/drizzle/meta/_journal.json, packages/db/src/schema/index.ts, modules/purchasing/src/index.ts, modules/purchasing/src/receipts.test.ts, apps/web/src/app/api/purchasing/route.ts

Scope: receiving writes a real receipt document - a header with who/when and lines that split what arrived into accepted (stocks and bills) and rejected (recorded with a reason, never stocked) - so `purchasing.listReceipts` can show accepted/rejected/returned/remaining per line. Overreceipt becomes an explicit authority: tolerance percent paired with a reason naming the authorizer, refused otherwise. Returns draw from concrete receipts (named receipt, or oldest-first FIFO), updating each receipt line's returned quantity. Line addressing follows stable `po_lines.position` assigned at creation and never renumbered, in the module and in the human API surface.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-N16.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] N16B-G1: a receipt records accepted and rejected quantities per line - rejected goods need a note, never stock, yet complete the vendor's delivery duty - and listReceipts reports accepted/rejected/returned/remaining per line
  CHECK: pnpm --filter @chaste/module-purchasing exec vitest run src/receipts.test.ts -t "records accepted and rejected"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=3d3cf672ae64b55bf660eb8f1fdd2f0ec61d8c4c19e57f19fc9b880c82d25abd; output-bytes=24546

- [x] N16B-G2: overreceipt is refused without authority, refused with tolerance but no reason, and accepted only when tolerance percent and authorityReason are paired
  CHECK: pnpm --filter @chaste/module-purchasing exec vitest run src/receipts.test.ts -t "explicit paired authority"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=cc90ad8533e2bd2fcb543b7a858419d15fabb4d4bb708bde3df161661699d12d; output-bytes=24546

- [x] N16B-G3: line addressing follows stable positions - after the display rows are reordered, receipts and the order report follow position 1 to the same physical line
  CHECK: pnpm --filter @chaste/module-purchasing exec vitest run src/receipts.test.ts -t "stable position"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=641f0edcbd2a5ef7d4236834eb12949793a72f4b4f61f869c8445de25669105b; output-bytes=24546

- [x] N16B-G4: returns draw from concrete receipts - a named receipt caps at its own availability, a foreign receipt number is refused, and unscoped returns drain receipts oldest-first with per-receipt returned quantities on record
  CHECK: pnpm --filter @chaste/module-purchasing exec vitest run src/receipts.test.ts -t "links returns to concrete receipts"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=6ccf0f2b4a658338f9a957326ecc8098583b4fa886adca9c8752f125496c2446; output-bytes=24646

- [x] N16B-G5: the equivalence floor holds - overreceipt refusal, repeated references spending one budget, service completion, bill allowance consumption, and return-driven status demotion all still pass under the receipt model
  CHECK: pnpm --filter @chaste/module-purchasing exec vitest run src/receiving.test.ts src/statements.test.ts src/reversal.test.ts
  EXPECT: /Tests\s+11 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=3179669d396c0176d026eded814206d73ae3224b1b8700272e5e1006e57a12ca; output-bytes=24871

- [x] N16B-G6: repo verification gate - typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck >/dev/null 2>&1 && pnpm lint >/dev/null 2>&1 && pnpm test >/tmp/kilo/gate-n16-test.log 2>&1 && echo REPO-GATE-OK || { tail -30 /tmp/kilo/gate-n16-test.log; exit 1; }
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0c6e5dc74929b6f125a6dfc551264ea8e2e1ad046a1b29c7937ae29c3cc6b215; output-bytes=13

- [x] N16B-G7: the evidence register records the receipt-model delivery and the CHANGELOG records the behavior change
  CHECK: grep -q "goods_receipts" docs/W0_EVIDENCE_REGISTER.md && grep -qi "receipt" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
