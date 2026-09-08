# Gates: M13 — Retail & reach

OWNS: modules/pos/src/index.ts, modules/pos/src/m13.test.ts, modules/marketing/**, packages/db/src/schema/index.ts, packages/db/drizzle/0034_m13_retail_reach.sql, packages/db/drizzle/meta/_journal.json, scripts/demo-m13.ts, docs/adr/0040-retail-and-reach.md, package.json

Scope: POS returns that reverse money and stock cleanly, shift summaries for registers, and marketing-lite — saved segments, campaigns with an honest send log, opt-out honored, no tracking pixels.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] 13.1-G1: POS returns — a returned sale credits the invoice, restores stock, posts a balanced refund entry, refuses over-returns, and is always gated
  CHECK: pnpm --filter @chaste/module-pos exec vitest run src/m13.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=64ad38327b55327bdbd9268aeb44ce6959c2210d9a14cb2bce55b57fcc3510ee; output-bytes=289

- [x] 13.2-G1: shift summaries — the register read reports sale counts, expected cash, and variance from real sessions
  CHECK: pnpm demo:m13 shifts
  EXPECT: SHIFT SUMMARY OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=d52dac691a66be12e28d8ca6be3301738fd267a5b57e1184990727a64c22ee75; output-bytes=13977

- [x] 13.3-G1: marketing-lite — segments resolve deterministic recipients, sendCampaign honors opt-out, the send log is append-only and counts
  CHECK: pnpm --filter @chaste/module-marketing exec vitest run src/marketing.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=452b8edb2c42b1691e45aff72d3927d49e1d82fc257455800c0d8e01589119a2; output-bytes=300

- [x] 13.3-G2: end-to-end demo — a campaign skips opted-out customers and the send log analytics count deliveries
  CHECK: pnpm demo:m13 marketing
  EXPECT: MARKETING LITE OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=7971f9068562b1b76a96e27279f0f0127a21c0d00f5f23c9a0db0fe39646aea3; output-bytes=13780

- [x] INT-G1: repo verification gate — typecheck and lint pass across the workspace
  CHECK: pnpm typecheck && pnpm lint && echo REPO-GATE-OK
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=cf272c9098d6f85c1f913c66790fd3aadd85b5b601d172957204c5a1c3f5b087; output-bytes=24030

- [x] INT-G2: full workspace test suite passes (includes the new suites)
  CHECK: pnpm test && echo ALL-TESTS-OK
  EXPECT: ALL-TESTS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=6ce173da9ec06110110ae3198899001a18dcfc5c72e0918c2f7c25fd27c301e2; output-bytes=131522

- [x] INT-G3: M9 regression demo still proves its guarantees
  CHECK: pnpm demo:m9
  EXPECT: TIMELINE OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=c5ac7a42bdd9dd91bc7723d92a12f0e23272df9b65d9539cf5d63809c4aaf019; output-bytes=14855

- [x] INT-G4: M10 regression demo still proves its guarantees
  CHECK: pnpm demo:m10
  EXPECT: DUPLICATE FLAGGED
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=e1e49ade772836397785ba162cbe2c0ce3b76af2cb812e1fcb2c07ac86d12915; output-bytes=15257

- [x] INT-G5: M11 regression demo still proves its guarantees
  CHECK: pnpm demo:m11
  EXPECT: M11 ALL OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=f750c979fff663677e5b0b9a881fa841158587592fa033e4dc3e4a74b48f1803; output-bytes=14216

- [x] INT-G6: M12 regression demo still proves its guarantees
  CHECK: pnpm demo:m12
  EXPECT: DOCUMENTS LAYER OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0a08ff246e61c58fdbbdbdae332100f1e171fd853ddf9d94793a63b6750e24d2; output-bytes=14215
