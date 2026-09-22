# Gates: persisted harness identity and safe inspection

OWNS: packages/db/**, packages/harness/**, apps/web/src/server/harness-compositions.ts, apps/web/src/server/durable-runs.ts, docs/adr/0059-persisted-harness-identity.md, CHANGELOG.md, PLAN.md

Scope: persist an approved harness composition per tenant, pin its immutable
identity to durable runs, and expose a redacted inspection read model without
creating a second execution authority.

- [x] I-0: this ledger contains executable acceptance outcomes
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-INSPECTION.md
  EXPECT: LINT OK
  EVIDENCE: passed 2026-09-19 — gate-lint returned LINT OK

- [x] I-1: an approved profile/composition is persisted idempotently and remains tenant-scoped
  CHECK: pnpm --filter web exec vitest run src/server/harness-compositions.test.ts
  EXPECT: /HARNESS-PERSISTENCE-OK/
  EVIDENCE: passed 2026-09-19 — HARNESS-PERSISTENCE-OK, focused persistence test passed

- [x] I-2: durable runs pin and read back the persisted composition identity
  CHECK: pnpm --filter web exec vitest run src/server/durable-runs.test.ts
  EXPECT: /DURABLE-RUN-IDENTITY-OK/
  EVIDENCE: passed 2026-09-19 — DURABLE-RUN-IDENTITY-OK, focused durable-run test passed

- [x] I-3: inspection redacts patch values and rejects cross-tenant reads
  CHECK: pnpm --filter web exec vitest run src/server/harness-compositions.test.ts
  EXPECT: /HARNESS-INSPECTION-OK/
  EVIDENCE: passed 2026-09-19 — HARNESS-INSPECTION-OK, focused inspection test passed

- [x] I-4: the live harness exposes the same composition identity as the persisted record
  CHECK: pnpm --filter @chaste/harness exec vitest run src/runtime.test.ts && pnpm --filter web exec vitest run src/server/harness.test.ts
  EXPECT: /HARNESS-RUNTIME-IDENTITY-OK/
  EVIDENCE: passed 2026-09-19 — HARNESS-RUNTIME-IDENTITY-OK and HARNESS-ADAPTER-OK, focused runtime/adapter tests passed

- [x] I-5: the repository remains type-safe and all behavior passes
  CHECK: pnpm typecheck && pnpm lint && pnpm test --concurrency=1 && echo INSPECTION-SEQUENCE-OK
  EXPECT: INSPECTION-SEQUENCE-OK
  EVIDENCE: passed 2026-09-19 — INSPECTION-SEQUENCE-OK; typecheck completed 26 tasks, lint reported 0 errors and 178 warnings, and sequential Turbo tests completed 24 tasks with web at 38 files / 289 tests
