# Gates: opportunity attribution and exception ownership

OWNS: packages/db/src/schema/index.ts, packages/db/drizzle/0148_quote_deal_attribution.sql, packages/db/drizzle/meta/_journal.json, apps/api/internal/capability/accounting_quotes.go, apps/api/internal/capability/accounting_quotes_test.go, apps/api/internal/capability/operations_records.go, apps/api/internal/capability/operations_records_test.go, apps/api/internal/capability/skills.go, apps/api/internal/capability/skills_test.go, apps/api/internal/capability/agent_tool_contracts.json, apps/api/internal/capability/capability_catalog.json, apps/api/internal/httpapi/session_capability.go, apps/api/internal/httpapi/session_capability_test.go, apps/web-vite/src/api/sales-quotes.ts, apps/web-vite/src/api/sales-quotes.test.ts, apps/web-vite/src/components/InboxPage.tsx, apps/web-vite/src/components/InboxPage.test.tsx, apps/web-vite/src/components/inbox-page.css, apps/web-vite/src/components/SalesQuoteWorkspace.tsx, apps/web-vite/src/components/SalesQuoteWorkspace.test.tsx, apps/web-vite/src/components/sales-page.css, docs/adr/0103-opportunity-attribution-and-exception-ownership.md, docs/adr/README.md, docs/strategy/2026-10-19-post-migration-agentic-erp.md, docs/migration/capabilities.json, docs/migration/go-capability-overrides.json, docs/migration/data-tables.json, CHANGELOG.md, ROADMAP.md, GATES-WORKFLOW-JOINS.md

Scope: link quotes to their CRM opportunity with customer-consistency checks, and let business exceptions be assigned to any workspace member with membership validation, owner names, and an assigned-to-me queue.

- [x] G1: the migrated database has the quote deal link and its organization index
  CHECK: set -a; . ./.env; set +a; psql "$DATABASE_URL" -Atc "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='quotes' AND column_name='deal_id') || ':' || (SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='quotes' AND indexname='quote_org_deal_idx')"
  EXPECT: 1:1
  EVIDENCE: psql on the migrated database returned 1:1 for the deal_id column and quote_org_deal_idx index.

- [x] G2: a quote stores its deal, reads the deal title, refuses a customer mismatch, and refuses a foreign deal
  CHECK: set -a; . ./.env; set +a; GOCACHE=/tmp/chaste-go-cache GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/capability -run '^TestGoAccountingQuotesAttachDealAttribution$' -count=1 -v
  EXPECT: /--- PASS: TestGoAccountingQuotesAttachDealAttribution/
  EVIDENCE: TestGoAccountingQuotesAttachDealAttribution passed; it proves the link, projected title, customer-mismatch refusal, and foreign-deal refusal.

- [x] G3: an exception owner must be a member of the organization and a member owner is stored
  CHECK: set -a; . ./.env; set +a; GOCACHE=/tmp/chaste-go-cache GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/capability -run '^TestOperationalRecordsPersistDeduplicateAndCard$' -count=1 -v
  EXPECT: /--- PASS: TestOperationalRecordsPersistDeduplicateAndCard/
  EVIDENCE: TestOperationalRecordsPersistDeduplicateAndCard passed; it proves a member owner is stored and a non-member owner is refused.

- [x] G4: quote and operations refusals map to 422 through the shared capability route
  CHECK: GOCACHE=/tmp/chaste-go-cache go -C apps/api test ./internal/httpapi -run 'TestSessionCapabilityHandler' -count=1
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\/internal\/httpapi/
  EVIDENCE: Session capability handler tests passed, including typed 422 mappings for purchasing, sales, and operations refusals.

- [x] G5: workflow skills still point at executable capabilities and the quote capability contract carries dealId
  CHECK: GOCACHE=/tmp/chaste-go-cache go -C apps/api test ./internal/capability -run 'TestWorkflowSkillsReferenceExecutableCapabilities|TestEveryVisibleCapabilityHasAnAuthoredContract|TestGoCapabilitySpecsCoverMigrationManifest' -count=1
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\/internal\/capability/
  EVIDENCE: Workflow skill and capability contract tests passed after regenerating the manifest and catalog.

- [x] G6: the inbox assignment, Mine queue, opportunity selector, and quote API tests pass
  CHECK: cd apps/web-vite && pnpm exec vitest run src/components/InboxPage.test.tsx src/components/SalesQuoteWorkspace.test.tsx src/api/sales-quotes.test.ts
  EXPECT: /Test Files\s+3 passed/
  EVIDENCE: The three affected Vite suites passed, 33 tests across InboxPage, SalesQuoteWorkspace, and the sales-quotes API.

- [x] G7: the TypeScript workspace typechecks and lints without errors
  CHECK: pnpm typecheck && pnpm lint && echo WORKSPACE_CHECKS_OK
  EXPECT: WORKSPACE_CHECKS_OK
  EVIDENCE: pnpm typecheck passed for three workspaces; pnpm lint exited 0 with 0 errors and 143 pre-existing warnings.

- [x] G8: the full TypeScript and Go suites pass
  CHECK: pnpm test && GOCACHE=/tmp/chaste-go-cache GOFLAGS=-p=1 pnpm go:verify
  EXPECT: /Tasks:\s+3 successful, 3 total/
  EVIDENCE: The full pnpm test exited 0 with Tasks: 3 successful, 3 total; pnpm go:verify with GOFLAGS=-p=1 passed every apps/api package and go vet.

- [x] G9: the generated capability and data-table manifests are current
  CHECK: pnpm migration:capabilities:check && pnpm migration:data:check
  EXPECT: /Data tables: 140 exported Drizzle tables/
  EVIDENCE: Capability, data-table, server-action, and route-ownership checks are current; the capability catalog has 345 registrations and the data manifest 140 tables.

- [x] G10: the Inbox shows owner assignment and the Sales workspace shows the linked opportunity without browser errors
  EVIDENCE: Headless Chrome on the verification Vite build proxied to the current API loaded /inbox with a live low-stock exception, the Mine tab, and an Assign exception control listing Bob Stone and Workflow Joins; /sales showed the quote row with "Deal: Hotel chandelier fit-out". JOINS BROWSER PASS problems=0.
