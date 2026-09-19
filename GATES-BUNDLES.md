# Gates: approved harness bundle resolution

OWNS: apps/web/src/server/harness.ts, apps/web/src/server/harness-bundles.test.ts, apps/web/src/server/durable-coordinator.ts, apps/web/src/server/durable-coordinator.test.ts, docs/adr/0061-approved-harness-bundle-resolution.md, PLAN.md, CHANGELOG.md

Scope: resolve persisted bundle manifests through an explicit adapter registry, pass approved configuration patches into the runtime, and fail closed when no resolver can faithfully mount a bundle.

- [x] B-0: this ledger contains executable acceptance outcomes
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-BUNDLES.md
  EXPECT: LINT OK
  EVIDENCE: passed 2026-09-19 — gate-lint returned LINT OK

- [x] B-1: the adapter mounts the built-in ERP bundle plus a separately registered bundle
  CHECK: pnpm --filter web exec vitest run src/server/harness-bundles.test.ts
  EXPECT: /BUNDLE-RESOLUTION-OK/
  EVIDENCE: passed 2026-09-19 — BUNDLE-RESOLUTION-OK, focused bundle/coordinator tests passed

- [x] B-2: persisted patches contribute to runtime identity and expose keys without exposing values
  CHECK: pnpm --filter web exec vitest run src/server/harness-bundles.test.ts
  EXPECT: /BUNDLE-IDENTITY-OK/
  EVIDENCE: passed 2026-09-19 — BUNDLE-IDENTITY-OK, focused bundle test passed

- [x] B-3: an unknown persisted bundle fails before a durable run can be created
  CHECK: pnpm --filter web exec vitest run src/server/harness-bundles.test.ts src/server/durable-coordinator.test.ts
  EXPECT: /BUNDLE-FAIL-CLOSED-OK/
  EVIDENCE: passed 2026-09-19 — BUNDLE-FAIL-CLOSED-OK and PROFILE-AWARE-FAIL-CLOSED-OK, focused negative tests passed

- [x] B-4: the repository remains type-safe and all behavior passes
  CHECK: pnpm typecheck && pnpm lint && pnpm test --concurrency=1 && echo BUNDLE-SEQUENCE-OK
  EXPECT: BUNDLE-SEQUENCE-OK
  EVIDENCE: passed 2026-09-19 — BUNDLE-SEQUENCE-OK; typecheck completed 26 tasks, lint reported 0 errors / 184 warnings, sequential Turbo tests completed 24 tasks with web at 40 files / 295 tests
