# Gates: evaluation harness

OWNS: GATES-EVALUATION.md, CHANGELOG.md, ROADMAP.md, .env.example, docs/strategy/2026-10-19-post-migration-agentic-erp.md, docs/adr/0088-agent-evaluations-run-against-fixtures.md, docs/adr/README.md, docs/migration/route-ownership.json, docs/migration/route-ownership-overrides.json, scripts/migration/route-ownership.test.mjs, apps/api/cmd/api/main.go, apps/api/internal/httpapi/chat_provider.go, apps/api/internal/httpapi/messaging_agent_session.go, apps/api/internal/httpapi/evaluations.go, apps/api/internal/httpapi/evaluations_http.go, apps/api/internal/httpapi/evaluations_route.go, apps/api/internal/httpapi/evaluations_test.go, apps/api/internal/httpapi/evaluations_live_test.go, apps/api/internal/httpapi/evaluations_store.go, apps/api/internal/httpapi/evaluations_baseline_test.go, apps/api/internal/capability/agent_tools.go, .github/workflows/evaluation-nightly.yml, docs/migration/route-ownership-overrides.json, docs/migration/route-ownership.json, scripts/migration/route-ownership.test.mjs, apps/api/internal/httpapi/evaluations_persistence_integration_test.go, packages/db/src/schema/index.ts, packages/db/drizzle/0141_neat_young_avengers.sql, packages/db/drizzle/meta/_journal.json, packages/db/drizzle/meta/0141_snapshot.json, apps/web-vite/src/api/evaluations.ts, apps/web-vite/src/components/EvaluationPanel.tsx, apps/web-vite/src/components/EvaluationPanel.css, apps/web-vite/src/components/EvaluationPanel.test.tsx, apps/web-vite/src/components/SettingsPage.tsx

Scope: Add an admin-only live evaluation harness inside the existing ERP Settings page, with fixture-backed tool scenarios, DeepSeek flash live runs, durable run history, release metrics, model comparison, a configurable baseline, bounded retention, seven scenarios, a scripted baseline, a nightly workflow, and a browser proof.

- [x] G1: The slice records the fixture-evaluation design, its limits, and the live model configuration.
  EVIDENCE: Reviewed docs/adr/0088-agent-evaluations-run-against-fixtures.md, .env.example, and the strategy note. The ADR records that tool calls are answered from fixtures, live runs use DeepSeek flash without fallback, the surface is an admin-only Settings tab, run evidence is stored per workspace with row level security, the baseline is configurable, and a nightly workflow runs the scripted and live cases. Seven scenarios cover inventory, purchasing, and receivables, and the checks verify tool arguments, pending-approval results, and false completion claims, not only tool names.

- [x] G2: The runner passes expected tool choices, fails forbidden tool calls, reports provider errors, and the HTTP handler enforces admin access.
  CHECK: go -C apps/api test ./internal/httpapi -run '^TestEvaluation' -count=1 -v
  EXPECT: /--- PASS: TestEvaluationRunnerPassesExpectedToolChoice/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=3c9f158462a18bb3111cc24ba9fae2356ba0c84874947a4efc5a4a663f08000f; output-bytes=1270

- [x] G3: A live DeepSeek flash run completes and passes the low-stock proposal checks.
  CHECK: set -a; . ./.env; set +a; EVALUATION_LIVE=1 go -C apps/api test ./internal/httpapi -run '^TestLiveEvaluationAgainstDeepSeek$' -count=1 -v
  EXPECT: /--- PASS: TestLiveEvaluationAgainstDeepSeek/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=3c239f519e3c73d548e702aebcc1a66e7984eaa5062fed3d8d036dac9bb94c0a; output-bytes=2992

- [x] G4: The Quality tab renders inside Settings, runs a scenario, shows checks, token usage, durable history, a configurable baseline, release metrics, model comparison, last-five trends, and stored-run detail, and keeps the missing-key and admin-only states honest.
  CHECK: cd apps/web-vite && pnpm exec vitest run src/components/EvaluationPanel.test.tsx src/components/SettingsPage.test.tsx
  EXPECT: /32 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=a3df27b091e848cca0de8cc3e75068c105e23ce3693941fd0f52e2e11637ba9b; output-bytes=2542

- [x] G5: The new evaluation routes are declared in the route ownership manifest and the check passes.
  CHECK: pnpm migration:routes:check
  EXPECT: Routes:
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=a2c3c698a6f602e6a219c348069d35c07be1e451ebf76e78a3d49f2a973ccba7; output-bytes=95

- [x] G6: The Go workspace tests and vet pass.
  CHECK: pnpm go:verify
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\//
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=f839a019388b1cc44f9fad4bd595a23fc9901fb0892c07e894b4861609675eb3; output-bytes=2110

- [x] G7: The full TypeScript test suite passes.
  CHECK: pnpm test
  EXPECT: /Tasks:\s+3 successful, 3 total/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=59a583194b8221ff1e7d5346ad5533ed9ad78706eee39bb5ae6f0f8838e72c74; output-bytes=2843

- [x] G8: The TypeScript workspace typechecks.
  CHECK: pnpm typecheck && echo TYPECHECK_OK
  EXPECT: TYPECHECK_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=d8567c757663d00cb4db4dc447053e9c7c33f758c07c5ff78e4a09955b93960c; output-bytes=605

- [x] G9: The workspace lints without errors.
  CHECK: pnpm lint >/tmp/chaste-evaluation-lint.log 2>&1; code=$?; tail -3 /tmp/chaste-evaluation-lint.log; test "$code" -eq 0 && echo LINT_OK
  EXPECT: LINT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=732193b20bb040442409823eec398b1313131e6c5a196785209ff30b2b826e1b; output-bytes=121

- [x] G10: The touched Go files are gofmt-clean.
  CHECK: test -z "$(gofmt -l apps/api/cmd/api/main.go apps/api/internal/httpapi/chat_provider.go apps/api/internal/httpapi/messaging_agent_session.go apps/api/internal/httpapi/evaluations.go apps/api/internal/httpapi/evaluations_http.go apps/api/internal/httpapi/evaluations_route.go apps/api/internal/httpapi/evaluations_test.go apps/api/internal/httpapi/evaluations_live_test.go apps/api/internal/httpapi/evaluations_store.go apps/api/internal/httpapi/evaluations_baseline_test.go apps/api/internal/httpapi/evaluations_persistence_integration_test.go apps/api/internal/capability/agent_tools.go)" && echo GOFMT_OK
  EXPECT: GOFMT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=ae515ebb8fbd7a381d8c80902ce678e549e238008dae29a24c4fa4f5963613b6; output-bytes=9

- [x] G11: The Quality tab runs every scenario live in the existing ERP Settings page, every run passes, and the browser reports no console or page errors.
  EVIDENCE: agent-browser session quality-1c0a3ce4b4a1 opened http://localhost:3000/settings, switched to the Quality tab, and ran all three scenarios. Results: low-stock passed in 7.0s (8,757 input, 1,012 output, 7,808 cached tokens), incoming-cover passed in 5.1s, missing-history passed in 7.6s. After the review tightened the checks, a fresh browser session re-ran low-stock against the rebuilt API: passed in 7.2s with supplier, quantity, pending-approval, and no-false-claim checks all green. After persistence landed, a third fresh session ran low-stock in 8.4s and the Quality tab showed a durable Run history: 1 run, 1 passed, 100% pass rate, and a 1/1 per-scenario trend. A fourth session ran the partial-receipt scenario in 6.3s; it passed the order-number, remain, and no-duplicate checks, history grew to 2 runs at 100% with Baseline 80% met, and opening the stored run showed its tool trace and final answer. A fifth session saved a configurable 85% baseline, ran the quote-award scenario in 6.0s with the RFQ, pending-approval, and no-false-claim checks green, and saw 3 runs at 100%, model comparison for deepseek-flash, and Release metrics. Console had only Vite/React dev messages, errors was empty, and the screenshots are /tmp/chaste-quality.png, /tmp/chaste-quality-recheck.png, /tmp/chaste-quality-history.png, /tmp/chaste-quality-partial.png, and /tmp/chaste-quality-gatef.png.

- [x] G12: A completed evaluation persists in `evaluation_runs` under the active organization and appears in the recent history response.
  CHECK: set -a; . ./.env; set +a; GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/httpapi -run '^TestEvaluationRunPersistenceIntegration$' -count=1 -v
  EXPECT: /--- PASS: TestEvaluationRunPersistenceIntegration/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=abebb01ccb2066166abf86865447ff21efda5d18a3f23658ba2d0bc1d84813d1; output-bytes=192

- [x] G13: The deterministic scripted baseline passes every scenario, so a fixture or check drift fails the normal Go suite.
  CHECK: go -C apps/api test ./internal/httpapi -run '^TestScriptedEvaluationBaseline$' -count=1 -v
  EXPECT: /--- PASS: TestScriptedEvaluationBaseline/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=749003f55c21529e3cb7fea00539bb2eb4976182d5a6a3dc1d73b77e75e1f163; output-bytes=1174

- [x] G14: The workspace baseline is configurable, persists through the organization settings, and round-trips through the API.
  CHECK: set -a; . ./.env; set +a; GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/httpapi -run '^TestEvaluationRunPersistenceIntegration$' -count=1 -v
  EXPECT: /--- PASS: TestEvaluationRunPersistenceIntegration/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=959b24a7bc32d73518c36a43990a646c2b992d2d2bff8d64cdaac5158121651c; output-bytes=192

- [x] G15: A nightly workflow runs the scripted baseline and the live evaluation when the DeepSeek secret exists.
  EVIDENCE: Added .github/workflows/evaluation-nightly.yml with a daily 02:00 UTC schedule and manual dispatch. The scripted baseline job always runs. The live job runs TestLiveEvaluationAgainstDeepSeek when DEEPSEEK_API_KEY is present and records an explicit skip in the step summary when it is absent.
