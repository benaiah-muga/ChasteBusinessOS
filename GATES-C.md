# Gates: versioned money proposals and quote lines

OWNS: GATES-C.md, CHANGELOG.md, ROADMAP.md, docs/adr/0089-versioned-money-approvals-and-quote-lines.md, docs/adr/README.md, docs/strategy/2026-10-19-post-migration-agentic-erp.md, apps/api/internal/capability/executor.go, apps/api/internal/capability/approval_test.go, apps/api/internal/capability/purchasing_requests.go, apps/api/internal/capability/purchasing_requests_test.go, apps/api/internal/httpapi/approval_inbox.go, packages/db/src/schema/index.ts, packages/db/drizzle/0142_moaning_peter_parker.sql, packages/db/drizzle/meta/_journal.json, packages/db/drizzle/meta/0142_snapshot.json, packages/db/drizzle/0143_amazing_serpent_society.sql, packages/db/drizzle/meta/0143_snapshot.json

Scope: version purchase-order and quote-award money approvals, supersede older pending versions, and award quotes from real lines instead of a synthetic single line.

- [x] G1: The slice records the versioning rule, its purchase-only scope, and the line-level quote decision.
  EVIDENCE: ADR 0089 records that only purchasing.createPurchaseOrder and purchasing.selectWinningQuote version approvals, that the payload hash remains the authority binding, that quote lines must total amountMinor, and that legacy quotes keep the synthetic line.

- [x] G2: A revised money proposal supersedes the earlier pending version and links it.
  CHECK: go -C apps/api test ./internal/capability -run '^TestNewMoneyApprovalVersionSupersedesPriorPendingProposal$' -count=1 -v
  EXPECT: /--- PASS: TestNewMoneyApprovalVersionSupersedesPriorPendingProposal/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=d079e904776318631c98d393940e34bb98e78f469d8dd1c637a9a191601c1353; output-bytes=231

- [x] G3: A quote with real lines awards a multi-line purchase order, and mismatched line totals are rejected.
  CHECK: go -C apps/api test ./internal/capability -run '^TestPurchasingRequestsAwardUsesQuoteLines$|^TestParseRecordQuoteLinesMustMatchAmount$' -count=1 -v
  EXPECT: /--- PASS: TestPurchasingRequestsAwardUsesQuoteLines/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=c36c89c27f16ce4fa0025a87934bce2ca50b8cb6e558b468810b4d76052ae313; output-bytes=309

- [x] G4: Both migrations apply cleanly and the RLS probe suite passes.
  CHECK: pnpm --filter @chaste/db test >/tmp/chaste-gatec-db.log 2>&1; code=$?; tail -3 /tmp/chaste-gatec-db.log; test "$code" -eq 0 && echo DB_TESTS_OK
  EXPECT: DB_TESTS_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=4652fa70e5603b737d8498b6626a31a3f178524e573134ef3ababc74c9bea186; output-bytes=144

- [x] G5: The Go workspace tests and vet pass.
  CHECK: pnpm go:verify
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\//
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=ae168e4dc36215aaebff4a976107d5ff8db5e4d65c9fdc8c9993574ffbda5292; output-bytes=2105

- [ ] G6: The full TypeScript test suite passes.
  CHECK: pnpm test
  EXPECT: /Tasks:\s+3 successful, 3 total/

- [x] G7: The TypeScript workspace typechecks and lints.
  CHECK: pnpm typecheck && pnpm lint >/tmp/chaste-gatec-lint.log 2>&1; code=$?; tail -2 /tmp/chaste-gatec-lint.log; test "$code" -eq 0 && echo TYPES_LINT_OK
  EXPECT: TYPES_LINT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=b52dd6ba3055b0f2bb9ee9081c440580958332a2d11d201d82149a2c44256988; output-bytes=669

- [x] G8: The touched Go files are gofmt-clean.
  CHECK: test -z "$(gofmt -l apps/api/internal/capability/executor.go apps/api/internal/capability/approval_test.go apps/api/internal/capability/purchasing_requests.go apps/api/internal/capability/purchasing_requests_test.go apps/api/internal/httpapi/approval_inbox.go)" && echo GOFMT_OK
  EXPECT: GOFMT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=ae515ebb8fbd7a381d8c80902ce678e549e238008dae29a24c4fa4f5963613b6; output-bytes=9

- [x] G9: The approval inbox still loads after the version columns were added, with no browser errors.
  EVIDENCE: agent-browser session gatec-1c0a3ce4b4a1 signed in to the ERP, opened http://localhost:3000/approvals, and received the normal inbox-zero state with no page errors. The test workspace had no pending approvals to render version metadata. Screenshot: /tmp/chaste-approvals-gatec.png.
