# Gates: N12B - vendor payments undo through their own domain compensation

OWNS: modules/purchasing/src/index.ts, modules/purchasing/src/reversal.test.ts, modules/accounting/src/index.ts, modules/accounting/src/reversal.test.ts

Scope: `purchasing.reverseVendorPayment` mirrors the payment entry in its original currency, releases the bill's paid amount through the balance contract, demotes a paid bill back to open, and refuses a second or replayed reversal at the business-operation level; `payBill` declares it as its real inverse and settles through the balance contract; the generic `accounting.reverseEntry` refuses `vendor_payment` entries with named routing.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-N12.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] N12B-G1: pay then reverse leaves the books balanced, the bill released and demoted to open, the mirror entry flipping cash and AP in the original currency; a second or replayed reversal is refused and has no second effect; a credited bill's outstanding reflects the credit after reversal
  CHECK: pnpm --filter @chaste/module-purchasing exec vitest run src/reversal.test.ts
  EXPECT: /Tests\s+3 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=5df406d83a10ad4a89deb1ee13f4589a77fbd2712b975526b89043d087322c63; output-bytes=24037

- [x] N12B-G2: the generic journal reversal refuses a vendor_payment entry and names purchasing.reverseVendorPayment
  CHECK: pnpm --filter @chaste/module-accounting exec vitest run src/reversal.test.ts
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=7a5aacf8917c0ce9adf8486fe45c51e9e9dd371df6e2e3258e84777a35517488; output-bytes=24038

- [x] N12B-G3: the kernel accepts the new capability at boot - conformance (id, intent, inverse input generated against the real payBill output) passes inside the module registry
  CHECK: pnpm --filter @chaste/module-purchasing exec vitest run && pnpm --filter @chaste/module-accounting exec vitest run && echo N12B-MODULES-OK
  EXPECT: N12B-MODULES-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=cc09bcadf608b9146152ebafe1be2c0aa03ed0d8d7239056a8be28d24f60d5da; output-bytes=49810

- [x] N12B-G4: repo verification gate - typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck >/dev/null 2>&1 && pnpm lint >/dev/null 2>&1 && pnpm test >/tmp/kilo/gate-n12-test.log 2>&1 && echo REPO-GATE-OK || { tail -30 /tmp/kilo/gate-n12-test.log; exit 1; }
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0c6e5dc74929b6f125a6dfc551264ea8e2e1ad046a1b29c7937ae29c3cc6b215; output-bytes=13

- [x] N12B-G5: the evidence register records the vendor-reversal delivery and the CHANGELOG records the behavior change
  CHECK: grep -q "reverseVendorPayment" docs/W0_EVIDENCE_REGISTER.md && grep -qi "vendor payment" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
