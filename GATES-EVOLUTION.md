# Gate ledger: controlled evolution release

OWNS: modules/creator/src/evolution.ts, modules/creator/src/index.ts, apps/web/src/server/creator-evolution.test.ts, packages/db/src/schema/index.ts, packages/db/drizzle/0058_illegal_gideon.sql, packages/db/drizzle/meta/0058_snapshot.json, packages/db/drizzle/meta/_journal.json, docs/adr/0063-controlled-evolution-release.md, docs/adr/README.md, PLAN.md, CHANGELOG.md

## Acceptance gates

- [x] E0: gate ledger is structurally valid
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-EVOLUTION.md
  EXPECT: LINT OK
  EVIDENCE: `LINT OK` (2026-09-19)

- [x] E1: exact candidate digest binds the release record
  CHECK: pnpm --filter web exec vitest run src/server/creator-evolution.test.ts -t "exact candidate digest"
  EXPECT: tampered or mismatched candidate evidence is rejected
  EVIDENCE: focused Creator evolution test passed; `EVOLUTION-EXACT-DIGEST-OK` (2026-09-19)

- [x] E2: promotion stays behind the existing approval authority
  CHECK: pnpm --filter web exec vitest run src/server/creator-evolution.test.ts -t "approval"
  EXPECT: unapproved promotion cannot move a candidate into staged or promoted state
  EVIDENCE: focused Creator evolution test passed; `EVOLUTION-APPROVAL-OK` (2026-09-19)

- [x] E3: promotion is an artifact handoff, not production source mutation
  CHECK: pnpm --filter web exec vitest run src/server/creator-evolution.test.ts -t "artifact handoff"
  EXPECT: only the exact verified digest is recorded and no executable source is installed
  EVIDENCE: focused Creator evolution test passed; `EVOLUTION-ARTIFACT-HANDOFF-OK` (2026-09-19)

- [x] E4: rollback is conditional and auditable
  CHECK: pnpm --filter web exec vitest run src/server/creator-evolution.test.ts -t "rollback"
  EXPECT: only staged or promoted matching releases roll back; repeated or cross-tenant rollback fails closed
  EVIDENCE: focused Creator evolution test passed; `EVOLUTION-ROLLBACK-OK` and `EVOLUTION-FAIL-CLOSED-OK` (2026-09-19)

- [x] E5: canonical Creator isolation proof remains green
  CHECK: DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 pnpm tsx --tsconfig apps/web/tsconfig.json scripts/gates/creator-isolation.ts
  EXPECT: CREATOR-ISOLATION-OK
  EVIDENCE: `CREATOR-ISOLATION-OK` (2026-09-19)

- [x] E6: repository verification gate passes
  CHECK: pnpm typecheck && pnpm lint && DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 pnpm test --concurrency=1
  EXPECT: all commands exit 0
  EVIDENCE: `pnpm typecheck` passed (26 tasks); `pnpm lint` passed (0 errors); serialized test suite passed (24 tasks, web 42 files / 299 tests) (2026-09-19)

- [x] E7: graph reflects the completed slice
  CHECK: graft build
  EXPECT: command exits 0 and reports parsed/replayed files
  EVIDENCE: `graft build` passed: 2640 nodes, 7323 edges, 463 cards; 463 files replayed (2026-09-19)
