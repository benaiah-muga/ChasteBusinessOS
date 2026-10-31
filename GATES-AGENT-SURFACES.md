# Gates: identity resolution, the coding-agent tool surface, and approvals

OWNS: apps/api/internal/crm/identity.go, apps/api/internal/crm/identity_test.go, apps/api/internal/crm/duplicates.go, apps/api/internal/httpapi/chat_session.go, apps/api/internal/httpapi/chat_resolve_entity_integration_test.go, apps/api/internal/capability/capability_catalog.go, apps/api/internal/capability/skills.go, apps/api/internal/httpapi/ai_tools_mcp.go, apps/api/internal/httpapi/ai_tools_mcp_test.go, apps/api/internal/httpapi/ai_connections.go, apps/web-vite/src/components/ApprovalCard.tsx, apps/web-vite/src/components/ApprovalCard.test.tsx, apps/web-vite/src/components/ApprovalCard.css, apps/web-vite/src/components/approval-payload.ts, apps/web-vite/src/components/ApprovalsPage.tsx, apps/web-vite/src/components/ChatTranscript.tsx, docs/adr/0101-customer-identity-resolution.md, docs/adr/0102-progressive-mcp-tool-surface.md, CHANGELOG.md, ROADMAP.md, GATES-AGENT-SURFACES.md

Scope: agent surfaces that had drifted from the governed core. Customer, vendor,
and employee lookups resolve identity with normalized evidence and reported
provenance. Coding agents connected over MCP see a small discover, describe,
dispatch surface instead of the whole catalog. A gated action that is not a
purchase order gets a reviewable approval card instead of a mislabeled proposal.

- [x] A1: the identity ranker prefers email over phone over exact name over tokens over partial and similar names, in any word order, with company suffixes ignored
  CHECK: cd apps/api && go test ./internal/crm -run 'TestRankMatches' -count=1 -v
  EXPECT: /--- PASS: TestRankMatches/
  EVIDENCE: PASS with ten sub-tests: email strength, phone formatting, token order, suffix stripping, partial and similar evidence, merge resolution, collapse, deactivation, no-evidence, and deterministic bounded ranking.

- [x] A2: a merged customer resolves to the surviving record, reports the duplicate's name, and never returns the tombstone as an actionable id
  CHECK: cd apps/api && go test ./internal/httpapi -run 'TestResolveEntityFollowsMergesAndRanksEntities' -count=1 -v
  EXPECT: /--- PASS: TestResolveEntityFollowsMergesAndRanksEntities/
  EVIDENCE: PASS against the migrated database. A seeded survivor and a merged duplicate resolved by the old name, by reordered name tokens, by an international phone format, and by uppercase email all returned the survivor id. The merge trail reported "Acme Supply", a chain of merges resolved to its root, and the tombstone id never appeared.

- [x] A3: every governed capability whose discovery contract is exercised still ranks for a natural-language query, and filler-only queries match nothing
  CHECK: cd apps/api && go test ./internal/capability -run 'TestSearchAgentCapabilities' -count=1 -v
  EXPECT: /--- PASS: TestSearchAgentCapabilitiesRanksNaturalLanguageDiscovery/
  EVIDENCE: PASS. "find a customer" ranked crm.listCustomers first, "create customer", "finance overview", and "mark notification read" still resolved, and "the a of" and "..." returned nothing.

- [x] A4: the MCP bridge advertises exactly the three meta tools when no direct tools are pinned, and discover, describe, dispatch work end to end
  CHECK: cd apps/api && go test ./internal/httpapi -run 'TestAIToolsMCPProgressiveDisclosure|TestAIToolsMCPBridgeContract|TestAIToolsMCPToolFilteringAndRateLimit' -count=1 -v
  EXPECT: /--- PASS: TestAIToolsMCPProgressiveDisclosure/
  EVIDENCE: PASS. Discovery returned crm.listCustomers without schemas, describe returned its permission, risk, schema, and skills, dispatch executed it as an agent with tool_call and tool_result trajectory events, unknown capabilities were refused, non-object input was rejected with -32602, and an empty allowlist advertised three tools.

- [x] A5: the production MCP configuration, which pins no direct tools, advertises the meta surface against the real permissions store
  CHECK: cd apps/api && go test ./internal/httpapi -run 'TestAIToolsMCPStoreIntegration' -count=1 -v
  EXPECT: /--- PASS: TestAIToolsMCPStoreIntegration/
  EVIDENCE: PASS against the migrated database. A real coding_agent_connections row, real role permissions, and an empty allowlist produced exactly three advertised tools.

- [x] A6: the Workmate route loads for a verified user, answers from the turn facts, follows a customer merge in a live conversation, and has no console, page, or request errors
  CHECK: agent-browser on http://localhost:3000/chat against the Go API on 127.0.0.1:18083
  EXPECT: replies rendered, no console or page errors, no 4xx or 5xx requests
  EVIDENCE: agent-browser loaded /chat with a seeded verified session and the active organization. "What approvals are waiting for me?" answered "Nothing is waiting for your sign-off. The approvals inbox is empty." A customer write under max_risk_autonomous=read streamed and then reported "The customer was not created ... waiting for human approval, approval id 39472745-6423-4ee6-811d-4a06f0f816ea". "Use resolve_entity to look up the customer Acme Supply" returned the survivor id 842d2483-59da-4841-bb46-9e19d678d54e and explained that the old name was merged into it. agent-browser reported no console entries at error or warn level, no page errors, and no 4xx/5xx requests. The stored user events carried the facts digest.

- [x] A7: the TypeScript workspace typechecks, lints, and tests clean
  CHECK: pnpm typecheck && pnpm lint && pnpm test && echo WORKSPACE_OK
  EXPECT: WORKSPACE_OK
  EVIDENCE: typecheck reported 3 successful tasks, lint reported 0 errors and 143 pre-existing warnings, and pnpm test exited 0 with Tasks 3 successful, 3 total in 6m52s on the final tree.

- [x] A8: the Go workspace tests and vet pass against the migrated database
  CHECK: GOCACHE=/tmp/chaste-go-cache GOFLAGS=-p=1 pnpm go:verify
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api/
  EVIDENCE: the isolated full run reported ok for every package (capability, httpapi, crm, ledger, jobs, signals, and the cmd binaries) and go vet was clean. It included the vendor, employee, and merge-chain identity cases. An earlier full run under concurrent load flaked the Codex work-summary test; that test passed in isolation and in the isolated full rerun.

- [x] A9: vendors and employees use the ranked resolver, with person normalization for employees, and records without a merge model carry no merge provenance
  CHECK: cd apps/api && go test ./internal/crm -run 'TestRankMatchesForPeopleKeepsSurnameSuffixes|TestRankMatchesWorksWithoutMerges' -count=1 -v
  EXPECT: /--- PASS: TestRankMatchesForPeopleKeepsSurnameSuffixes[\s\S]*--- PASS: TestRankMatchesWorksWithoutMerges/
  EVIDENCE: PASS. A person whose surname looks like a company suffix kept it, the employee detail carried the email and title, a vendor matched reordered name tokens, and no MatchedRecordID was reported for an unmerged record.

- [x] A10: the migrated database resolves vendors and employees by reordered tokens and email, reports how each matched, and includes the employee's title
  CHECK: cd apps/api && go test ./internal/httpapi -run 'TestResolveEntityFollowsMergesAndRanksEntities' -count=1 -v
  EXPECT: /--- PASS: TestResolveEntityFollowsMergesAndRanksEntities/
  EVIDENCE: PASS. A seeded vendor resolved by "Supplies Industrial Acme" and by an uppercase email, both with matchedOn; a seeded employee resolved by "Clark Harper" and by email, and the detail carried "harper@example.test · Engineer".

- [x] A11: the approval card renders a non-purchase approval generically with redacted fields, approves and rejects it without pretending a purchase order exists, and keeps the line-item view for purchase orders
  CHECK: cd apps/web-vite && pnpm exec vitest run src/components/ApprovalCard.test.tsx src/components/approval-payload.test.ts src/components/ApprovalsPage.test.tsx src/components/ChatPage.test.tsx
  EXPECT: /Test Files\s+4 passed/
  EVIDENCE: PASS, 32 tests across the four suites. The generic card showed "Approval required", "Create Customer", "write risk", Name, Email, Do not contact, and Preferred contact method, approved with "Approved and executed.", never called fetchPurchaseOrder, and rejected with "Rejected. Nothing was changed.". The purchase-order tests still show the line items and "Approve order". The shared payload module keeps credential-shaped keys and session or intent ids out of previews, and the approvals page still passed after the extraction.

- [x] A12: a gated customer creation in the live Workmate renders the generic card, approves from the conversation, and creates the record
  CHECK: agent-browser on http://localhost:3000/chat against the Go API on 127.0.0.1:18083
  EXPECT: "Approval required" card with the stored payload, then "Approved and executed." and an active customer row
  EVIDENCE: agent-browser sent "Create a customer called Card Check Ltd with email card@check.test" under max_risk_autonomous=read. The reply streamed, and the card rendered "APPROVAL REQUIRED", "Create Customer", "WRITE RISK", the rationale, Name Card Check Ltd, Email card@check.test, Do not contact No, and Preferred contact method email, with no "Purchase proposal" label. Clicking Approve reported "Approved and executed." The database then held Card Check Ltd with card@check.test, active and unmerged, and the approval row was executed. agent-browser reported no console errors, no page errors, and no 4xx/5xx requests.
