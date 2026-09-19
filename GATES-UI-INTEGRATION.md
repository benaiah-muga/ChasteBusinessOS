# Gates: integrated operations and Creator surfaces

OWNS: apps/web/src/app/(app)/sessions/page.tsx, apps/web/src/app/(app)/proposals/page.tsx, apps/web/src/app/(app)/approvals/page.tsx, apps/web/src/app/(app)/settings/page.tsx, apps/web/src/app/api/sessions/[id]/replay/route.ts, apps/web/src/app/api/sessions/route.ts, apps/web/src/app/api/sessions/[id]/route.ts, apps/web/src/app/api/durable-runs/route.ts, apps/web/src/app/api/durable-runs/[id]/route.ts, apps/web/src/app/api/capability-gaps/route.ts, apps/web/src/app/api/harness/compositions/route.ts, apps/web/src/app/api/proposals/route.ts, apps/web/src/app/api/creator/evolution/route.ts, apps/web/src/server/ui-surface.test.ts, GATES-UI-INTEGRATION.md, CHANGELOG.md, PLAN.md

Scope: integrate durable runs/replay, capability gaps, Creator releases/canaries, and harness composition inspection into existing sessions, proposals, approvals, and settings surfaces without creating parallel applications.

- [x] G0: gate ledger is structurally valid
  CHECK: node /home/benaiah/.agents/skills/unlazy/scripts/gate-lint.mjs GATES-UI-INTEGRATION.md
  EXPECT: LINT OK
  EVIDENCE: 2026-09-19 — LINT OK (1 advisory manual-gate warning for G7).

- [x] G1: existing sessions surface exposes durable run state and canonical replay
  CHECK: pnpm --filter web exec vitest run src/server/ui-surface.test.ts -t "sessions surface"
  EXPECT: UI-SESSIONS-SURFACE-OK
  EVIDENCE: 2026-09-19 — focused Vitest passed; UI-SESSIONS-SURFACE-OK.

- [x] G2: existing Creator proposals surface exposes capability gaps, releases, and canary evidence
  CHECK: pnpm --filter web exec vitest run src/server/ui-surface.test.ts -t "Creator surface"
  EXPECT: UI-CREATOR-SURFACE-OK
  EVIDENCE: 2026-09-19 — focused Vitest passed; UI-CREATOR-SURFACE-OK.

- [x] G3: existing settings surface exposes tenant-scoped harness composition inspection
  CHECK: pnpm --filter web exec vitest run src/server/ui-surface.test.ts -t "harness surface"
  EXPECT: UI-HARNESS-SURFACE-OK
  EVIDENCE: 2026-09-19 — focused Vitest passed; UI-HARNESS-SURFACE-OK.

- [x] G4: Creator release controls remain approval-gated and fail closed
  CHECK: pnpm --filter web exec vitest run src/server/ui-surface.test.ts -t "release controls"
  EXPECT: UI-RELEASE-CONTROLS-OK
  EVIDENCE: 2026-09-19 — focused Vitest passed; UI-RELEASE-CONTROLS-OK.

- [x] G5: canonical Creator isolation proof remains green
  CHECK: DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 pnpm tsx --tsconfig apps/web/tsconfig.json scripts/gates/creator-isolation.ts
  EXPECT: CREATOR-ISOLATION-OK
  EVIDENCE: 2026-09-19 — CREATOR-ISOLATION-OK.

- [x] G6: repository verification gate passes
  CHECK: pnpm typecheck && pnpm lint && DATABASE_URL=postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2 pnpm test --concurrency=1
  EXPECT: all commands exit 0
  EVIDENCE: 2026-09-19 — typecheck: 26/26; lint: 0 errors (199 existing warnings); test: 24/24 tasks, 43 web files, 304 web tests; all exit 0.

- [ ] G7: runtime browser proof reaches the integrated surfaces
  EVIDENCE: 2026-09-19 — Next MCP compilation clean for integrated routes and browser reached /login; authenticated surface proof awaits a signed-in session.

- [x] G8: graph reflects the completed UI integration
  CHECK: graft build
  EXPECT: command exits 0 and reports parsed/replayed files
  EVIDENCE: 2026-09-19 — graft build exited 0; 2671 nodes, 7420 edges, 470 cards.
