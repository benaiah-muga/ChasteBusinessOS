# Gates: connected business workflows

OWNS: packages/db/src/schema/index.ts, packages/db/drizzle/0146_workflow_continuity.sql, packages/db/drizzle/0147_workflow_continuity.sql, apps/api/internal/capability/accounting_quotes.go, apps/api/internal/capability/accounting_quotes_test.go, apps/api/internal/capability/sales_orders.go, apps/api/internal/capability/sales_orders_test.go, apps/api/internal/capability/purchasing_bills.go, apps/api/internal/capability/purchasing_bills_test.go, apps/api/internal/capability/documents_reads.go, apps/api/internal/capability/documents_ingest.go, apps/api/internal/capability/documents_integration_test.go, apps/api/internal/httpapi/session_capability.go, apps/api/internal/httpapi/session_capability_test.go, apps/api/internal/capability/skills.go, apps/api/internal/capability/skills_test.go, apps/api/internal/capability/executor.go, apps/api/internal/capability/agent_tools.go, apps/api/internal/capability/agent_tool_contracts.json, apps/api/internal/capability/capability_catalog.json, apps/api/internal/signals/purchasing.go, apps/api/internal/signals/accounting.go, apps/api/internal/signals/documents.go, apps/api/internal/signals/pure.go, apps/api/internal/signals/pure_test.go, apps/api/internal/signals/signals.go, apps/api/internal/signals/signals_integration_test.go, apps/web-vite/src/App.tsx, apps/web-vite/src/App.test.tsx, apps/web-vite/src/components/sales-page.css, apps/web-vite/src/api/operations.ts, apps/web-vite/src/api/operations.test.ts, apps/web-vite/src/api/documents.ts, apps/web-vite/src/api/documents.test.ts, apps/web-vite/src/api/purchasing.ts, apps/web-vite/src/api/sales-quotes.ts, apps/web-vite/src/api/sales-quotes.test.ts, apps/web-vite/src/api/sales.ts, apps/web-vite/src/components/InboxPage.tsx, apps/web-vite/src/components/InboxPage.test.tsx, apps/web-vite/src/components/inbox-page.css, apps/web-vite/src/components/DocumentsPage.tsx, apps/web-vite/src/components/DocumentsPage.test.tsx, apps/web-vite/src/components/documents-page.css, apps/web-vite/src/components/SalesQuoteWorkspace.tsx, apps/web-vite/src/components/SalesQuoteWorkspace.test.tsx, apps/web-vite/src/components/SalesPage.tsx, docs/adr/0099-workflow-continuity-through-durable-links.md, docs/adr/README.md, docs/strategy/2026-10-19-post-migration-agentic-erp.md, docs/CAPABILITY_COVERAGE.md, docs/migration/capabilities.json, docs/migration/go-capability-overrides.json, docs/migration/data-tables.json, CHANGELOG.md, ROADMAP.md, GATES-WORKFLOWS.md

Scope: connect the four priority business workflows through durable record links, governed capabilities, deterministic exception producers, durable human exception state, and end-to-end proof.

- [x] G1: the migrated database carries the quote, order, invoice, and document continuity links
  CHECK: set -a; . ./.env; set +a; psql "$DATABASE_URL" -Atc "SELECT string_agg(column_name, ',' ORDER BY table_name, column_name) FROM information_schema.columns WHERE table_schema='public' AND ((table_name='sales_orders' AND column_name='quote_id') OR (table_name='quote_lines' AND column_name='item_id') OR (table_name='quotes' AND column_name='converted_order_id') OR (table_name='invoices' AND column_name='sales_order_id'))"
  EXPECT: sales_order_id,item_id,converted_order_id,quote_id
  EVIDENCE: psql on the migrated DATABASE_URL returned sales_order_id,item_id,converted_order_id,quote_id; migration 0146/0147 applied.

- [x] G2: awarding a quote creates a linked draft order, confirmation reserves stock, delivery links the invoice, and cancelling an untouched order restores its quote
  CHECK: set -a; . ./.env; set +a; GOCACHE=/tmp/chaste-go-cache GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/capability -run '^TestSalesQuoteBecomesOrderAndCancellationRestoresTheQuote$' -count=1 -v
  EXPECT: /--- PASS: TestSalesQuoteBecomesOrderAndCancellationRestoresTheQuote/
  EVIDENCE: TestSalesQuoteBecomesOrderAndCancellationRestoresTheQuote passed against the migrated database; it asserts the quote-to-order link, stock reservation, delivery invoice link, and quote restoration after cancel.

- [x] G3: a reviewed document becomes a vendor bill with a single tenant-scoped link, and a second promotion is refused
  CHECK: set -a; . ./.env; set +a; GOCACHE=/tmp/chaste-go-cache GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/capability -run '^TestPurchasingBillsLinkReviewedDocumentOnce$' -count=1 -v
  EXPECT: /--- PASS: TestPurchasingBillsLinkReviewedDocumentOnce/
  EVIDENCE: TestPurchasingBillsLinkReviewedDocumentOnce passed; it asserts the one-time tenant-scoped document link, link refusal on reuse, foreign-document refusal, and detail projection.

- [x] G4: delayed purchasing, overdue payables, unusual claims, and documents awaiting review are deterministic tenant-scoped exceptions
  CHECK: set -a; . ./.env; set +a; GOCACHE=/tmp/chaste-go-cache GO_RUNTIME_INTEGRATION_REQUIRED=1 go -C apps/api test ./internal/signals -run 'TestPurchasingProducerSignals|TestAccountingExpenseAnomalySignal|TestDocumentsProducerSignals|TestFindUnusual' -count=1
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\/internal\/signals/
  EVIDENCE: Purchasing, expense-anomaly, and document-review signal tests passed against the migrated database with tenant isolation and deterministic output.

- [x] G5: every workflow skill points at executable, agent-visible capabilities and the new capability is in the reviewed manifest
  CHECK: set -a; . ./.env; set +a; GOCACHE=/tmp/chaste-go-cache go -C apps/api test ./internal/capability -run 'TestWorkflowSkillsReferenceExecutableCapabilities|TestEveryCapabilityIsDiscoverableOrReviewedHidden|TestEveryVisibleCapabilityHasAnAuthoredContract|TestGoCapabilitySpecsCoverMigrationManifest' -count=1
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api\/internal\/capability/
  EVIDENCE: Skill-reference, capability-discovery, authored-contract, and manifest-coverage tests passed after regenerating the manifest and agent catalog.

- [x] G6: the changed inbox, quote workspace, documents workspace, and API clients pass their tests
  CHECK: cd apps/web-vite && pnpm exec vitest run src/api/operations.test.ts src/api/sales-quotes.test.ts src/api/documents.test.ts src/components/InboxPage.test.tsx src/components/SalesQuoteWorkspace.test.tsx src/components/DocumentsPage.test.tsx
  EXPECT: /Test Files\s+6 passed/
  EVIDENCE: The changed web suites passed, 102 tests across 7 files including the six gated files.

- [x] G7: the TypeScript workspace typechecks and lints without errors
  CHECK: pnpm typecheck && pnpm lint && echo WORKSPACE_CHECKS_OK
  EXPECT: WORKSPACE_CHECKS_OK
  EVIDENCE: pnpm typecheck passed for all three workspaces; pnpm lint completed with 0 errors (143 pre-existing warnings).

- [x] G8: the full TypeScript test suite passes
  CHECK: pnpm test
  EXPECT: /Tasks:\s+3 successful, 3 total/
  EVIDENCE: The final pnpm test on the completed tree exited 0 with Tasks: 3 successful, 3 total (29 node tests plus the full Vite suite).

- [x] G9: the Go workspace tests and vet pass
  CHECK: GOCACHE=/tmp/chaste-go-cache GOFLAGS=-p=1 pnpm go:verify
  EXPECT: /ok\s+github\.com\/benaiah-muga\/ChasteBusinessOS\/apps\/api/
  EVIDENCE: pnpm go:verify with GOFLAGS=-p=1 exited 0; every apps/api package passed and go vet was clean.

- [x] G10: the quote-to-cash and replenishment behaviour proofs still pass against the live API
  CHECK: GO_API_INTERNAL_URL=http://127.0.0.1:18084 CHASTE_GO_API_ORIGIN=http://127.0.0.1:18084 pnpm demo:m9 all && GO_API_INTERNAL_URL=http://127.0.0.1:18084 CHASTE_GO_API_ORIGIN=http://127.0.0.1:18084 pnpm demo:m8 all
  EXPECT: /FULFILLMENT OK[\s\S]*ALL CHECKS PASSED/
  EVIDENCE: pnpm demo:m9 all and pnpm demo:m8 all passed with GO_API_INTERNAL_URL and CHASTE_GO_API_ORIGIN pointed at the current API on 127.0.0.1:18084; M9 reported 17 guarantees and M8 reported ALL CHECKS PASSED.

- [x] G11: the affected Vite routes load without new browser console or request errors
  EVIDENCE: Headless Chrome 1440x1000 on the Vite build proxied to the current Go API loaded /inbox, /sales, /documents, and /purchasing with BROWSER CHECK PASS problems=0. The inbox showed a live low-stock exception with Acknowledge, Take it, Resolve, Review in Inventory, and Ask Workmate. Sales showed a sent quote with Create sales order, Invoice immediately, and Decline quote, plus an accepted quote linked to order #1 from quote #1. Documents showed projected text, coding suggestions, the supplier bill review form, and a document already linked to supplier bill #1.
