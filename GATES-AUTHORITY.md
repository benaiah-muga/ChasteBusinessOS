# Gates: purchase commitment authority

OWNS: GATES-AUTHORITY.md, CHANGELOG.md, ROADMAP.md, docs/strategy/2026-10-19-post-migration-agentic-erp.md, docs/migration/capabilities.json, docs/migration/go-capability-overrides.json, apps/api/internal/capability/executor.go, apps/api/internal/capability/purchasing_purchase_orders.go, apps/api/internal/capability/purchasing_purchase_orders_test.go, apps/api/internal/capability/purchasing_requests.go, apps/api/internal/capability/commerce_registration_test.go, apps/api/internal/capability/purchasing_authority_test.go, apps/api/internal/httpapi/session_capability.go, apps/api/internal/httpapi/session_capability_test.go, apps/api/internal/jobs/worker_integration_test.go, scripts/demo-m6.ts

Scope: Make purchase commitments require human authority, make system commitments fail closed without a verified approval, reject deactivated suppliers, and require a commitment intent on the public execute route. Cumulative limits and approval versioning are explicitly deferred.

- [x] G1: The slice records what it closes and what it deliberately defers, with the reason each deferred item needs a later record.
  EVIDENCE: Reviewed the Gate C section of docs/strategy/2026-10-19-post-migration-agentic-erp.md and the Unreleased changelog. They record the delivered money classification, system fail-closed behavior, deactivated-vendor rejection, and commitment intent, and they explicitly leave line-level quote commitment, approval versioning, and cumulative mandate limits to the next gate.

- [x] G2: Purchase order creation and quote award are money-risk capabilities with a zero threshold, and the purchase order amount is computed from its lines for the policy check.
  CHECK: go -C apps/api test ./internal/capability -run '^TestCommerceCapabilitiesHaveConsistentGovernance$|^TestCommerceMoneyAmountUsesExactOrFailClosedValues$' -count=1
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\/internal\/capability/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=be591d6e589965e8e30953e5fa9774f82b93e20198911147e9677d4924ce3365; output-bytes=82

- [x] G3: A system purchase-order job without a verified human approval fails closed, and an agent commitment returns a pending approval without writing an order.
  CHECK: set -a; . ./.env; set +a; GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/capability -run '^Test(SystemPurchaseOrderRequiresVerifiedApproval|AgentPurchaseOrderReturnsPendingApprovalWithoutWriting)$' -count=1 -v
  EXPECT: /--- PASS: Test(SystemPurchaseOrderRequiresVerifiedApproval|AgentPurchaseOrderReturnsPendingApprovalWithoutWriting)/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=a57a31534d51c1ce688cd8a22e5922d7c68cc051637f39f78ee31f364a16f49f; output-bytes=357

- [x] G4: A deactivated vendor cannot receive a new purchase commitment through either the direct order or the quote award path.
  CHECK: set -a; . ./.env; set +a; GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/capability -run '^Test(CreatePurchaseOrder|SelectWinningQuote)RejectsDeactivatedVendor$' -count=1 -v
  EXPECT: /--- PASS: Test(CreatePurchaseOrder|SelectWinningQuote)RejectsDeactivatedVendor/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=2c83a84952c7d21bbcdeec0a0805226680742459b4282861f7ca3613b83c63c2; output-bytes=333

- [x] G5: An approved durable purchase-order run still commits exactly one order and receipt after the risk change.
  CHECK: set -a; . ./.env; set +a; GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/jobs -run '^TestDurablePurchaseOrderRunWorkerGateReceiptAndAuditProof$' -count=1 -v
  EXPECT: /--- PASS: TestDurablePurchaseOrderRunWorkerGateReceiptAndAuditProof/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=cf19182b3e4b73f9825e2d05918149cb5befeabb74e35b49eabad470940b4588; output-bytes=627

- [x] G6: The public capability route rejects a money capability without an intent and still accepts a read without one.
  CHECK: go -C apps/api test ./internal/httpapi -run '^TestSessionCapabilityHandlerRequiresCommitmentIntent$' -count=1
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\/internal\/httpapi/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=d6435d3dcb88265793952d00f2fcafa2362fc097ccc883679e0141d0df4bc573; output-bytes=79

- [x] G7a: The Go workspace tests and vet pass.
  CHECK: pnpm go:verify
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\//
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=98176ffc1d564f789f5b8a6afd7855cd5ec8828ac3bd5486f55c15c80d255bb0; output-bytes=2111

- [x] G7b: The full TypeScript test suite passes.
  CHECK: pnpm test
  EXPECT: /Tasks:\s+3 successful, 3 total/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=7eb56860dcce9d8ad96020ac9c97cfd413b4ca719e3c62955aa74a8d0e497abf; output-bytes=2842

- [x] G7c: The TypeScript workspace typechecks.
  CHECK: pnpm typecheck && echo TYPECHECK_OK
  EXPECT: TYPECHECK_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=1a73dcbf1bb98daba7e641e29ccfe3d1e4bb5e9b2934118d0f81dd24d80e0d0e; output-bytes=621

- [x] G7d: The workspace lints without errors.
  CHECK: pnpm lint >/tmp/chaste-authority-lint.log 2>&1; code=$?; tail -3 /tmp/chaste-authority-lint.log; test "$code" -eq 0 && echo LINT_OK
  EXPECT: LINT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=732193b20bb040442409823eec398b1313131e6c5a196785209ff30b2b826e1b; output-bytes=121

- [x] G8: The capability manifest reflects the money classification and zero thresholds.
  CHECK: pnpm migration:capabilities:check
  EXPECT: Capabilities:
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=a0a29278c7f154e74688877d7060f5b02d43b2073e1f7c99cb2eed4928d9a1b5; output-bytes=175

- [x] G9: The touched Go files are gofmt-clean.
  CHECK: test -z "$(gofmt -l apps/api/internal/capability/executor.go apps/api/internal/capability/purchasing_purchase_orders.go apps/api/internal/capability/purchasing_purchase_orders_test.go apps/api/internal/capability/purchasing_authority_test.go apps/api/internal/capability/purchasing_requests.go apps/api/internal/capability/commerce_registration_test.go apps/api/internal/capability/skills.go apps/api/internal/httpapi/session_capability.go apps/api/internal/httpapi/session_capability_test.go apps/api/internal/jobs/worker_integration_test.go)" && echo GOFMT_OK
  EXPECT: GOFMT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=ae515ebb8fbd7a381d8c80902ce678e549e238008dae29a24c4fa4f5963613b6; output-bytes=9
