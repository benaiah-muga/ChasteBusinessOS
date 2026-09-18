# Gates: PILOT — W0.5 build: receiving desk, My Work home, supplier page, instrumentation

OWNS: apps/web/src/app/api/purchasing/route.ts, apps/web/src/app/api/my-work/route.ts, apps/web/src/app/api/my-work/summarize/route.ts, apps/web/src/app/(app)/purchasing/receiving/page.tsx, apps/web/src/components/my-work.tsx, apps/web/src/app/(app)/purchasing/page.tsx, apps/web/src/lib/pilot-metrics.ts, apps/web/src/server/pilot-ui.test.ts

Scope: the W0.5 build order runs on delivered engines. The receiving desk (P05) records accepted/rejected quantities with reasons through the governed capability and shows what remains; the My Work home (P01) composes one deterministic ranked list — approvals the viewer may decide, then receipt remainders, then module signals — with coverage failures shown as unavailable; the optional AI brief is NL-only over the authorized bundle on openrouter/stealth/union-alpha and degrades honestly without a key; the supplier view remembers the relationship (P04); and pilot metrics stay client-side so telemetry never becomes an ungoverned write.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-PILOT.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] PILOT-G1: My Work ranks deterministically — a decision-bearing approval comes before a receipt remainder, and the remainder card carries the outstanding quantity and a receiving-desk deep link
  CHECK: pnpm --filter web exec vitest run src/server/pilot-ui.test.ts -t "composes a ranked My Work"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f6e374374a6cffcb2980a67d181a4c39c3418ce6a38b8f4d83bf9df54dcb965; output-bytes=39919

- [x] PILOT-G2: the receiving desk records accepted and rejected quantities through the governed capability, shows what remains outstanding, completes the order, and demands a rejection reason at the same boundary
  CHECK: pnpm --filter web exec vitest run src/server/pilot-ui.test.ts -t "the receiving desk records"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=a8ac804c9505dc914efd1de9d2227aa8f0522c685bcc41070d50c96a845092bb; output-bytes=39927

- [x] PILOT-G3: the NL brief runs on openrouter/stealth/union-alpha and degrades honestly — 503 without a key, 400 without cards, never a fabricated summary
  CHECK: pnpm --filter web exec vitest run src/server/pilot-ui.test.ts -t "degrades the AI brief" && grep -q "openrouter/stealth/union-alpha" apps/web/src/app/api/my-work/summarize/route.ts && echo NL-OK
  EXPECT: NL-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=a2172271e2a500807dc2dedd7f2f4a69205968f42f307bd634b1b51d674219ed; output-bytes=25027

- [x] PILOT-G4: the build-order artifacts are wired into the shell — the receiving desk page, the My Work home section, and the supplier relationship rollup exist and compile
  CHECK: test -f "apps/web/src/app/(app)/purchasing/receiving/page.tsx" && test -f apps/web/src/components/my-work.tsx && grep -q "MyWork" "apps/web/src/app/(app)/page.tsx" && grep -q "selectedVendorId" "apps/web/src/app/(app)/purchasing/page.tsx" && test -f apps/web/src/lib/pilot-metrics.ts && echo SHELL-OK
  EXPECT: SHELL-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=e1cc763d46c71a5931f603f9665aa42a8c95c46dbba9705902bce2d0aeb38e87; output-bytes=9

- [x] PILOT-G5: the standing identity and route-guard suites hold with the new surfaces in place
  CHECK: pnpm --filter web exec vitest run src/server/route-guards.test.ts src/server/identity-lifecycle.test.ts && echo GUARDS-OK
  EXPECT: GUARDS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=6bc11f7544f7f74add60d6efb9c4e1e20756358c27ceb19232db27162939be60; output-bytes=40060

- [x] PILOT-G6: repo verification gate — typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck >/dev/null 2>&1 && pnpm lint >/dev/null 2>&1 && pnpm test >/tmp/kilo/gate-pilot-test.log 2>&1 && echo REPO-GATE-OK || { tail -30 /tmp/kilo/gate-pilot-test.log; exit 1; }
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0c6e5dc74929b6f125a6dfc551264ea8e2e1ad046a1b29c7937ae29c3cc6b215; output-bytes=13

- [x] PILOT-G7: the evidence register records the pilot build and the CHANGELOG records the user-visible additions
  CHECK: grep -q "receiving desk" docs/W0_EVIDENCE_REGISTER.md && grep -qi "My Work" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
