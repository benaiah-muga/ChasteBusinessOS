# Gates: SCIM - token expiry and rotation policy

OWNS: packages/db/drizzle/0054_scim_token_expiry.sql, packages/db/drizzle/meta/_journal.json, packages/db/src/schema/index.ts, apps/web/src/app/api/scim/tokens/route.ts, apps/web/src/app/api/scim/v2/Users/route.ts, apps/web/src/server/scim-tokens.test.ts

Scope: SCIM provisioning tokens live 90 days by default (1–365 configurable at creation); the IdP route refuses expired tokens regardless of the active flag; rotation is create-new + deactivate-old; pre-policy tokens (null expiry) stay valid until deactivated.

- [x] G0: this ledger states oracles that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-SCIM.md
  EXPECT: LINT OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8

- [x] SCIM-G1: creation applies the default 90-day window, honors a custom window, and refuses out-of-policy values (0, 400, fractional)
  CHECK: pnpm --filter web exec vitest run src/server/scim-tokens.test.ts -t "creates tokens with the default"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=3659344a4404b8123804c4a7405bbc18d3c8fa76625b90e0e1d6b55644444c5a; output-bytes=25023

- [x] SCIM-G2: the IdP route honors rotation, refuses expired-but-active tokens outright, and keeps pre-policy (null-expiry) tokens working until deactivated
  CHECK: pnpm --filter web exec vitest run src/server/scim-tokens.test.ts -t "refuses expired tokens"
  EXPECT: /Tests\s+1 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2242f1efa53d991bc8f5a2e2c8f5e1c67d6ac3b03d34b08ca1c5a92be3c29211; output-bytes=25023

- [x] SCIM-G3: repo verification gate - typecheck, lint, and the full workspace test suite pass
  CHECK: pnpm typecheck >/dev/null 2>&1 && pnpm lint >/dev/null 2>&1 && pnpm test >/tmp/kilo/gate-scim-test.log 2>&1 && echo REPO-GATE-OK || { tail -30 /tmp/kilo/gate-scim-test.log; exit 1; }
  EXPECT: REPO-GATE-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=0c6e5dc74929b6f125a6dfc551264ea8e2e1ad046a1b29c7937ae29c3cc6b215; output-bytes=13

- [x] SCIM-G4: the evidence register records the policy and the CHANGELOG records the behavior change
  CHECK: grep -q "90-day" docs/W0_EVIDENCE_REGISTER.md && grep -qi "SCIM" CHANGELOG.md && echo DOCS-OK
  EXPECT: DOCS-OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=1ebc9426bc5d/28 entries; EXPECT=matched; output-sha256=2f994fac08121c4f08560e6e1210c76191fe546fa80e877c9121af6d10b342db; output-bytes=8
