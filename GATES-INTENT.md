# Gates: INTENT - intentId adoption across UI surfaces (B02 completion)

OWNS: apps/web/src/lib/api.ts, apps/web/src/lib/api.test.ts, apps/web/src/app/api/*/route.ts, docs/W0_EVIDENCE_REGISTER.md, CHANGELOG.md

Scope: every mutating UI request carries a client action identity. `postApi` injects one per call when the caller omits it; every mutating POST route threads the optional identity into its actor context so the kernel's receipt store can replay retries and refuse conflicting reuses. Machine APIs without a client identity (SCIM) and state-guarded claims (invite) are declared exceptions.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-INTENT.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] INTENT-G1: postApi injects a fresh per-call intentId into a body that lacks one, preserves an explicit caller intentId, and leaves non-object bodies untouched
  CHECK: pnpm --filter web exec vitest run src/lib/api.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0556eeceaa50036bc7f0aca48c33913cda617180a0138883bbe18ad4f89df218; output-bytes=23538

- [x] INTENT-G2: every mutating POST route threads an optional client intentId into its actor context - the declared mutation set (banking, conversations, conversations messages, crm, customers, deals, documents, email, expenses, hr, inventory, manufacturing, marketing, marketplace, modules, pos, projects, purchasing, quotes, recurring, routines, sales, support, team, time) each reference intentId in both body handling and actor context; declared exceptions: scim (machine API, no client identity), invite claim (state-guarded CAS retries honestly), chat and the messages agent reply (one actor context is shared across every step of an agent loop, so a single request-scoped id would false-conflict - job-driven agent runs already key receipts by job id), notifications (non-kernel idempotent read receipt on a conflict-protected table)
  CHECK: for f in banking conversations "conversations/[id]/messages" crm customers deals documents email expenses hr inventory manufacturing marketing marketplace modules pos projects purchasing quotes recurring routines sales support team time; do c=$(grep -c "intentId" "apps/web/src/app/api/$f/route.ts"); [ "$c" -ge 2 ] || { echo "MISSING intentId threading: $f"; exit 1; }; done && echo INTENT-THREADING-OK
  EXPECT: INTENT-THREADING-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2291c7ee595c4e7118e9a9f177fb29385ea8f55c3be53fc66419346c9aa40af7; output-bytes=20

- [x] INTENT-G3: with an identity in context, the kernel receipt store replays the original result for a repeated intent and refuses a conflicting reuse - the B02 suite stays green
  CHECK: pnpm --filter web exec vitest run src/server/effect-receipts.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=059d6b02cee3124c07058035256fa248a576b2f17ad055695797c3a5d98ca3e9; output-bytes=23556

- [x] INTENT-G4: repo verification gate - typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck && pnpm lint && pnpm test && echo REPO-GATE-OK
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=7245c4c3683eb4fee6af8f5bf37d307b0d82e3bc0c193b2c9c2c8b866bde745c; output-bytes=1043953

- [x] INTENT-G5: the W0 evidence register records the intentId adoption slice and the CHANGELOG records the behavior change
  CHECK: grep -q "intentId" docs/W0_EVIDENCE_REGISTER.md && grep -qi "intent" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
