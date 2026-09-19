# Gates: enterprise engine sequence

OWNS: PLAN.md, GATES-ENGINE.md, packages/db/**, packages/kernel/**, apps/web/src/server/**, apps/web/src/app/api/**, apps/web/src/app/(app)/**, modules/creator/**, scripts/**, docs/adr/**, CHANGELOG.md

Scope: durable runs, canonical replay, the supervised purchasing pilot, capability-gap handling, and isolated Creator delivery.

- [x] G0: this ledger states executable outcomes that can fail
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-ENGINE.md
  EXPECT: LINT OK
  EVIDENCE: passed 2026-09-19 — gate-lint returned LINT OK

- [x] DR-1: a run and its steps persist with state, version, input digest, and receipt linkage
  CHECK: pnpm --filter web exec vitest run src/server/durable-runs.test.ts
  EXPECT: /DURABLE-RUN-CONTRACT-OK/
  EVIDENCE: passed 2026-09-19 — 2 tests, DURABLE-RUN-CONTRACT-OK

- [x] DR-2: the shortage-to-approved-PO run resumes after a worker crash and leaves exactly one PO
  CHECK: pnpm tsx --tsconfig apps/web/tsconfig.json scripts/gates/durable-po-run.ts
  EXPECT: /DURABLE-PO-RUN-OK/
  EVIDENCE: passed 2026-09-19 — DURABLE-PO-RUN-OK through the profile-aware coordinator (one PO, one receipt, committed step)

- [x] RP-1: replay uses stored observations and creates no second governed effect
  CHECK: pnpm --filter web exec vitest run src/server/replay.test.ts
  EXPECT: /TRUE-REPLAY-OK/
  EVIDENCE: passed 2026-09-19 — 2 tests, TRUE-REPLAY-OK

- [x] PILOT-1: the purchasing pilot completes through human and agent adapters with the same business postconditions
  CHECK: pnpm tsx --tsconfig apps/web/tsconfig.json scripts/gates/supervised-pilot.ts
  EXPECT: /SUPERVISED-PILOT-OK/
  EVIDENCE: passed 2026-09-19 — SUPERVISED-PILOT-OK (same PO status, quantity, unit price, and total)

- [x] GAP-1: an unavailable capability produces a durable feature-gap ticket with a desired-behavior contract and no invented execution
  CHECK: pnpm --filter web exec vitest run src/server/capability-gaps.test.ts
  EXPECT: /CAPABILITY-GAP-OK/
  EVIDENCE: passed 2026-09-19 — 2 tests, CAPABILITY-GAP-OK

- [x] CREATOR-1: a sanitized gap becomes an independently verified candidate in an isolated worktree with an artifact digest and rollback record
  CHECK: pnpm tsx --tsconfig apps/web/tsconfig.json scripts/gates/creator-isolation.ts
  EXPECT: /CREATOR-ISOLATION-OK/
  EVIDENCE: passed 2026-09-19 — CREATOR-ISOLATION-OK (candidate remains in_review; no generated code executed)

- [x] INT-1: the complete user → agent → capability → approval → effect → replay → gap → candidate flow passes the repository gate
  CHECK: pnpm typecheck && pnpm lint && pnpm test && echo ENGINE-SEQUENCE-OK
  EXPECT: ENGINE-SEQUENCE-OK
  EVIDENCE: passed 2026-09-19 — pnpm typecheck, pnpm lint, and pnpm test passed; 286 tests in 36 files, 23 test tasks successful
