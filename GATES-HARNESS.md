# Gates: Cordis composition boundary

OWNS: packages/harness/**, apps/web/src/server/harness.ts, docs/adr/0058-harness-composition-boundary.md, CHANGELOG.md, PLAN.md

Scope: introduce a versioned Chaste Harness composition runtime that mounts the existing capability kernel without creating a second authority path.

- [x] H-0: this ledger contains executable acceptance outcomes
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-HARNESS.md
  EXPECT: LINT OK
  EVIDENCE: passed 2026-09-19 — gate-lint returned LINT OK

- [x] H-1: profiles and bundles produce a stable composition digest and reject production authority expansion
  CHECK: pnpm --filter @chaste/harness exec vitest run src/profile.test.ts
  EXPECT: /HARNESS-PROFILE-OK/
  EVIDENCE: passed 2026-09-19 — HARNESS-PROFILE-OK, 2 tests

- [x] H-2: dependency-ordered service mounting rolls back cleanly and unmounts in reverse order
  CHECK: pnpm --filter @chaste/harness exec vitest run src/runtime.test.ts
  EXPECT: /HARNESS-LIFECYCLE-OK/
  EVIDENCE: passed 2026-09-19 — HARNESS-LIFECYCLE-OK, 2 tests

- [x] H-3: the capability bridge exposes discovery and routes execution through the supplied kernel executor
  CHECK: pnpm --filter @chaste/harness exec vitest run src/capability-bridge.test.ts
  EXPECT: /HARNESS-BRIDGE-OK/
  EVIDENCE: passed 2026-09-19 — HARNESS-BRIDGE-OK, 1 test

- [x] H-4: the web server can compose its existing registry and executor into the harness adapter
  CHECK: pnpm --filter web exec vitest run src/server/harness.test.ts
  EXPECT: /HARNESS-ADAPTER-OK/
  EVIDENCE: passed 2026-09-19 — HARNESS-ADAPTER-OK, 1 test

- [x] H-5: the repository remains type-safe and all existing behavior passes
  CHECK: pnpm typecheck && pnpm lint && pnpm test && echo HARNESS-SEQUENCE-OK
  EXPECT: HARNESS-SEQUENCE-OK
  EVIDENCE: passed 2026-09-19 — HARNESS-SEQUENCE-OK; 26 typecheck tasks, 24 test tasks, web 287 tests across 37 files
