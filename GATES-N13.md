# Gates: N13B — exceptional entries, posting eligibility, and the backdated-correction path

OWNS: packages/db/drizzle/0051_entry_kinds.sql, packages/db/drizzle/meta/_journal.json, packages/db/src/schema/index.ts, modules/accounting/src/posting.ts, modules/accounting/src/index.ts, modules/accounting/src/year-end.test.ts

Scope: the year-end roll is an explicit exceptional entry (`entry_kind = 'year_end_close'`) with at most one live roll per sealed year — re-closing a reopened year replaces the live roll inside the reopened December, never in the current period; the P&L report excludes the close family, so closing a year no longer erases its operating history from reports; corrections (generic reversals) post in the approved open period while carrying the original business date in `business_at`; and pre-resolved account ids are validated against posting eligibility (same org, not archived) in the one posting service.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-N13.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] N13B-G1: the posting service refuses pre-resolved account ids that are archived or belong to another organization, in either the code path or the id path
  CHECK: pnpm --filter @chaste/module-accounting exec vitest run src/year-end.test.ts -t "refuses to post through a pre-resolved account"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=dde73d0c172caa33ef731f89b0c9e09f5064188cbbf1848abce75e976fb08978; output-bytes=24061

- [x] N13B-G2: a generic reversal lands in the approved open period but carries the original business date (`entry_kind = 'correction'`, `business_at` = original `posted_at`), and a year-end roll refuses the generic mirror by name
  CHECK: pnpm --filter @chaste/module-accounting exec vitest run src/year-end.test.ts -t "stamps corrections"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=37067a6692db46b760a8160ef2ee3ccb0e33904c4551bbd168f0aaefc6a2ac13; output-bytes=24061

- [x] N13B-G3: closing a year posts an explicit `year_end_close` roll at the year's last instant, seals December, refuses a second close, and the P&L report shows identical operating numbers before and after the close
  CHECK: pnpm --filter @chaste/module-accounting exec vitest run src/year-end.test.ts -t "closes 2025"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=bca45ca7a22e4c6d7eee2f74159a8c363641c312ef51ecadd0fa713c0499c04e; output-bytes=24061

- [x] N13B-G4: re-closing a reopened year reverses the live roll inside the reopened December and rolls the full year exactly once — one live roll remains, the replaced roll is referenced by its replacement, balance sheet and trial balance stay balanced
  CHECK: pnpm --filter @chaste/module-accounting exec vitest run src/year-end.test.ts -t "re-closing a reopened year"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=35b6273c4beda54cbcc2fea7d908340b26e9d9e78e89a487ca7891a0cd7e0ae2; output-bytes=24204

- [x] N13B-G5: repo verification gate — typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck >/dev/null 2>&1 && pnpm lint >/dev/null 2>&1 && pnpm test >/tmp/kilo/gate-n13-test.log 2>&1 && echo REPO-GATE-OK || { tail -30 /tmp/kilo/gate-n13-test.log; exit 1; }
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0c6e5dc74929b6f125a6dfc551264ea8e2e1ad046a1b29c7937ae29c3cc6b215; output-bytes=13

- [x] N13B-G6: the evidence register records the exceptional-entry delivery and the CHANGELOG records the behavior change
  CHECK: grep -q "entry_kind" docs/W0_EVIDENCE_REGISTER.md && grep -qi "year-end" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
