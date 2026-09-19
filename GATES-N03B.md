# Gates: N03B - verified identity binding and the deployment matrix

OWNS: apps/web/src/server/auth.ts, apps/web/src/server/session.ts, apps/web/src/server/kernel.ts, apps/web/src/server/identity-binding.test.ts, docs/n03-verified-binding-matrix.md

Scope: a password account proves nothing about mailbox ownership, and domain identities are pre-provisioned (SCIM, invitations) and bind by email - so sign-in stays sealed until the address is verified (`requireEmailVerification`, re-send on sign-in attempt), an unverified session resolves to a bare identity (no memberships surfaced, no permissions, case-variant claims included), verification or a trusted-IdP assertion unlocks pre-provisioned access, concurrent first sign-ins collapse to one domain user, and the deployment matrix records which profiles transport real mail or rely on IdP assertions.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-N03B.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] N03B-G1: an unverified sign-up for a pre-provisioned email - including case variants - resolves to a bare identity: no memberships surfaced, no permissions; verification unlocks the pre-provisioned membership
  CHECK: pnpm --filter web exec vitest run src/server/identity-binding.test.ts -t "inherits nothing"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=51ef55f36384ac827d9b301c6d5c8bbc8e10016b1207ade6f2d3491e53a622a9; output-bytes=25029

- [x] N03B-G2: a verified session without memberships still resolves to a bare identity, and concurrent first sign-ins for one email collapse to exactly one domain user
  CHECK: pnpm --filter web exec vitest run src/server/identity-binding.test.ts -t "concurrent first sign-ins"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=347bb66d968f7852807e5d2cf961d38d236483cf49bb9e8132aecfb526a4fc9b; output-bytes=25029

- [x] N03B-G3: the auth gate is on - sign-in refuses unverified accounts, re-sends the verification link, and sign-up stays sealed until verification
  CHECK: grep -q "requireEmailVerification: true" apps/web/src/server/auth.ts && grep -q "sendOnSignIn: true" apps/web/src/server/auth.ts && grep -q "sendVerificationEmail" apps/web/src/server/auth.ts && echo AUTH-GATE-ON
  EXPECT: AUTH-GATE-ON
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=fbb4bf07521ee26b3129d5064a1faa1532bf0649349fdb04efb857c8e0d723de; output-bytes=13

- [x] N03B-G4: the standing identity and route-guard suites hold under the binding rule - invitation claims, lifecycle, guards, bootstrap
  CHECK: pnpm --filter web exec vitest run src/server/identity-lifecycle.test.ts src/server/route-guards.test.ts src/server/onboarding-bootstrap.test.ts && echo IDENTITY-FLOOR-OK
  EXPECT: IDENTITY-FLOOR-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=a2b656a3f5e2bcbb09526bf55898c1604006c1bc825ca2cb9a026baaaaac63e6; output-bytes=40262

- [x] N03B-G5: the deployment matrix exists and names the profiles, the edges covered, and the executable proof
  CHECK: grep -q "Deployment profiles" docs/n03-verified-binding-matrix.md && grep -q "identity-binding.test.ts" docs/n03-verified-binding-matrix.md && echo MATRIX-OK
  EXPECT: MATRIX-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=623361e83105e8408c50ad67cc76b1c26c7796acd1ebb582717a873a6b66d5cc; output-bytes=10

- [x] N03B-G6: repo verification gate - typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck >/dev/null 2>&1 && pnpm lint >/dev/null 2>&1 && pnpm test >/tmp/kilo/gate-n03b-test.log 2>&1 && echo REPO-GATE-OK || { tail -30 /tmp/kilo/gate-n03b-test.log; exit 1; }
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0c6e5dc74929b6f125a6dfc551264ea8e2e1ad046a1b29c7937ae29c3cc6b215; output-bytes=13

- [x] N03B-G7: the evidence register records the binding delivery and the CHANGELOG records the behavior change
  CHECK: grep -q "verified identity binding" docs/W0_EVIDENCE_REGISTER.md && grep -qi "unverified" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
