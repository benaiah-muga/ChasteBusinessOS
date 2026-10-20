# Gates: persistent operating records and Workmate cards

OWNS: GATES-DE.md, CHANGELOG.md, ROADMAP.md, docs/adr/0090-persistent-operating-records-and-cards.md, docs/adr/README.md, docs/strategy/2026-10-19-post-migration-agentic-erp.md, apps/api/internal/capability/operations_records.go, apps/api/internal/capability/operations_records_test.go, apps/api/internal/capability/executor.go, apps/api/internal/capability/approval.go, apps/api/internal/capability/agent_tools.go, apps/api/internal/httpapi/chat_loop.go, apps/api/internal/httpapi/modules.go, apps/api/internal/httpapi/modules_test.go, apps/api/internal/httpapi/modules_write_test.go, apps/api/internal/httpapi/scim_read_integration_test.go, apps/api/internal/httpapi/chat_stream_test.go, apps/web-vite/src/api/chat.ts, apps/web-vite/src/chat-store.ts, apps/web-vite/src/components/ChatTranscript.tsx, apps/web-vite/src/components/WorkmateRecordCard.tsx, apps/web-vite/src/components/WorkmateRecordCard.css, apps/web-vite/src/components/WorkmateRecordCard.test.tsx, apps/web-vite/src/components/ChatPage.test.tsx, docs/migration/go-capability-overrides.json, docs/migration/capabilities.json, packages/db/src/schema/index.ts, packages/db/drizzle/0144_daily_joystick.sql, packages/db/drizzle/meta/_journal.json, packages/db/drizzle/meta/0144_snapshot.json

Scope: persist business objectives, deduplicated exceptions, and Decision Records as operating records, expose them through governed capabilities, and render read-only exception, progress, waiting, and result cards in Workmate.

- [x] G1: The slice records the record model, stable-key deduplication, type-specific JSON details, and why cards are not approvals.
  EVIDENCE: ADR 0090 records the single operating-record table, revisioned stable-key upsert, operations module always enabled, card derivation, and the one-card-per-turn limitation.

- [x] G2: An exception upserts once, increments revision, resolves deduplication, and returns an exception card; decision records return result cards.
  CHECK: set -a; . ./.env; set +a; GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/capability -run '^TestOperationalRecordsPersistDeduplicateAndCard$' -count=1 -v
  EXPECT: /--- PASS: TestOperationalRecordsPersistDeduplicateAndCard/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=0963746abe5d9ba40cc3f5830d36dee8cb928cfa686e9ea448ba40522d983449; output-bytes=211

- [x] G3: Workmate renders exception, progress, waiting, and result cards with accessible text and bounded evidence.
  CHECK: cd apps/web-vite && pnpm exec vitest run src/components/WorkmateRecordCard.test.tsx src/components/ChatPage.test.tsx
  EXPECT: /19 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=779431ba74c80e9a259a50dbbdc52fc1694e927a2040bab0ff987e23aeb25d3d; output-bytes=730

- [x] G4: The operations module is protected, always enabled, and its records remain organization-scoped under RLS.
  CHECK: pnpm --filter @chaste/db test >/tmp/chaste-gatede-db.log 2>&1; code=$?; tail -3 /tmp/chaste-gatede-db.log; test "$code" -eq 0 && echo DB_TESTS_OK
  EXPECT: DB_TESTS_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=17f5336372b365344a6711fe09fccf414ea200e00b622b806bfb5c40c46884f3; output-bytes=147

- [x] G5: The Go workspace tests and vet pass.
  CHECK: pnpm go:verify
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\//
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=e3394582877cd89ee4d5ee9de4130d4777ef7e08d4efad6a4a262b3aca7b84b0; output-bytes=2124

- [x] G6: The full TypeScript test suite passes.
  CHECK: pnpm test
  EXPECT: /Tasks:\s+3 successful, 3 total/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=5063732f8708ed08edc6194433d2013823be1da0cfcf6c449d628dce6df5539d; output-bytes=2840

- [x] G7: The TypeScript workspace typechecks and lints.
  CHECK: pnpm typecheck && pnpm lint >/tmp/chaste-gatede-lint.log 2>&1; code=$?; tail -2 /tmp/chaste-gatede-lint.log; test "$code" -eq 0 && echo TYPES_LINT_OK
  EXPECT: TYPES_LINT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=28b923831945516909d72d743beee5cee68c31feb15ae73861f267a420f419b2; output-bytes=668

- [x] G8: The touched Go files are gofmt-clean.
  CHECK: test -z "$(gofmt -l apps/api/internal/capability/operations_records.go apps/api/internal/capability/operations_records_test.go apps/api/internal/capability/executor.go apps/api/internal/capability/approval.go apps/api/internal/capability/agent_tools.go apps/api/internal/httpapi/chat_loop.go apps/api/internal/httpapi/modules.go apps/api/internal/httpapi/modules_test.go apps/api/internal/httpapi/modules_write_test.go apps/api/internal/httpapi/scim_read_integration_test.go)" && echo GOFMT_OK
  EXPECT: GOFMT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=ae515ebb8fbd7a381d8c80902ce678e549e238008dae29a24c4fa4f5963613b6; output-bytes=9

- [x] G9: A top-level card on a tool result is forwarded to the chat stream, while nested cards are not promoted.
  CHECK: go -C apps/api test ./internal/httpapi -run '^TestChatToolResultCardExtractsTopLevelCardOnly$' -count=1 -v
  EXPECT: /--- PASS: TestChatToolResultCardExtractsTopLevelCardOnly/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=14ffec7dc3456af84eadca7204aafe14038f18d3a41f5d104f75623dffd01092; output-bytes=206
