# Gates: evaluation harness

OWNS: GATES-EVALUATION.md, CHANGELOG.md, ROADMAP.md, .env.example, docs/strategy/2026-10-19-post-migration-agentic-erp.md, docs/adr/0088-agent-evaluations-run-against-fixtures.md, docs/adr/README.md, docs/migration/route-ownership.json, docs/migration/route-ownership-overrides.json, scripts/migration/route-ownership.test.mjs, apps/api/cmd/api/main.go, apps/api/internal/httpapi/chat_provider.go, apps/api/internal/httpapi/messaging_agent_session.go, apps/api/internal/httpapi/evaluations.go, apps/api/internal/httpapi/evaluations_http.go, apps/api/internal/httpapi/evaluations_route.go, apps/api/internal/httpapi/evaluations_test.go, apps/api/internal/httpapi/evaluations_live_test.go, apps/api/internal/httpapi/evaluations_store.go, apps/api/internal/httpapi/evaluations_baseline_test.go, apps/api/internal/httpapi/evaluations_persistence_integration_test.go, packages/db/src/schema/index.ts, packages/db/drizzle/0141_neat_young_avengers.sql, packages/db/drizzle/meta/_journal.json, packages/db/drizzle/meta/0141_snapshot.json, apps/web-vite/src/api/evaluations.ts, apps/web-vite/src/components/EvaluationPanel.tsx, apps/web-vite/src/components/EvaluationPanel.css, apps/web-vite/src/components/EvaluationPanel.test.tsx, apps/web-vite/src/components/SettingsPage.tsx

Scope: Add an admin-only live evaluation harness inside the existing ERP Settings page, with fixture-backed tool scenarios, DeepSeek flash live runs, durable run history, pass-rate trends, a partial receipt scenario, an 80% baseline, stored-run detail, a scripted baseline, and a browser proof.

- [x] G1: The slice records the fixture-evaluation design, its limits, and the live model configuration.
  EVIDENCE: Reviewed docs/adr/0088-agent-evaluations-run-against-fixtures.md, .env.example, and the strategy note. The ADR records that tool calls are answered from fixtures, live runs use DeepSeek flash without fallback, the surface is an admin-only Settings tab, and run evidence is stored per workspace with row level security. Scenario checks verify tool arguments, the pending-approval result, and false completion claims, not only tool names.

- [x] G2: The runner passes expected tool choices, fails forbidden tool calls, reports provider errors, and the HTTP handler enforces admin access.
  CHECK: go -C apps/api test ./internal/httpapi -run '^TestEvaluation' -count=1 -v
  EXPECT: /--- PASS: TestEvaluationRunnerPassesExpectedToolChoice/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=c19a8b953fb6c76aa42714ab8918ff9e87b6e496da22a4159ae06257a0159380; output-bytes=1270

- [x] G3: A live DeepSeek flash run completes and passes the low-stock proposal checks.
  CHECK: set -a; . ./.env; set +a; EVALUATION_LIVE=1 go -C apps/api test ./internal/httpapi -run '^TestLiveEvaluationAgainstDeepSeek$' -count=1 -v
  EXPECT: /--- PASS: TestLiveEvaluationAgainstDeepSeek/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=82df886435f7e3b24fde7b9733fe873afa1b74ff0a1fac2846b723460e9f306f; output-bytes=2798

- [x] G4: The Quality tab renders inside Settings, runs a scenario, shows checks, token usage, durable history, an 80% baseline, last-five trends, and stored-run detail, and keeps the missing-key and admin-only states honest.
  CHECK: cd apps/web-vite && pnpm exec vitest run src/components/EvaluationPanel.test.tsx src/components/SettingsPage.test.tsx
  EXPECT: /30 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=26462bd20ef50e874d1a4027865c87ff0db8d048b6f47ab9bb64e0b306257ae8; output-bytes=1708

- [x] G5: The new evaluation routes are declared in the route ownership manifest and the check passes.
  CHECK: pnpm migration:routes:check
  EXPECT: Routes:
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=f4b299a41c9dc804c384ec5151dbc1bb78febc79f940be8e591813ff33371a0b; output-bytes=95

- [x] G6: The Go workspace tests and vet pass.
  CHECK: pnpm go:verify
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\//
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=bd166cef94809ab7248c2ec1736b00fe5198cf08f6a6694e748197e08b44c6b4; output-bytes=2110

- [x] G7: The full TypeScript test suite passes.
  CHECK: pnpm test
  EXPECT: /Tasks:\s+3 successful, 3 total/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=cbaea1cce9ce508de5c2de354d60b5484d174133223a4bb1c98063789f7ececf; output-bytes=2840

- [x] G8: The TypeScript workspace typechecks.
  CHECK: pnpm typecheck && echo TYPECHECK_OK
  EXPECT: TYPECHECK_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=71806da30e8a8f779548dc96c562f20b31bd20ad17f4a049424749df60931640; output-bytes=605

- [x] G9: The workspace lints without errors.
  CHECK: pnpm lint >/tmp/chaste-evaluation-lint.log 2>&1; code=$?; tail -3 /tmp/chaste-evaluation-lint.log; test "$code" -eq 0 && echo LINT_OK
  EXPECT: LINT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=732193b20bb040442409823eec398b1313131e6c5a196785209ff30b2b826e1b; output-bytes=121

- [x] G10: The touched Go files are gofmt-clean.
  CHECK: test -z "$(gofmt -l apps/api/cmd/api/main.go apps/api/internal/httpapi/chat_provider.go apps/api/internal/httpapi/messaging_agent_session.go apps/api/internal/httpapi/evaluations.go apps/api/internal/httpapi/evaluations_http.go apps/api/internal/httpapi/evaluations_route.go apps/api/internal/httpapi/evaluations_test.go apps/api/internal/httpapi/evaluations_live_test.go apps/api/internal/httpapi/evaluations_store.go apps/api/internal/httpapi/evaluations_baseline_test.go apps/api/internal/httpapi/evaluations_persistence_integration_test.go)" && echo GOFMT_OK
  EXPECT: GOFMT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=ae515ebb8fbd7a381d8c80902ce678e549e238008dae29a24c4fa4f5963613b6; output-bytes=9

- [x] G11: The Quality tab runs every scenario live in the existing ERP Settings page, every run passes, and the browser reports no console or page errors.
  EVIDENCE: agent-browser session quality-1c0a3ce4b4a1 opened http://localhost:3000/settings, switched to the Quality tab, and ran all three scenarios. Results: low-stock passed in 7.0s (8,757 input, 1,012 output, 7,808 cached tokens), incoming-cover passed in 5.1s, missing-history passed in 7.6s. After the review tightened the checks, a fresh browser session re-ran low-stock against the rebuilt API: passed in 7.2s with supplier, quantity, pending-approval, and no-false-claim checks all green. After persistence landed, a third fresh session ran low-stock in 8.4s and the Quality tab showed a durable Run history: 1 run, 1 passed, 100% pass rate, and a 1/1 per-scenario trend. A fourth session ran the partial-receipt scenario in 6.3s; it passed the order-number, remain, and no-duplicate checks, history grew to 2 runs at 100% with Baseline 80% met, and opening the stored run showed its tool trace and final answer. Console had only Vite/React dev messages, errors was empty, and the screenshots are /tmp/chaste-quality.png, /tmp/chaste-quality-recheck.png, /tmp/chaste-quality-history.png, and /tmp/chaste-quality-partial.png.

- [x] G12: A completed evaluation persists in `evaluation_runs` under the active organization and appears in the recent history response.
  CHECK: set -a; . ./.env; set +a; GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/httpapi -run '^TestEvaluationRunPersistenceIntegration$' -count=1 -v
  EXPECT: /--- PASS: TestEvaluationRunPersistenceIntegration/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=a75213db17e4ce4d8133ae469272d9749ba26d2a4e695fa45dcae9fa35d7adec; output-bytes=192

- [x] G13: The deterministic scripted baseline passes every scenario, so a fixture or check drift fails the normal Go suite.
  CHECK: go -C apps/api test ./internal/httpapi -run '^TestScriptedEvaluationBaseline$' -count=1 -v
  EXPECT: /--- PASS: TestScriptedEvaluationBaseline/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=d6e2bcc7dac95753caf3b9115bd55b9e08b9a091ced17c2170bea6ab93334b3f; output-bytes=774
