# Composition Approval Gates

This ledger owns the governed approval boundary for persisted harness compositions.

OWNS: apps/web/src/server/harness-approval.ts, apps/web/src/server/harness-approval.test.ts, apps/web/src/server/durable-coordinator.ts, apps/web/src/server/durable-coordinator.test.ts, apps/web/src/server/kernel.ts, scripts/gates/durable-po-run.ts, docs/adr/0062-harness-composition-approval.md, PLAN.md, CHANGELOG.md

- [x] A-0: this ledger contains executable acceptance outcomes
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-APPROVAL.md
  EXPECT: LINT OK
  EVIDENCE: passed 2026-09-19 — gate-lint returned LINT OK

- [x] A-1: request through the existing approval authority
  CHECK: pnpm --filter web exec vitest run src/server/harness-approval.test.ts
  EXPECT: /HARNESS-APPROVAL-REQUEST-OK/
  EVIDENCE: passed 2026-09-19 — idempotent pending request marker emitted

- [x] A-2: approve/reject exact composition identity
  CHECK: pnpm --filter web exec vitest run src/server/harness-approval.test.ts
  EXPECT: /HARNESS-APPROVAL-DECISION-OK.*HARNESS-APPROVAL-FAIL-CLOSED-OK/s
  EVIDENCE: passed 2026-09-19 — rejection, exact approval, and mismatched identity markers emitted

- [x] A-3: coordinator requires executed approval
  CHECK: pnpm --filter web exec vitest run src/server/durable-coordinator.test.ts
  EXPECT: /PROFILE-AWARE-RUN-OK.*PROFILE-AWARE-FAIL-CLOSED-OK/s
  EVIDENCE: passed 2026-09-19 — approved start and fail-closed coordinator markers emitted

- [x] A-4: canonical pilot uses the approval path
  CHECK: DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 pnpm tsx --tsconfig apps/web/tsconfig.json scripts/gates/durable-po-run.ts
  EXPECT: /DURABLE-PO-RUN-OK/
  EVIDENCE: passed 2026-09-19 — canonical durable PO proof completed after composition approval

- [x] A-5: full verification gate
  CHECK: DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 pnpm typecheck && pnpm lint && DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 pnpm test --concurrency=1
  EXPECT: exit 0
  EVIDENCE: passed 2026-09-19 — typecheck 26 tasks, lint 0 errors / 187 warnings, serialized workspace tests passed; web 41 files / 297 tests
