# Gates: I1 — remaining ungoverned write boundaries

OWNS: apps/web/src/app/api/invite/[token]/route.ts, apps/web/src/app/api/scim/v2/Users/[id]/route.ts, apps/web/src/app/api/conversations/route.ts, apps/web/src/app/api/chat/route.ts, apps/web/src/app/api/support/public/route.ts, apps/web/src/server/identity-lifecycle.ts, apps/web/src/server/identity-lifecycle.test.ts, apps/web/src/server/support-public.test.ts, apps/web/src/server/session.ts, modules/iam/src/**, modules/messaging/src/**, modules/support/src/**, packages/db/drizzle/0047_*.sql, packages/db/drizzle/meta/_journal.json, packages/db/src/schema/index.ts, docs/adr/0053-*.md, docs/W0_EVIDENCE_REGISTER.md, CHANGELOG.md

Scope: every remaining ungoverned write route from the W0.4 inventory either executes a governed capability or a shared transactional service — invitation claims are compare-and-set with verified-email binding, SCIM deactivation clears all authority atomically with last-owner protection, conversation and ticket creation go through the kernel, and the public widget binds no customer identity from visitor input.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-I1.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] I1-G1: invitation claims are atomic and verified — a concurrent double accept yields exactly one winner and one conflict, an unverified account is refused, an expired invitation transitions and refuses, an email mismatch is refused, and the happy path grants membership, role, and accepted status in one unit
  CHECK: pnpm --filter web exec vitest run src/server/identity-lifecycle.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=ed881b32197a84135f717c640fc32ee7f768be2183d198ed6c41b251538c5f9c; output-bytes=23559

- [x] I1-G2: member deactivation clears membership, user_roles, and pending invitations in one transaction, and deactivating the last owner is refused with zero partial effects
  CHECK: pnpm --filter web exec vitest run src/server/identity-lifecycle.test.ts
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=bbc797614077002589961ca73e3205b4df05f79b9fbe60bc5130b63a1de9b3e6; output-bytes=23559

- [x] I1-G3: iam.assignRole refuses to strip the last owner, and succeeds once a second owner exists
  CHECK: pnpm --filter @chaste/module-iam exec vitest run
  EXPECT: /Test Files\s+\d+ passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=990b9cf5f0e3d8fb4a852a2b3518d8825b4ea62cf891eca53356d5be6430078a; output-bytes=23547

- [x] I1-G4: messaging.createConversation inserts the header and the creator membership in one unit through the kernel, and the conversations route no longer writes domain rows directly
  CHECK: pnpm --filter @chaste/module-messaging exec vitest run
  EXPECT: /Test Files\s+\d+ passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=ab073b5d645c06c952c1657cafcc0120a6b85f6abd71d04ea7b19b74fb3971aa; output-bytes=23549

- [x] I1-G5: a ticket filed through chat is traceable end to end — the kernel audits its creation, the tool receipt carries the durable ticket id, and no route writes the tickets table directly
  CHECK: pnpm --filter @chaste/module-support exec vitest run
  EXPECT: /Test Files\s+\d+ passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=e17d4a9d6d425b2f36d3de38961d17c672e2629327ae1c36cee7903a7a505044; output-bytes=23592

- [x] I1-G6: widget containment — starting a conversation with a victim's email binds no customer row and stores no customer binding, the per-conversation secret is required for message, escalate, and poll, and unbound conversations render in the staff desk without account facts
  CHECK: pnpm --filter web exec vitest run src/server/support-public.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=755552e81625d3aa5280f6b2de8646b5e20c9172df1f960a16ec91a25b4ba8b1; output-bytes=23556

- [x] I1-G7: repo verification gate — typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck && pnpm lint && pnpm test && echo REPO-GATE-OK
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=653f79b3f09bdef05d974cee0385e2a19f4acb827a7c6d4e188629ce54f43cf9; output-bytes=1041952

- [x] I1-G8: the W0 register records the I1 write-boundary delivery (N03 invite slice, N04 containment, N07 lifecycle, N08 conversation/ticket paths) with the onboarding bootstrap explicitly deferred to B01, and the CHANGELOG records the behavior changes
  CHECK: grep -q "I1 write boundaries" docs/W0_EVIDENCE_REGISTER.md && grep -q "identity lifecycle" CHANGELOG.md && ls docs/adr/0053-*.md >/dev/null && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
