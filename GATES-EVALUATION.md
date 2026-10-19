# Gates: evaluation harness

OWNS: GATES-EVALUATION.md, CHANGELOG.md, ROADMAP.md, .env.example, docs/strategy/2026-10-19-post-migration-agentic-erp.md, docs/adr/0088-agent-evaluations-run-against-fixtures.md, docs/adr/README.md, docs/migration/route-ownership.json, docs/migration/route-ownership-overrides.json, scripts/migration/route-ownership.test.mjs, apps/api/cmd/api/main.go, apps/api/internal/httpapi/chat_provider.go, apps/api/internal/httpapi/messaging_agent_session.go, apps/api/internal/httpapi/evaluations.go, apps/api/internal/httpapi/evaluations_http.go, apps/api/internal/httpapi/evaluations_route.go, apps/api/internal/httpapi/evaluations_test.go, apps/api/internal/httpapi/evaluations_live_test.go, apps/web-vite/src/api/evaluations.ts, apps/web-vite/src/components/EvaluationPanel.tsx, apps/web-vite/src/components/EvaluationPanel.css, apps/web-vite/src/components/EvaluationPanel.test.tsx, apps/web-vite/src/components/SettingsPage.tsx

Scope: Add an admin-only live evaluation harness inside the existing ERP Settings page, with fixture-backed tool scenarios, DeepSeek flash live runs, deterministic tests, and a browser proof.

- [x] G1: The slice records the fixture-evaluation design, its limits, and the live model configuration.
  EVIDENCE: Reviewed docs/adr/0088-agent-evaluations-run-against-fixtures.md, .env.example, and the strategy note. The ADR records that tool calls are answered from fixtures, live runs use DeepSeek flash without fallback, the surface is an admin-only Settings tab, and history/persistence are deferred. Scenario checks verify tool arguments, the pending-approval result, and false completion claims, not only tool names.

- [x] G2: The runner passes expected tool choices, fails forbidden tool calls, reports provider errors, and the HTTP handler enforces admin access.
  CHECK: go -C apps/api test ./internal/httpapi -run '^TestEvaluation' -count=1 -v
  EXPECT: /--- PASS: TestEvaluationRunnerPassesExpectedToolChoice/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=39fa546e749d7ba446d19fcbb011256777842cd396c888ee180b17aab52ba8fd; output-bytes=1042

- [x] G3: A live DeepSeek flash run completes and passes the low-stock proposal checks.
  CHECK: set -a; . ./.env; set +a; EVALUATION_LIVE=1 go -C apps/api test ./internal/httpapi -run '^TestLiveEvaluationAgainstDeepSeek$' -count=1 -v
  EXPECT: /--- PASS: TestLiveEvaluationAgainstDeepSeek/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=5702d67f0f8b63eb66c02fd52d5f57843b3ecb850e7162acbd0d81f70873b5d2; output-bytes=4041

- [x] G4: The Quality tab renders inside Settings, runs a scenario, shows checks and token usage, and keeps the missing-key and admin-only states honest.
  CHECK: cd apps/web-vite && pnpm exec vitest run src/components/EvaluationPanel.test.tsx src/components/SettingsPage.test.tsx
  EXPECT: /22 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=3afdae0b4678355c57946a2b3d509f48b02b70a378170286ef80ba4c4412bd6d; output-bytes=1431

- [x] G5: The new evaluation routes are declared in the route ownership manifest and the check passes.
  CHECK: pnpm migration:routes:check
  EXPECT: Routes:
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=f4b299a41c9dc804c384ec5151dbc1bb78febc79f940be8e591813ff33371a0b; output-bytes=95

- [x] G6: The Go workspace tests and vet pass.
  CHECK: pnpm go:verify
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\//
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=105ea6a16beef4acfab0eab109892e3bab82f601e20b50251e87f8d3020173cf; output-bytes=2110

- [x] G7: The full TypeScript test suite passes.
  CHECK: pnpm test
  EXPECT: /Tasks:\s+3 successful, 3 total/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=e4718d72d45f66a6058d3361715a1e737a26b48d3cf8c2121d69ae0bfff71a4c; output-bytes=2841

- [x] G8: The TypeScript workspace typechecks.
  CHECK: pnpm typecheck && echo TYPECHECK_OK
  EXPECT: TYPECHECK_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=e93e4b9b90ffae6caad6a100724de9e593774ac962c990c9bd8a64c57fa2a8d3; output-bytes=605

- [x] G9: The workspace lints without errors.
  CHECK: pnpm lint >/tmp/chaste-evaluation-lint.log 2>&1; code=$?; tail -3 /tmp/chaste-evaluation-lint.log; test "$code" -eq 0 && echo LINT_OK
  EXPECT: LINT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=732193b20bb040442409823eec398b1313131e6c5a196785209ff30b2b826e1b; output-bytes=121

- [x] G10: The touched Go files are gofmt-clean.
  CHECK: test -z "$(gofmt -l apps/api/cmd/api/main.go apps/api/internal/httpapi/chat_provider.go apps/api/internal/httpapi/messaging_agent_session.go apps/api/internal/httpapi/evaluations.go apps/api/internal/httpapi/evaluations_http.go apps/api/internal/httpapi/evaluations_route.go apps/api/internal/httpapi/evaluations_test.go apps/api/internal/httpapi/evaluations_live_test.go)" && echo GOFMT_OK
  EXPECT: GOFMT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=ae515ebb8fbd7a381d8c80902ce678e549e238008dae29a24c4fa4f5963613b6; output-bytes=9

- [x] G11: The Quality tab runs all three scenarios live in the existing ERP Settings page, every run passes, and the browser reports no console or page errors.
  EVIDENCE: agent-browser session quality-1c0a3ce4b4a1 opened http://localhost:3000/settings, switched to the Quality tab, and ran all three scenarios. Results: low-stock passed in 7.0s (8,757 input, 1,012 output, 7,808 cached tokens), incoming-cover passed in 5.1s, missing-history passed in 7.6s. After the review tightened the checks, a fresh browser session re-ran low-stock against the rebuilt API: passed in 7.2s with supplier, quantity, pending-approval, and no-false-claim checks all green. Console had only Vite/React dev messages, errors was empty, and the screenshots are /tmp/chaste-quality.png and /tmp/chaste-quality-recheck.png.
