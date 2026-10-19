# Gates: Workmate purchase proposal

OWNS: GATES-WORKMATE.md, CHANGELOG.md, ROADMAP.md, docs/strategy/2026-10-19-post-migration-agentic-erp.md, docs/adr/0087-workmate-proposal-cards-render-stored-approval.md, docs/adr/README.md, docs/migration/capabilities.json, docs/migration/go-capability-overrides.json, apps/api/internal/capability/purchasing_vendors.go, apps/api/internal/capability/purchasing_vendors_test.go, apps/api/internal/capability/purchasing_get_purchase_order.go, apps/api/internal/capability/purchasing_get_purchase_order_test.go, apps/api/internal/capability/inventory_replenishment_acceptance_test.go, apps/api/internal/capability/purchasing_reads.go, apps/api/internal/capability/agent_tools.go, apps/api/internal/capability/agent_tools_test.go, apps/api/internal/capability/executor.go, apps/api/internal/httpapi/chat_loop.go, apps/api/internal/httpapi/chat_session.go, apps/api/internal/httpapi/chat_integration_test.go, apps/api/internal/httpapi/chat_stream_test.go, apps/web-vite/src/api/chat.ts, apps/web-vite/src/api/purchasing.ts, apps/web-vite/src/chat-store.ts, apps/web-vite/src/App.tsx, apps/web-vite/src/components/ChatPage.tsx, apps/web-vite/src/components/ChatPage.test.tsx, apps/web-vite/src/components/ChatDock.tsx, apps/web-vite/src/components/ChatTranscript.tsx, apps/web-vite/src/components/ProposalCard.tsx, apps/web-vite/src/components/ProposalCard.test.tsx, apps/web-vite/src/components/ProposalCard.css

Scope: Make Workmate able to discover suppliers, prepare a money-gated purchase order, and review the exact stored approval payload as an in-conversation proposal card with approve and reject actions.

- [x] G1: The slice records the proposal-card design decision and what remains open for approval versioning.
  EVIDENCE: Reviewed docs/adr/0087-workmate-proposal-cards-render-stored-approval.md and the Unreleased changelog. The ADR records that the card renders the stored approval payload, not model prose, and leaves approval versioning and stale-proposal supersession open.

- [x] G2: Suppliers are readable through a governed capability, and Workmate advertises the vendor, performance, and purchase proposal contracts only with the right purchasing permissions.
  CHECK: set -a; . ./.env; set +a; GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/capability -run '^TestPurchasingListVendors|^TestAgentToolsExposeGatedPurchaseProposal' -count=1 -v
  EXPECT: /--- PASS: TestPurchasingListVendorsReadsActiveSuppliersWithinTenant/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=fdd0ecbc574ee28e1bf2bdd8ade8a93c1612708d5e126ce349bf89a850a2de81; output-bytes=851

- [x] G3: The chat stream carries the capability name, pending-approval flag, approval ID, and rationale for a tool result.
  CHECK: go -C apps/api test ./internal/httpapi -run '^TestHandleChatLoopEventStreamsPendingApprovalMetadata$' -count=1 -v
  EXPECT: /--- PASS: TestHandleChatLoopEventStreamsPendingApprovalMetadata/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=31e95bd3b6dc3abe1aeaf226ebb6058b92705d6c69467452453d4f7e664f5cc5; output-bytes=220

- [x] G4: The conversation renders the stored approval lines and approves the exact approval ID, and the chat page creates the card from a streamed pending result.
  CHECK: cd apps/web-vite && pnpm exec vitest run src/components/ProposalCard.test.tsx src/components/ChatPage.test.tsx
  EXPECT: /13 passed/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=0f4d5fdbeb4d88b49ce8f9379714c38d05c6fec331142c5bc7a75f6b13b60906; output-bytes=650

- [x] G5: The Go workspace tests and vet pass.
  CHECK: pnpm go:verify
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\//
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=0d3fd394af4d85d3d1099fba9015e1e4475ed00bc6c16140a5c407cfba32af13; output-bytes=2109

- [x] G6: The full TypeScript test suite passes.
  CHECK: pnpm test
  EXPECT: /Tasks:\s+3 successful, 3 total/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=99237dc86db79226d03499ac0e83deb5fc044fb87fde38dffb7778777541294a; output-bytes=2836

- [x] G7: The TypeScript workspace typechecks.
  CHECK: pnpm typecheck && echo TYPECHECK_OK
  EXPECT: TYPECHECK_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=418b1cd131da48c899f23303259fd417531e1f7b39a1899a58659b4c7b749015; output-bytes=620

- [x] G8: The workspace lints without errors.
  CHECK: pnpm lint >/tmp/chaste-workmate-lint.log 2>&1; code=$?; tail -3 /tmp/chaste-workmate-lint.log; test "$code" -eq 0 && echo LINT_OK
  EXPECT: LINT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=732193b20bb040442409823eec398b1313131e6c5a196785209ff30b2b826e1b; output-bytes=121

- [x] G9: The capability manifest includes the vendor read and stays in sync.
  CHECK: pnpm migration:capabilities:check
  EXPECT: Capabilities:
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=4813fac1c3c2b96856a030a5bd90fcca9c6f60237113b0069d78c6b98d39c0b2; output-bytes=175

- [x] G10: The touched Go files are gofmt-clean.
  CHECK: test -z "$(gofmt -l apps/api/internal/capability/purchasing_vendors.go apps/api/internal/capability/purchasing_vendors_test.go apps/api/internal/capability/purchasing_get_purchase_order.go apps/api/internal/capability/purchasing_get_purchase_order_test.go apps/api/internal/capability/inventory_replenishment_acceptance_test.go apps/api/internal/capability/purchasing_reads.go apps/api/internal/capability/agent_tools.go apps/api/internal/capability/agent_tools_test.go apps/api/internal/capability/executor.go apps/api/internal/httpapi/chat_loop.go apps/api/internal/httpapi/chat_session.go apps/api/internal/httpapi/chat_integration_test.go apps/api/internal/httpapi/chat_stream_test.go)" && echo GOFMT_OK
  EXPECT: GOFMT_OK
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=ae515ebb8fbd7a381d8c80902ce678e549e238008dae29a24c4fa4f5963613b6; output-bytes=9

- [x] G11: The backend acceptance proof runs plan, pending proposal, human approval, order creation, receipt, verification, and the next plan against the migrated database.
  CHECK: set -a; . ./.env; set +a; GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/capability -run '^TestInventoryReplenishmentAcceptance$' -count=1 -v
  EXPECT: /--- PASS: TestInventoryReplenishmentAcceptance/
  EVIDENCE: exit=0; shell=/bin/sh; cwd=/home/benaiah/projects/Chaste BusinessOS; path=3fcdf4be9fcd/27 entries; EXPECT=matched; output-sha256=fd3c84a1f7785c1ec0a417127cd2d251367833557307cec1bbdcc18737ad8807; output-bytes=189
