# Gates: profile-aware durable-run coordinator

OWNS: apps/web/src/server/durable-coordinator.ts, apps/web/src/server/durable-coordinator.test.ts, apps/web/src/server/harness-compositions.ts, apps/web/src/server/durable-runs.ts, scripts/gates/durable-po-run.ts, docs/adr/0060-profile-aware-durable-run-coordinator.md, PLAN.md, CHANGELOG.md

Scope: resolve a tenant-owned persisted harness composition into the live Chaste harness and pin the exact verified identity to a new durable run.

- [x] C-0: this ledger contains executable acceptance outcomes
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-COORDINATOR.md
  EXPECT: LINT OK
  EVIDENCE: passed 2026-09-19 — gate-lint returned LINT OK

- [x] C-1: the coordinator resolves a tenant-owned composition and starts a run with the requested profile
  CHECK: pnpm --filter web exec vitest run src/server/durable-coordinator.test.ts
  EXPECT: /PROFILE-AWARE-RUN-OK/
  EVIDENCE: passed 2026-09-19 — PROFILE-AWARE-RUN-OK, focused coordinator test passed

- [x] C-2: the live harness identity and durable-run identity match the persisted composition exactly
  CHECK: pnpm --filter web exec vitest run src/server/durable-coordinator.test.ts
  EXPECT: /PROFILE-AWARE-IDENTITY-OK/
  EVIDENCE: passed 2026-09-19 — PROFILE-AWARE-IDENTITY-OK, focused coordinator test passed

- [x] C-3: missing, cross-tenant, profile-mismatched, and unsupported compositions fail before a run is created
  CHECK: pnpm --filter web exec vitest run src/server/durable-coordinator.test.ts
  EXPECT: /PROFILE-AWARE-FAIL-CLOSED-OK/
  EVIDENCE: passed 2026-09-19 — PROFILE-AWARE-FAIL-CLOSED-OK, focused coordinator test passed

- [x] C-4: the repository remains type-safe and all behavior passes
  CHECK: pnpm typecheck && pnpm lint && pnpm test --concurrency=1 && echo COORDINATOR-SEQUENCE-OK
  EXPECT: COORDINATOR-SEQUENCE-OK
  EVIDENCE: passed 2026-09-19 — COORDINATOR-SEQUENCE-OK on the exact retry after an isolated transient DB fixture race; typecheck and lint passed, sequential Turbo tests completed 24 tasks with web at 39 files / 292 tests
