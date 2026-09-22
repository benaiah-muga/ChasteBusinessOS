# Gate ledger: Creator canary outcome measurement

OWNS: modules/creator/src/evolution.ts, apps/web/src/server/creator-evolution.test.ts, packages/db/src/schema/index.ts, packages/db/drizzle/0059_massive_captain_america.sql, packages/db/drizzle/0060_melted_vermin.sql, packages/db/drizzle/meta/0059_snapshot.json, packages/db/drizzle/meta/0060_snapshot.json, packages/db/drizzle/meta/_journal.json, docs/adr/0064-creator-canary-outcomes.md, docs/adr/README.md, PLAN.md, CHANGELOG.md

Scope: bind promoted Creator artifacts to their originating capability-gap ticket and record release-principal canary outcomes without executing source or mutating release state automatically.

- [x] O0: gate ledger is structurally valid
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-OUTCOMES.md
  EXPECT: LINT OK
  EVIDENCE: 2026-09-19 — `LINT OK`

- [x] O1: only the original capability gap can receive an outcome
  CHECK: pnpm --filter web exec vitest run src/server/creator-evolution.test.ts -t "original capability gap"
  EXPECT: EVOLUTION-GAP-LINK-OK
  EVIDENCE: 2026-09-19 — exit 0; 1 test passed; `EVOLUTION-GAP-LINK-OK`

- [x] O2: canary outcome recording uses the release-principal permission
  CHECK: pnpm --filter web exec vitest run src/server/creator-evolution.test.ts -t "release permission"
  EXPECT: EVOLUTION-RELEASE-PRINCIPAL-OK
  EVIDENCE: 2026-09-19 — exit 0; 1 test passed; `EVOLUTION-RELEASE-PRINCIPAL-OK`

- [x] O3: canary pass and fail are durable evidence, not implicit deployment
  CHECK: pnpm --filter web exec vitest run src/server/creator-evolution.test.ts -t "canary outcome"
  EXPECT: EVOLUTION-CANARY-OUTCOME-OK
  EVIDENCE: 2026-09-19 — exit 0; 1 test passed; `EVOLUTION-CANARY-OUTCOME-OK`

- [x] O4: existing exact-digest promotion and rollback behavior remains green
  CHECK: pnpm --filter web exec vitest run src/server/creator-evolution.test.ts
  EXPECT: EVOLUTION-FAIL-CLOSED-OK
  EVIDENCE: 2026-09-19 — exit 0; 3 tests passed; `EVOLUTION-FAIL-CLOSED-OK`

- [x] O5: canonical Creator isolation proof remains green
  CHECK: DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 pnpm tsx --tsconfig apps/web/tsconfig.json scripts/gates/creator-isolation.ts
  EXPECT: CREATOR-ISOLATION-OK
  EVIDENCE: 2026-09-19 — exit 0; `CREATOR-ISOLATION-OK`

- [x] O6: repository verification gate passes
  CHECK: pnpm typecheck && pnpm lint && DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 pnpm test --concurrency=1
  EXPECT: all commands exit 0
  EVIDENCE: 2026-09-19 — exit 0; typecheck 26/26; lint completed with existing warnings; test 24/24 tasks, 42 web files, 300 web tests passed

- [x] O7: graph reflects the completed slice
  CHECK: graft build
  EXPECT: command exits 0 and reports parsed/replayed files
  EVIDENCE: 2026-09-19 — exit 0; graph 2,643 nodes / 7,333 edges; 4 parsed and 459 replayed files
