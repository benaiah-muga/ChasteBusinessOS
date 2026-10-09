# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/), pre-1.0, minor bumps mark
milestones and breaking changes call them out explicitly.

Versioning continues from the v1 codebase (archived on the
[`v1-archive`](https://github.com/benaiah-muga/ChasteBusinessOS/releases/tag/v1-archive)
tag, which ended at 0.1.0); the v2 capability-kernel rewrite resumes the sequence.
The full v1 changelog is preserved at the bottom of this file.

## [Unreleased]

### Changed

- Vite POS sales no longer retry through legacy `/api/pos` when the selected Go
  `pos.completeSale` capability returns 404. The actor-scoped exact sale intent
  is pinned to its route and kept for exact Go retry; selector rollback is
  blocked while the Go attempt is unresolved. Selector-off sales remain on
  legacy.

- Selected Go Manufacturing writes for BOM definition, work orders, and
  production fail closed on 404 without retrying through `/api/manufacturing`.
  Their actor/org-scoped exact intent stays pending for same-action Go retry;
  selector rollback is blocked until that retry is resolved. Selector-off
  actions continue to use the legacy route.

- Vite's HR Overview report can use the authenticated Go `hr.report` capability
  behind `CHASTE_GO_HR_OVERVIEW_REPORT_READS=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. The selector is scoped to Overview;
  set it to `0` to return Overview to legacy `/api/hr`. Selected-Go errors fail
  closed without retrying `/api/hr`.

- Vite Sales order create, deliver, and cancel writes fail closed when the
  selected Go capability route returns 404. They keep the exact actor- and
  organization-scoped retry intent, pinned to the route that created it, and
  never retry through legacy `/api/sales`; the legacy route is used only when
  the Go write selector is off. Pre-upgrade route-less retry markers fail
  closed until the user reviews Sales order history and explicitly confirms
  clearing that scoped marker in the Vite page. Recovery sends no Sales write;
  valid route-pinned or malformed markers cannot be cleared through this flow.

- Vite's authored-document editor can use Go for its primary detail and version
  history behind paired `CHASTE_GO_DOCUMENTS_EDITOR_READS=1`,
  `CHASTE_GO_DOCUMENTS_VERSION_READS=1`, and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. The API gates
  `documents.getDoc` and `documents.listDocVersions` with their default-off
  `GO_DOCUMENTS_EDITOR_READS=1` and `GO_DOCUMENTS_VERSION_READS=1` flags. The
  selected Go path does not fetch legacy detail for version rows or fall back
  after a Go failure. Workspace and write routes remain unchanged.

- Vite mention and add-member people lookup can use the authenticated Go
  `messaging.listPeople` capability behind paired
  `CHASTE_GO_MESSAGING_PEOPLE_READS=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. The API enforces
  `GO_MESSAGING_PEOPLE_READS=1` for every caller. Initial lookup retains the
  100-row limit; add-member search retains 30 rows and an 80-character trimmed
  query. Selected Go failures are visible and do not retry through legacy.

- Vite authored-document version history and archived compare previews can use
  the authenticated Go `documents.listDocVersions` and
  `documents.getDocVersion` capabilities behind paired
  `CHASTE_GO_DOCUMENTS_VERSION_READS=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. The API enforces
  `GO_DOCUMENTS_VERSION_READS=1` for every caller. Document content, editor,
  collaboration, and writes retain their existing routes; selected-Go errors
  do not retry through legacy.

- Vite Documents library list and preview detail can use Go's authenticated
  `documents.listIngestedDocuments` capability behind
  `CHASTE_GO_DOCUMENT_INGESTED_READS=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. The API enforces
  `GO_DOCUMENT_INGESTED_READS=1` for all callers. Go output is strictly
  validated, and selected-Go errors do not retry through legacy.

- Vite inventory item history can use the authenticated Go session reader via
  the existing paired `CHASTE_GO_INVENTORY_READ_ROUTE=1` and
  `GO_INVENTORY_READ_ROUTE=1` selectors. It preserves the `{ movements }`
  contract and strict movement validation; selected Go errors do not retry via
  the legacy handler.

- Vite analytics report generation now routes only `POST /api/analytics` to
  the existing authenticated Go Analytics handler by default in `.env.example`.
  Set both `GO_ANALYTICS_REPORT_ROUTE=0` and
  `CHASTE_GO_ANALYTICS_REPORT_ROUTE=0` for explicit legacy rollback. Dataset
  discovery and previews keep their existing GET routing, and report response
  and download behavior remain unchanged.

- Vite Purchasing A/P aging can read through Go's authenticated
  `purchasing.apAging` capability behind paired
  `CHASTE_GO_PURCHASING_AP_AGING_READS=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors, with the API's
  `GO_PURCHASING_AP_AGING_READS=1` flag also required. The read validates Go's
  bucket response and uses the workspace currency; selected-Go failures do not
  retry through `/api/purchasing`.

- Vite receiving-desk receipt history can use Go's `purchasing.listReceipts`
  capability by default in `.env.example`, paired with
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set
  `CHASTE_GO_PURCHASING_RECEIPT_HISTORY_READS=0` for legacy rollback. Order
  listing and receipt submission keep their existing routes, and selected Go
  errors do not retry the legacy receipt-detail action.

- Vite Purchasing requests and RFQs now use the direct authenticated Go
  `purchasing.listPurchaseWorkflow` capability by default in `.env.example`.
  Set both `CHASTE_GO_PURCHASING_WORKFLOW_READS=0` and
  `GO_PURCHASING_WORKFLOW_READS=0` for explicit legacy rollback. Only
  `workspace.requests` is replaced; the aggregate remains the source for other
  workspace data. Strict output validation strips the Go-only RFQ `vendorId`,
  and selected-Go errors do not retry through the aggregate request.

- Vite inventory transfer create and confirm writes no longer fall back to the
  legacy inventory route when a selected Go capability returns 404. The exact
  actor/org scoped intent is retained, and retries remain targeted to the
  route selected when the attempt began. Pre-route markers without a recorded
  destination are preserved and fail closed; the transfer panel exposes an
  explicit confirmation to resolve one after review of transfer history.

- Vite CRM saved-view create, pin, and share writes can use Go's authenticated
  `crm.saveCustomerView` capability behind paired
  `CHASTE_GO_CRM_VIEW_WRITES=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`
  selectors. Exact action retries are scoped to the active actor and
  organization and recover after reload; pending or uncertain writes block
  duplicate edits and legacy fallback. Saved-view reads remain unchanged.

- Vite product CSV imports, undo, and restore can use Go's authenticated
  `inventory.importItems`, `inventory.undoItemImport`, and
  `inventory.restoreItemImport` capabilities. Exact pending intent inputs and
  created item IDs are recoverable within the active actor and organization
  session; retries preserve the same intent through approvals and uncertain
  results. The Go route never falls back to `/api/import`. Imports exceeding the
  64 KiB capability request limit or Go row constraints are rejected before
  dispatch, and undo/restore retain the exact affected item IDs.

- Vite Marketing campaign creation, send, and analytics use Go's authenticated
  capabilities by default in `.env.example`, with validated response envelopes.
  Set `CHASTE_GO_MARKETING_CAMPAIGN_WRITES=0` for explicit legacy rollback.
  Go-selected writes fail closed on a missing capability route; campaign send
  retries retain the exact actor and organization scoped intent through 404,
  malformed, and uncertain results. The Marketing snapshot remains on its
  existing route.

- Vite cycle-count create, record, post, and cancel use Go's session capability
  route when paired Vite and API selectors are enabled. Exact retry markers are
  scoped to the active actor and organization and retained through pending
  approvals and uncertain outcomes. Go errors never retry through
  `/api/inventory`; legacy rollback also requires loaded actor and organization
  scope and is blocked while a Go action is unresolved. Inventory permission,
  module, approval, and intent-receipt checks remain enforced.

- Vite Projects can route create, archive, task creation, task movement, and task
  assignment through Go capabilities behind paired `CHASTE_GO_PROJECTS_WRITES=1`
  and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Go derives actor and
  organization from the authenticated session. Exact action intents are retained
  per actor and organization across approvals and uncertain results, with a
  recovery control after reload and no legacy fallback while a Go result is
  unresolved. Project and board reads remain on their existing path.
  Capability receipts now retain exact project-task snapshots for guarded
  delete and restore, and task move/assignment compensations refuse to overwrite
  later edits.

- Vite's Accounting budgets screen loads budget scenarios and the 13-week cash
  forecast directly through Go's `accounting.listBudgetScenarios` and
  `accounting.cashForecast` capabilities. Scenario rows and IDs are validated
  and projected into the existing UI summary shape. Scenario-list failures
  expose a retry action, and invalid scenario IDs are rejected before dispatch;
  neither read retries through the legacy Accounting API.

- Vite Sales order lists and refreshes can read through Go's session-authenticated
  `sales.listOrders` capability behind paired `CHASTE_GO_SALES_ORDER_READS=1`
  and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Go derives organization
  scope from the authenticated session; selected Go reads strictly validate the
  response and fail closed on pending, malformed, or unavailable results.
- Vite customer statements can read through Go's session-authenticated
  `accounting.customerStatement` capability behind paired
  `CHASTE_GO_ACCOUNTING_CUSTOMER_STATEMENT_READS=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Customer IDs are validated
  as UUIDs, output is strictly validated, and pending, malformed, or unavailable
  Go responses surface as errors without retrying the legacy Accounting route.
- Vite Manufacturing can route production cost previews, feasibility checks,
  and BOM reports through Go's `manufacturing.costPreview`,
  `manufacturing.checkProductionFeasibility`, and `manufacturing.bomReport`
  capabilities by default in `.env.example`, paired with
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set
  `CHASTE_GO_MANUFACTURING_PLANNING_READS=0` for legacy rollback. Responses
  are validated, pending or malformed results show errors, and selected Go
  reads never fall back to `/api/manufacturing`.
- Vite Accounting Reports can load the aggregate directly from Go's income
  statement, balance sheet, cash flow, FX exposure, and report currency
  metadata capabilities behind paired `CHASTE_GO_ACCOUNTING_REPORTS=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. The required reports fail
  the load on pending, malformed, or unavailable results; only optional cash
  flow and FX 422 domain errors remain `null`. Reads use no-store caching, and
  Go errors do not fall back to `/api/reports`.
- Vite Purchasing Intel can load price history and supplier performance through
  Go's `purchasing.priceHistory` and `purchasing.supplierPerformance` read
  capabilities behind paired `CHASTE_GO_PURCHASING_INTEL_READS=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Go enforces
  `purchasing.read` and derives organization scope from the session. Pending,
  malformed, and unavailable results display errors instead of empty analytics.
  Other Purchasing flows retain their current routes.
- Vite employee creation can use Go's session-authenticated `hr.hireEmployee`
  capability behind paired `CHASTE_GO_HR_EMPLOYEE_WRITES=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Salary remains integer
  minor units, and actor/org scoped exact attempts survive pending approvals,
  uncertain responses, and reloads. Go 404 does not fall back to the legacy
  writer; successful recovery clears the matching form to prevent duplicates.
  Other People actions retain their current routes.
- Vite supplier statements can read through Go's session-authenticated
  `purchasing.supplierStatement` capability behind paired
  `CHASTE_GO_PURCHASING_SUPPLIER_STATEMENT_READS=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Go enforces
  `purchasing.read` and derives organization scope from the session. Vendor IDs
  are validated as UUIDs, and pending, malformed, or unavailable responses
  surface as errors instead of empty statements. Other Purchasing flows retain
  their current routes.
- Vite period-close readiness can read through Go's session-authenticated
  `accounting.periodCloseWorkbench` capability behind paired
  `CHASTE_GO_ACCOUNTING_PERIOD_CLOSE_READS=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Go derives organization
  access from the session and enforces `accounting.read`; a Go error does not
  fall back to the legacy readiness route. Other Accounting screens and
  actions retain their current routes.
- Vite Hiring now reads openings and applicants through Go's `hr.report`
  capability and routes opening creation, applicant creation, and pipeline
  stage changes through `hr.createOpening`, `hr.addApplicant`, and
  `hr.moveApplicant`. The paired `CHASTE_GO_HR_HIRING=1` selector requires
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Exact actor/org scoped attempts and
  pending or uncertain action recovery survive reload; Go 404 never falls back
  to the legacy writer. Applicant-to-employee conversion is not part of this
  Vite slice.
- Vite Payroll now reads payroll runs through Go's `hr.report` capability and
  creates drafts through `hr.createPayrollRun` behind paired
  `CHASTE_GO_HR_PAYROLL=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors.
  Draft attempts are scoped to actor and organization, and pending or uncertain
  actions can be retried with the same intent after reload. Go 404 and uncertain
  results never fall back to the legacy writer. Payroll execution, void, and
  reversal controls remain outside this Vite slice.
- Vite supplier payment runs can use Go's governed purchasing capabilities for
  eligible bill reads, draft creation, cancellation and restoration, approval,
  and reversal behind paired `CHASTE_GO_PURCHASING_PAYMENT_RUNS=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Exact actor/org scoped
  attempts and approval recovery survive reload; Go 404 and uncertain outcomes
  never fall back to legacy routes. Go checks current bill balances and
  currencies before creating and instructing a run.
- Vite HR Time reports, submitted-entry approvals, time logging, and decisions can
  use the Go `hr.*` capabilities behind the paired `CHASTE_GO_HR_TIME=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. A new org-scoped
  `hr.pendingTimeEntries` read provides decision IDs and employee details. Exact
  actor/org scoped writes and approval recovery survive reload; Go 404 and
  uncertain results never fall back to the legacy writer. Other HR tabs keep
  their current routes. Set the selector to `0` for explicit legacy rollback.
- Vite invoice `recordPayment` writes can use Go's session-authenticated
  `accounting.recordPayment` capability behind the paired
  `CHASTE_GO_ACCOUNTING_RECORD_PAYMENT=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Exact actor/org scoped
  payment attempts and pending approval recovery survive reload; Go 404 and
  uncertain results never fall back to the legacy writer. An unresolved Go
  payment blocks legacy rollback and remains retryable from the global notice,
  even if the invoice is absent from the refreshed list. Other Accounting
  operations keep their existing routes. Set the selector to `0` for explicit
  legacy rollback.
- Vite invoice creation can use Go's session-authenticated
  `accounting.createInvoice` capability behind the paired
  `CHASTE_GO_ACCOUNTING_CREATE_INVOICE=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Actor/org scoped exact
  attempts and pending approvals survive reload. Go 404 and uncertain results
  never fall back to the legacy writer, and an unresolved attempt blocks legacy
  rollback. Other Accounting actions retain their existing routes.
- Vite invoice credit notes can use Go's session-authenticated
  `accounting.creditNote` capability behind the paired
  `CHASTE_GO_ACCOUNTING_CREDIT_NOTE=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Exact actor/org scoped
  attempts and approval recovery survive reload; Go 404 and uncertain outcomes
  never fall back to the legacy writer. Go checks the locked invoice's live
  balance before posting, and an unresolved attempt blocks legacy rollback.
  Other Accounting actions retain their existing routes.
- Vite manual/general journal reversals can use Go's session-authenticated
  `accounting.reverseEntry` capability behind the paired
  `CHASTE_GO_ACCOUNTING_REVERSE_ENTRY=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Exact actor/org scoped
  attempts and approval recovery survive reload; Go 404 and uncertain outcomes
  never fall back to the legacy writer. Go checks reversal eligibility and
  directs invoice, payment, and year-end entries to their domain workflows.
  Other Accounting actions retain their existing routes.
- Vite bank reconciliation match and unmatch writes can use Go's
  session-authenticated `accounting.matchBankTransaction` and
  `accounting.unmatchBankTransaction` capabilities behind the paired
  `CHASTE_GO_BANK_RECONCILIATION_WRITES=1` and
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Exact actor/org scoped
  attempts and approval recovery survive reload; Go 404 and uncertain outcomes
  never fall back to the legacy writer. Go remains authoritative for matching
  eligibility and allocation rules. Other banking actions and reads retain
  their existing routes.
- Accounting Payables now routes bill payments through the existing Go
  `purchasing.payBill` client flow when
  `CHASTE_GO_PURCHASING_FINANCE_WRITES=1`. The exact amount and optional method
  are preserved, including Go's `bank_transfer` default when method is
  omitted. Actor/org scoped retries and approval recovery survive reload, and
  the payBill retry intent is shared with the Purchasing workspace.
- Go leave requests now verify that the employee belongs to the caller's
  organization before inserting a request. Missing and cross-organization
  employee IDs are rejected without creating leave records.
- Vite HR Leave now reads its report through Go's session-authenticated
  `hr.report` capability and routes leave requests, decisions, and cancellation
  through `hr.requestLeave`, `hr.decideLeave`, and `hr.cancelLeave`. The paired
  `CHASTE_GO_HR_LEAVE=1` selector is enabled in local setups and requires
  `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Exact actor/org scoped retries and
  pending approval recovery survive reload; a Go 404 never falls back to the
  legacy endpoint, and selector rollback blocks unresolved actions. Other HR
  tabs keep their existing routes. Set the selector to `0` for explicit legacy
  rollback.
- Vite HR Expenses now reads claims and policy limits through Go's
  session-authenticated `accounting.listExpenseClaims` and
  `accounting.listExpensePolicies` capabilities, and sends submissions,
  decisions, reimbursements, and policy updates through their matching Go
  capabilities. The paired `CHASTE_GO_HR_EXPENSES=1` selector is enabled in
  local setups and requires `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Exact
  actor/org scoped retries and pending approval recovery survive reload; a Go
  404 never falls back to the legacy endpoint, and selector rollback blocks
  unresolved actions. Expense memo and policy category limits match Go at 3 to
  500 characters and 2 to 40 characters respectively. Set the selector to `0`
  for explicit legacy rollback.
- Vite CRM customer CSV import and undo now use Go's session-authenticated
  `crm.importCustomers` and `crm.undoCustomerImport` capabilities by default in
  local setups. Exact rows, created-ID undo state, actor/org scoped intents, and
  pending or uncertain retries survive reload; a Go 404 never falls back to
  `/api/import`, and selector rollback blocks unresolved attempts. Go binds undo
  to the successful import receipt and actor, and binds restore to the successful
  undo receipt while rejecting changed records. Undo remains on Go for imports
  created by Go. Set `CHASTE_GO_CRM_CUSTOMER_IMPORT=0` to use `/api/import` for
  new legacy imports.
- Vite CRM customer merge and undo now use Go's session-authenticated
  `crm.mergeCustomers` and `crm.restoreCustomerMerge` capabilities by default
  in local setups. Merge and undo inputs retain exact actor and organization
  scoped retry intents through approval and uncertain results. A Go 404 never
  falls back to the legacy writer, and selector rollback blocks unresolved
  actions. The successful merge snapshot is persisted so undo remains available
  after reload. Go now binds undo to the server's durable original merge receipt
  and rejects restore if any affected record changed after the merge. Set
  `CHASTE_GO_CRM_CUSTOMER_MERGE=0` to use `/api/customers`.
- Vite CRM customer deactivation now uses Go's session-authenticated
  `crm.deactivateCustomer` capability by default in local setups. The scoped
  retry marker preserves the exact customer action and intent through pending
  approvals and uncertain results; a Go 404 never retries through the legacy
  writer, and rolling the selector back blocks while that Go result is
  unresolved. Set `CHASTE_GO_CRM_CUSTOMER_DEACTIVATE=0` to use `/api/customers`.
- Go now owns the exact `/api/auth` root and every nested auth path when the
  Vite Go auth proxy is enabled. Unsupported paths and methods fail closed in
  Go instead of reaching the legacy Better Auth handler; `CHASTE_GO_AUTH_ROUTE=0`
  keeps the legacy compatibility path available.
- Organization creation now has a single Go writer. The legacy Next POST is a
  strict session-preserving proxy to Go with no TypeScript fallback; it
  forwards the original bounded body, Cookie or Bearer token, Origin, and Host,
  then validates Go's response. The Vite POST selector defaults off in code
  and pairs with `GO_ONBOARDING_ROUTE=1`; onboarding GET and PATCH stay on the
  legacy handlers during transition. HTTPS terminated before Go requires the
  exact Next proxy peer CIDRs in `GO_API_TRUSTED_PROXY_CIDRS` for forwarded
  scheme checks.

- Added the Go pre-organization `iam.bootstrapOrganization` capability boundary for verified human workspace creation. The dedicated executor stays out of org-scoped dispatch and agent tools, checks the live verified session against the resolved identity, and atomically commits bootstrap data and the first `organization.created` ledger event. Its internal database function derives ownership from that session, serializes attempts by user, and atomically creates the organization, seed records, and intent receipt under a dedicated `NOBYPASSRLS` owner role; only `chaste_app` can execute it. The bounded nullable auth-session reference is hash-covered and preserved after logout without a foreign key. Embedding upgrade runs best-effort after commit. The Go endpoint stays off unless `GO_ONBOARDING_ROUTE=1`.
- Fixed Go purchasing quote-award validation to report a losing or already-awarded RFQ before checking whether its parent request can create an order. Kept the serialized request decision check intact.
- Fixed Vite POS register open and close recovery so retries use the exact actor/org scoped payload and intent. Missing scope, unavailable storage, and corrupt retry markers fail closed; scope changes ignore stale responses, unresolved inputs are frozen, and 408/429 keep the retry identity.
- Fixed Vite manual stock adjustments so pending and uncertain Go writes restore the exact actor/org scoped action and retry intent after reload. Inputs freeze while saving or unresolved, stale responses from an old workspace are ignored, and 408/429 keep the retry intent. Damaged markers fail closed; rolling back the Go selector checks for unresolved attempts before permitting fresh legacy writes.
- Fixed Vite Sales create recovery so organization changes clear the previous draft and block writes until the new actor/org retry marker is checked. Damaged retry markers now remain intact and keep API submission and UI recovery locked.
- Fixed Vite inventory retry safety so malformed transfer and reservation markers fail closed, Go location/reservation writes require actor and organization scope plus durable action and scope markers, and selector rollback cannot route an unresolved Go action through legacy, even while scope is temporarily unavailable.
- Fixed Vite Manufacturing and Sales scope transitions. Manufacturing clears old-scope inputs and targets and ignores stale reads, previews, and writes; Sales clears stale action targets and ignores confirmation or delivery results from a previous organization.
- Fixed Vite Marketing recovery across selector rollback and organization changes. Unresolved Go campaign attempts block legacy writes, and prior-scope campaigns, send logs, analytics, and delayed action results stay hidden from the next organization.
- CRM stage-move retries now keep the same intent after HTTP 408 or 429, which may represent an uncertain outcome.
- Vite CRM reads for deals, customers, tasks, saved views, and customer timelines now go directly to Go, where the Better Auth session, organization membership, and capability permissions are resolved and checked. The local template enables the paired Vite and Go route flags. Go service failures fail closed without a Next.js read fallback.
- Vite Sales create attempts persist the exact action with the actor/org scoped intent. Pending or uncertain drafts restore locked after remount and retry with the original payload and intent; a definitive 4xx clears the attempt and unlocks corrected input with a fresh identity.
- The Vite Go auth proxy now owns the entire `/api/auth/*` namespace whenever Go auth is enabled. Unsupported paths and methods fail closed in Go instead of falling through to the legacy auth service; the explicit compatibility opt-out remains available.
- Vite CRM customer profile saves and bulk profile updates use Go's session-authenticated `crm.updateCustomerProfiles` capability by default in local setups when `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set `CHASTE_GO_CRM_CUSTOMER_PROFILE_UPDATE=0` to keep profile writes on `/api/customers`. Actor and organization scoped retry identities and exact payloads persist through pending or uncertain results, Go returns validated prior snapshots for undo, and Go 404 responses fail closed without falling back to the legacy writer. Other customer writes retain their current routes.
- Vite CRM deal creation uses Go's session-authenticated `crm.createDeal` capability by default in local setups when `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set `CHASTE_GO_CRM_DEAL_CREATE=0` to keep fresh, scoped deal creation on `/api/deals`; all deal-create writes fail closed until actor and organization scope resolve. An unresolved Go create stays locked and blocks legacy writes until Go routing is restored and that exact action is retried. Go 404 responses fail closed without falling back to the legacy writer, retaining the same draft and intent for retry. Go's deal ID is strictly validated, and other deal actions keep their current routes.
- Vite CRM customer creation uses Go's session-authenticated `crm.createCustomer` capability by default in local setups when `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set `CHASTE_GO_CRM_CUSTOMER_CREATE=0` to keep fresh, scoped customer creation on `/api/customers`; all customer-create writes fail closed until actor and organization scope resolve. An unresolved Go create stays locked and blocks legacy writes until Go routing is restored and that exact action is retried. The exact form draft and actor/org scoped retry intent survive pending or uncertain responses and restore after reload. Go 404 responses fail closed without falling back to the legacy writer, retaining the same draft and intent for retry. Go's customer ID and duplicate warning are validated, and the warning remains visible after creation. Other CRM writes retain their existing routes.
- Vite CRM task creation, completion, and follow-up due date and assignee updates use Go's session-authenticated `crm.createTask`, `crm.completeTask`, and `crm.updateTaskDetails` capabilities by default in local setups. Set both `GO_CRM_TASK_WRITES=0` and `CHASTE_GO_CRM_TASK_WRITES=0` to restore legacy `/api/crm` handling. A Go 404 now fails closed without sending the task action to the legacy writer; exact task drafts and actor/org scoped retry identities remain locked through pending or uncertain results.
- Vite message edits can opt into Go's session-authenticated `messaging.editMessage` capability with `CHASTE_GO_MESSAGING_EDIT_SLICE=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. The exact scoped edit and intent survive pending or uncertain outcomes, malformed Go results fail closed, and edits are blocked while scope is unresolved or stale. Unresolved Go edits stay locked across selector rollback until Go routing is restored.
- Vite message deletions can opt into Go's session-authenticated `messaging.deleteMessage` capability with `CHASTE_GO_MESSAGING_DELETE_SLICE=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. All delete writes require resolved actor and organization scope. Pending or uncertain deletions restore the same confirmation and intent, stale responses cannot change a new session's confirmation state, and unresolved Go deletions stay locked across selector rollback until Go routing is restored.
- Vite Marketing campaign creation and sends can opt into Go's session-authenticated `marketing.createCampaign` and `marketing.sendCampaign` capabilities with `CHASTE_GO_MARKETING_CAMPAIGN_WRITES=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Exact campaign drafts lock and restore across pending or uncertain outcomes, with actor/org scoped retry IDs retained through network, 408, 429, and 5xx uncertainty. Go's queued recipient and opt-out counts are validated, and already queued campaigns cannot be resent from the page. Segment creation and analytics keep their current behavior.
- Vite receipt submission uses Go's session-authenticated `purchasing.receiveGoods` capability by default in local setups with `CHASTE_GO_PURCHASING_RECEIVE_GOODS=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. It preserves approval and same-intent legacy fallback behavior, scopes persistent retry identity to the actor and organization, and retains the receipt draft while approval is pending or the result is uncertain.
- Vite vendor returns and purchase order closing use Go's session-authenticated `purchasing.returnGoods` and `purchasing.closePurchaseOrder` capabilities by default in local setups with `CHASTE_GO_PURCHASING_RETURN_CLOSE=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. They keep approval and same-intent legacy fallback behavior, validate Go's bounded inputs and exact capability result shapes, and retain scoped retry identities while pending or uncertain.
- Vite vendor creation, bill recording, bill payment, and bill credits use Go's session-authenticated `purchasing.createVendor`, `purchasing.createBill`, `purchasing.payBill`, and `purchasing.billCreditNote` capabilities by default in local setups with `CHASTE_GO_PURCHASING_FINANCE_WRITES=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Exact action retries are scoped to actor and organization, pending and uncertain submissions keep the same intent, 404 fallback reuses it, and capability results are strictly validated.
- Vite purchase order creation uses Go's session-authenticated `purchasing.createPurchaseOrder` capability by default in local setups with `CHASTE_GO_PURCHASING_CREATE_ORDER=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. It preserves approval responses and same-intent legacy fallback, retains the exact draft and scoped idempotency intent while a result is pending or uncertain, and rejects invalid quantities and prices before submission.
- Vite purchase requests, decisions, RFQs, quote recording, and quote awards use Go's session-authenticated purchasing capabilities by default in local setups with `CHASTE_GO_PURCHASING_SOURCING_WRITES=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Scope-hashed local drafts restore the exact pending request or quote after reload; scoped retry IDs persist through pending or uncertain results, and 404 fallback reuses the same intent. Estimate and quote money use the workspace currency.
- Go purchasing request decisions and quote workflows serialize on the request row, preventing contradictory concurrent decisions and duplicate purchase orders; RFQ input now rejects duplicate vendors.
- Public invoice links now load through the Vite portal page and Go token-scoped invoice read. The page omits browser credentials, suppresses referrers, and only admits the exact token path.
- Invoice print pages now load in Vite through Go's verified-session and organization-scoped sales invoice read. Unsupported methods and non-exact route paths keep their legacy fallback.
- Route the Vite Sales orders collection read through Go's verified-session `sales.listOrders` capability by default. The `{ orders }` response and known status filters match the legacy API; only exact GET `/api/sales` moves, while writes and unrelated paths remain on legacy.
- The standalone support widget now loads in Vite and posts public start, poll, message, and escalation actions to Go. Configure `GO_SUPPORT_TRUSTED_PROXY_CIDRS` with the exact proxy peers in production so Go can safely rate-limit by visitor IP.
- The `/sessions` page is now Vite-owned, with session trajectories, canonical replay, durable-run details, and context metrics read through Go's authenticated GET routes. Go returns oversized details with the same bounded error behavior as legacy.
- The `/ledger` page is now Vite-owned and its session-authenticated `GET /api/ledger` read is Go-owned. Unsupported API methods and unknown paths keep their legacy fallback.
- Session-authenticated `GET` and `POST /api/support/channels` now use Go. The settings write enforces same-origin requests and checks organization membership, Support availability, and `iam.admin` before its organization-scoped upsert; embed tokens remain visible only to organization admins.
- Vite segment creation now defaults to the Go `marketing.createSegment` capability. Permission checks, policy approvals, intent receipts, and the legacy path for other Marketing actions remain in place.
- SCIM collection and single-user reads and writes now use Go by default. Bearer token writes execute through the governed `iam.scimProvisionUser` capability with org scope, idempotent receipts, and external-actor audit events; malformed identity inputs are rejected.
- Session-authenticated `GET /api/inventory` now serves the Go capability-backed catalog and SKU movement history. Inventory writes remain on legacy, and the response preserves the full catalog payload for Vite inventory consumers.
- Vite POS collection `GET /api/pos` uses Go's verified-session, organization-scoped reader by default and preserves the `{ sessions, sales }` response. `GO_POS_READ_ROUTE` and `CHASTE_GO_POS_READ_ROUTE` default on. Set `CHASTE_GO_POS_READ_ROUTE=0` to send Vite traffic to legacy; also set `GO_POS_READ_ROUTE=0` to unmount the Go endpoint. Unsupported methods and suffix paths remain on legacy. The `/pos` page remains legacy-owned; this moves the Vite API read only.
- Exact Vite `POST /api/pos/shift-summary` uses Go's session-authenticated `pos.shiftSummary` capability and preserves the legacy response envelope. `GO_POS_SHIFT_SUMMARY_ROUTE` and `CHASTE_GO_POS_SHIFT_SUMMARY_ROUTE` default on. Set `CHASTE_GO_POS_SHIFT_SUMMARY_ROUTE=0` to send Vite traffic to legacy `POST /api/pos`; also set `GO_POS_SHIFT_SUMMARY_ROUTE=0` to unmount the Go route. Other POS POST actions remain on legacy. Automated checks pass; authenticated browser proof remains open.
- Vite POS customer lookup now uses the direct Go `GET /api/pos/customers` reader by default, independently of the generic session-capability route. It preserves the legacy POS access rule (`crm.read` or `pos.sell`), works without the CRM module, and returns up to 500 active customers with POS purchase counts and net spend. Set `CHASTE_GO_POS_CUSTOMERS_SLICE=0` to roll back; only a missing Go route falls back to `/api/customers`. Set `GO_POS_CUSTOMERS_ROUTE=0` to unmount the Go route. CRM and Support lookups remain unchanged.
- Vite POS register opening now uses Go's session-authenticated `pos.openSession` capability by default when `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set `CHASTE_GO_POS_OPEN_SESSION_SLICE=0` to roll back this action; a missing Go capability route falls back to legacy using the same intent, while other POS actions remain unchanged.
- Vite POS register closing now uses Go's session-authenticated `pos.closeSession` capability by default when `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set `CHASTE_GO_POS_CLOSE_SESSION_SLICE=0` to roll back this action; a missing Go capability route falls back to legacy using the same intent, while other POS actions remain unchanged.
- Vite POS quick product creation and opening stock adjustment now use Go's `inventory.createItem` and `inventory.adjustStock` capabilities when `CHASTE_GO_INVENTORY_ITEM_SLICE=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set `CHASTE_GO_INVENTORY_ITEM_SLICE=0` to restore both actions to `/api/inventory`; each action keeps a fresh intent ID, the POS response data, and pending approval reasons.
- Vite inventory transfer creation and confirmation use actor- and organization-scoped persistent intents through pending approvals and uncertain responses. A missing Go route falls back to `/api/inventory` with the same intent; malformed markers fail closed, and success or definitive client errors clear the active retry marker.
- Vite inventory location creation and stock reservation/release use Go's `inventory.createLocation`, `inventory.reserveStock`, and `inventory.releaseReservation` capabilities when `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set `CHASTE_GO_INVENTORY_LOCATION_RESERVATION_WRITES=0` to restore these actions to `/api/inventory`; Go writes require actor and organization scope, unresolved intents block selector rollback, approval-pending retries keep their intent, and location codes are trimmed and uppercased before validation.
- Vite cycle-count barcode lookup now uses Go's `inventory.lookupByBarcode` capability when `CHASTE_GO_INVENTORY_BARCODE_LOOKUP=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set the barcode selector to `0` to use `/api/inventory`; a missing Go capability route also falls back to the legacy lookup.
- Vite CRM deal stage changes now use Go's `crm.moveDealStage` capability when `CHASTE_GO_CRM_DEAL_STAGE_MOVE=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set the selector to `0` to use the legacy `/api/deals` action. Only a missing Go route falls back to legacy, with the same actor/org-scoped intent and exact action; other Go failures, including 408 and 429, retain the retry identity. Lost reasons remain required and capped at 500 characters, and pending or failed changes roll back optimistically while keeping the reason draft available for retry.
- The `/login` page is now Vite-owned. Sign-in, sign-up, verification, and password recovery continue to use the Go-backed auth endpoints.
- The `/` Dashboard page and its `GET /api/dashboard` and `GET /api/setup` reads are now Vite/Go-owned. Mirror `SMTP_HOST` and coding-agent CLI `PATH` between Go and Next so the setup checklist agrees across runtimes; unknown paths and unsupported API methods keep their legacy fallback.
- The `/team` page is now Vite-owned and uses the Go-owned `GET` and `POST /api/team` routes. Other paths continue through the existing legacy fallback.
- Session trajectory and durable-run detail reads now enforce matching response limits in the Go API and legacy API: 10,000 session events, 256 KiB per event, an 8 MiB session response, and 200 durable-run steps with a 2 MiB logical JSON response cap. Both APIs check visibility before revealing an oversized durable run.

### Changed
- Route Vite module switchboard reads and the Projects page's GET/POST operations through Go by default. Project writes keep session, tenant, permission, approval, and intent checks; set the matching `CHASTE_GO_*_ROUTE` selector to `0` to restore legacy proxying, and the paired `GO_*_ROUTE` flag to `0` to unmount that Go handler.
- Route Vite `/team` GET and POST requests through Go by default. Session verification, organization scope, capability permissions, approvals, and intent receipts remain enforced; set the matching Go and Vite team route flags to `0` for legacy fallback.
- Enable the Vite Sessions page metrics read through Go by default. Set `CHASTE_GO_METRICS_ROUTE=0` to restore the legacy proxy, or `GO_METRICS_ROUTE=0` to unmount the Go handler; unsupported methods and extra paths retain legacy fallback.
- Route exact session-authenticated `GET /api/analytics` requests through Go by default for dataset discovery and previews. Go report `POST /api/analytics` remains on the legacy handler; setting both analytics route flags to `0` rolls back the GET route.
- Enable eligible Vite conversation sends through Go's governed `messaging.sendMessage` capability by default. Mentions, replies, attachments, stable retry intents, inverse metadata, and pending approvals are preserved; agent-enabled conversations and @agent messages remain on the legacy route.
- Enable the exact `POST /api/support/channels` settings update through Go in local Vite setups with `CHASTE_GO_SUPPORT_CHANNELS_WRITE_ROUTE=1`. Set it to `0` to return writes to legacy; GET keeps its existing selector, and other methods and paths remain on legacy.
- Enable cycle-count create, record, post, and cancel through Go's session capability route. Inventory permission and module checks, approvals, and intent receipts apply; posted counts are corrected with a fresh count and only open counts can be cancelled.
- Enable POS sales and returns together through Go's session capability route. A sale can be compensated with a governed full or partial return that credits the invoice and restores returned stock; approval, permission, module checks, and intent receipts remain in force.
- Enable the tenant-scoped Go `GET /api/my-work` reader by default. PostgreSQL-backed coverage verifies approval and receipt-remainder cards remain isolated by organization.
- Enable Go `POST /api/my-work/summarize` by default for Vite. Verified session and organization checks, bounded card input, server-side workspace credentials, and disabled coding-agent tools remain enforced; set `CHASTE_GO_MY_WORK_SUMMARY_ROUTE=0` to send browser requests to legacy, and set `GO_MY_WORK_SUMMARY_ROUTE=0` to unmount the Go route.
- Enable the session-authenticated, capability-backed Go `GET /api/signals` feed by default. Unsupported methods and suffix paths continue through legacy.
- Enable Go's session-authenticated `GET` and governed `POST /api/branding` by default in Vite and the Go API. Branding approval responses remain compatible with Settings.
- Enable session-authenticated Go `GET` and governed `POST /api/modules` by default in Vite and the Go API. POST approval-pending and success envelopes remain compatible with Settings.
- Mount Go auth routes by default to match the Vite proxy; set `GO_AUTH_ROUTE=0` only to keep auth on the legacy handler.
- Route the Vite Products catalog and create, edit, archive, and stock actions through Go's session-authenticated capability endpoint in new local setups. Product defaults and CSV import/undo remain on legacy routes.
- Go supports authored document reads and parses pasted text or uploaded documents into org-scoped memory using the configured OCR and embedding providers. Parse failures retain the failed document state and failure receipt.
- Align the Go project, team, module, dashboard, and setup handlers with legacy validation, response, permission, and readiness behavior. Project and team Go API routes are enabled in the local Vite environment and marked verified against the API contracts.
- The `/analytics` page is now recorded as Vite-owned in the migration manifest. Direct visits load the React Analytics page and its verified Go-backed API routes.
- The `/projects` page is now recorded as Vite-owned. Its React page preserves project and board reads, creation, task assignment and movement, archive confirmation, module state, and pending approval behavior.
- The `/products` page is now recorded as Vite-owned. The Vite catalog preserves filtering, product and service creation, stock opening, edits, archive, CSV import with undo, module defaults, and approval-pending feedback.
- Route only auth methods and paths implemented by Go to its auth handler. Other Better Auth paths and methods continue through the legacy catch-all; optional OIDC and SAML paths require their matching Vite auth selectors.
- The local Vite/Go environment enables the session-authenticated analytics `GET` for dataset discovery and previews. Report `POST /api/analytics` remains on legacy until its route cutover.
- Added Vite proxy selectors for Go SCIM collection reads, user reads, provisioning, deactivation, and token management. Collection and user selectors remain off locally. Token management and notification feed/read-receipt routes are Go-owned in the migration manifest and enabled in the local Vite/Go configuration. Token mint and revoke require a UUID `Idempotency-Key`; listing matches the legacy organization-member guard and timestamp precision. Notification read receipts use reversible capabilities.
- The `pnpm worker` command now supervises both Go workers with role-scoped environments and forwards shutdown signals. The routine E2E proof now waits for worker shutdown and no longer reads transient verification links from the email outbox.
- Go approval requests now persist organization-scoped action intents and canonical input digests. Matching retries reuse the pending approval, conflicting capability or payload reuse is rejected, and approved execution records the original intent receipt. Vite Sales retains the intent while approval is pending and clears it after resolution.

### Fixed

- Make Go session and durable-run mounts fall through to legacy for invalid UUIDs, unsupported methods, and extra path segments instead of capturing them with wildcard route patterns.
- Pass the loaded `.env` values into the Go API process launched by `pnpm dev:api`, and forward shutdown signals to it.
- Require stable intent IDs for Go Projects and Team writes, including the legacy-to-Go Team bridge, so retries use executor receipts instead of silently running without idempotency. Reject blank, overlong, and control-containing Team IDs in both React and server adapters.
- Require the dashboard `signals` array in Vite responses and reject malformed or duplicate organization selectors before Go dashboard reads.
- Match SCIM collection filter whitespace, bounded pagination, query validation, and error bodies across Go and the legacy API. Go collection and provisioning handlers now share the same 60-attempt source-IP budget and legacy 401 response, while DELETE uses one SCIM 404 envelope for missing, foreign, and malformed IDs.
- Bound My Work summary request size and card text consistently across the legacy and Go handlers to limit untrusted model input.
- Align Go and TypeScript branding behavior for unknown fields, including case-variant aliases, UTF-16 limits, intent validation, permission errors, and pending-approval responses; approval rationale is not returned to the client.
- Keep the Vite Accounting books available when auxiliary cash-basis or bank-feed requests fail at the network layer, matching the legacy page's failure handling.
- Keep archived Projects boards read-only in both React clients and reject task moves or assignments at the TypeScript and Go capability boundaries.
- Explain the generic Go sign-up result without claiming that every request sent a verification email; duplicate addresses receive the same response without a new email being queued.
- Restore the Sales allow-backorder choice in Vite confirmation and keep it with pending approval retries; queued POS receipts now retain the customer email captured for that sale.
- Show payment method, cash received, and change in Vite receipts after retrying an offline POS sale, matching the normal-sale and legacy receipts.
- Ignore Inventory refresh callbacks that arrive after the page unmounts, while keeping the latest report response when action refreshes overlap.
- Go OIDC connections now pin DNS results to public IPs, reject private or special-use network answers, bypass proxy re-resolution, and fail closed when the transport cannot pin an address.
- Customer creation now retains one action intent across retries, validates Go success and approval envelopes, recovers the QuickCreate modal after transport errors, selects only valid customer UUIDs, and shows duplicate warnings.
- Match legacy report validation by rejecting explicit `null` for optional Analytics `narrative`, `ops`, and `chart` fields before running dataset capabilities.
- Cancel pending Vite Analytics previews and report generation when leaving the page, prevent concurrent duplicate previews, and keep report section selection within the API limit.
- Hide pending approvals with capability IDs unknown to the Go permission catalog, including from wildcard users, matching the legacy dashboard and avoiding disclosure of unsupported approval details.
- Vite 8 now forwards opt-in Go routes using method and path checks in middleware before the legacy API proxy. Unmatched methods and paths continue to the legacy API.
- Clear a stale verification-resend success message when returning to sign-in or switching auth modes, so another unverified account can request its own link.

### Added

- The Go API serves `GET` and `POST /api/notifications`, including per-user read receipts through governed `notifications.markRead` and `notifications.restoreRead` capabilities. Unsupported methods and paths continue to the legacy API.
- Go serves session list, detail, replay, and durable-run list/detail reads by default. Both API mounts and Vite selectors default on unless their corresponding flags are set to `0`; set both paired flags to `0` for a route's legacy fallback. Session and run visibility remains scoped to the active organization and authenticated user, with admin access preserved. Unmatched methods and paths continue to the legacy API.
- Session-authenticated `GET /api/my-work` now routes through Go by default in both Vite and the API. Set `CHASTE_GO_MY_WORK_ROUTE=0` and `GO_MY_WORK_ROUTE=0` to use the legacy handler; unsupported methods and extra paths keep the legacy fallback.
- The Go API can opt authenticated work summaries into `POST /api/my-work/summarize` with `GO_MY_WORK_SUMMARY_ROUTE=1`, paired with `CHASTE_GO_MY_WORK_SUMMARY_ROUTE=1`. It loads and decrypts workspace credentials server-side, uses the legacy fast-to-primary fallback, pins public HTTPS model endpoints, and permits loopback HTTP only in explicit development mode. It can run the authenticated user's default OpenCode connection with tools disabled or the same user's isolated Codex home in read-only CLI mode. Unsupported providers and missing Codex runtime resources fail closed. Both selectors are default-off and route ownership remains legacy.
- The Go API can opt `GET /api/signals` into Go with `GO_SIGNALS_ROUTE=1`, paired with `CHASTE_GO_SIGNALS_ROUTE=1`. The verified session and `signals.list` capability govern the read; severity and module filters, `{signals}` response, and no-store behavior match legacy. Both selectors are default-off and route ownership remains legacy.
- The Go API serves `GET`, `POST`, and `DELETE /api/scim/tokens` with `GO_SCIM_TOKENS_ROUTE=1`, paired with `CHASTE_GO_SCIM_TOKENS_ROUTE=1`. Listing requires verified organization membership, matching legacy authorization; mint and revoke run through governed capabilities, require a UUID `Idempotency-Key`, and never persist the raw bearer in receipts or audit events. The raw token is returned only once. Revoke is destructive because the stored hash cannot recover the bearer; policy-pending revokes return the standard approval response. Local flags enable these routes and the ownership manifest records Go as owner.
- Vite can opt the public support widget endpoint into Go with `CHASTE_GO_SUPPORT_PUBLIC_ROUTE=1` paired with `GO_SUPPORT_PUBLIC_ROUTE=1`. Both flags default to off, and the proxy preserves the widget request and streamed response.
- Vite authentication now supports Go email verification, verification resend, password reset requests, and token-based password updates. Reset links are removed from browser history as soon as the recovery page opens.
- Organization admins can explicitly delegate public support auto-replies to their personal connected OpenCode account from AI settings. Go supplies only organization-scoped order status and published knowledge facts, keeps OpenCode tools disabled, and does not fall back to workspace credentials when the delegated connection fails.
- Vite can opt the dashboard setup checklist read into Go with `CHASTE_GO_SETUP_ROUTE=1` paired with `GO_SETUP_ROUTE=1`; it keeps the same `iam.admin` gate and falls back to the legacy endpoint by default.
- The Vite app now calls Go's auth endpoints through a small typed browser client and no longer depends on Better Auth's JavaScript client for session, email sign-in, sign-up, or sign-out.
- Added a default-off Go-owned OIDC authorization-code sign-in flow with state, nonce, PKCE, issuer/signature/audience validation, explicit verified-email trust for linking, and existing Go session cookies. An optional native-client handoff uses a short-lived, single-use PKCE-bound code and returns the live session token only from the authenticated exchange endpoint.
- Added default-off Go SAML sign-in handling with pinned IdP trust, signed-response validation, one-use request correlation and replay protection, and Go-owned sessions.
- Vite can opt cycle-count creation, recording, posting, and cancellation into Go's authenticated inventory capabilities. The default remains the legacy inventory route; fallback occurs only when the Go capability endpoint returns 404, and uncertain retries retain the original intent ID.
- Vite can opt POS sales into Go's authenticated `pos.completeSale` capability with `CHASTE_GO_POS_COMPLETE_SALE_SLICE=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`; the default remains the legacy POS route, carts and queues are scoped to the active organization and operator, uncertain attempts lock to their saved cart and intent until retried or explicitly abandoned, and queued attempts retire their retry mapping when consumed or discarded.
- Vite can opt POS register closing into Go's authenticated `pos.closeSession` capability with `CHASTE_GO_POS_CLOSE_SESSION_SLICE=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`; the default remains the legacy POS route and fallback occurs only when the Go route is absent.
- Vite can opt register opening into Go's authenticated `pos.openSession` capability with `CHASTE_GO_POS_OPEN_SESSION_SLICE=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`; the default remains the legacy POS route and fallback occurs only when the Go route is absent.
- Vite can opt BOM definition into Go's authenticated `manufacturing.defineBom` capability with `CHASTE_GO_MANUFACTURING_DEFINE_BOM_SLICE=1`, paired with `GO_MANUFACTURING_DEFINE_BOM_SLICE=1` and the Go session capability route. The slice defaults to the legacy endpoint, falls back only when the Go endpoint is absent, and fails closed when Go reports it disabled.
- Vite work order creation, release, completion, and cancellation can use Go's authenticated manufacturing capabilities with `CHASTE_GO_MANUFACTURING_WORK_ORDER_WRITES=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. The legacy manufacturing route remains the fallback when the capability endpoint is absent; retry intents are persisted per actor and organization through pending or uncertain results, and work order drafts remain available after errors.
- Vite BOM production and production-run reversal can use Go's authenticated `manufacturing.produceFromBom` and `manufacturing.reverseProductionRun` capabilities with `CHASTE_GO_MANUFACTURING_PRODUCTION_WRITES=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Scoped retry intents survive pending or uncertain results and 404 fallback; capability outputs are validated before success is reported.
- Vite can opt marketing segment creation into Go's authenticated `marketing.createSegment` capability with `CHASTE_GO_MARKETING_SEGMENT_SLICE=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`; the default remains the legacy route, and other marketing actions are unchanged.
- Vite can opt eligible conversation message sends into Go's authenticated `messaging.sendMessage` capability with `CHASTE_GO_MESSAGING_SEND_SLICE=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`; the default remains the legacy route, user mentions, replies, attachments, and approval-pending behavior are preserved. Agent-enabled conversations and @agent messages remain on the legacy route until Go workmate replies are supported.
- Vite Sales can confirm draft orders through Go's existing authenticated `sales.confirmOrder` capability. Approval responses are preserved, and all other sales actions remain on their existing routes.
- Vite Sales can create, deliver, and cancel orders through Go's authenticated `sales.createOrder`, `sales.deliverOrder`, and `sales.cancelOrder` capabilities with `CHASTE_GO_SALES_ORDER_WRITES=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Drafts and action targets stay in place on pending or failed responses, and create/deliver-all/cancel retries reuse actor- and organization-scoped intents. Delivery records all remaining reserved lines, matching the existing Next flow.

### Fixed

- Go Projects reads reject unsupported query parameters and repeated `projectId` values instead of silently choosing one value.

- Agent-session trajectory events and token usage now run in organization-scoped transactions, with the session row locked while assigning event sequence numbers. This keeps session history and usage visible under PostgreSQL row-level security and prevents concurrent writers from assigning the same sequence.
- OIDC discovery now rejects non-HTTPS or untrusted endpoint authorities, including JWKS, before tokens can be exchanged; multi-audience ID tokens require an authorized party that matches the configured client.
- Go capability execution now binds pending approvals to an organization-scoped intent and input digest. Retrying an identical request reuses its approval; reusing the intent for a different action or payload is rejected. Vite Sales keeps the same intent while approval is pending and offers a status check instead of a second confirmation.
- The opt-in Vite inventory item slice now reads stock totals and records item creation and stock adjustments through Go's authenticated capability endpoint. It requires both `CHASTE_GO_INVENTORY_ITEM_SLICE=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`; other inventory operations and public route ownership stay unchanged.
- Vite product CSV import and undo can use Go's authenticated `inventory.importItems` and `inventory.undoItemImport` capabilities with approval, stable retry intents, per-organization rate limiting, and `import_products` onboarding completion. The rate limit is process-local, so each API replica has its own quota and restarts reset it, matching the legacy helper. Enable with `CHASTE_GO_INVENTORY_IMPORT_SLICE=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`; oversized or unsupported requests retain the legacy route, and product defaults remain legacy-owned.
- Support knowledge-base articles are private by default. Staff can explicitly publish an article, and public widget retrieval only searches published articles.
- Browser auth responses no longer expose reusable session bearer tokens, and email verification responses now prevent caching and referrer leakage. Native clients without browser request metadata retain bearer token issuance.
- The Go metrics route now falls back when the active organization cookie refers to a removed membership, matching the legacy session behavior.
- Go public support auto-replies use tenant-scoped support articles and conversation-bound order lookups, quote customer transcripts as untrusted data, and pin provider requests to public HTTPS addresses without proxy or redirect access.
- Go public support auto-replies enforce organization-wide draft and concurrency limits, with expiring reservations and retained counters cleaned up automatically.
- Vite document editing cancels a pending page-settings save when the editor effect is cleaned up, avoiding duplicate draft writes during remounts.
- The Go dashboard trend query reads only the six months included in its response.
- The legacy SCIM single-user route now applies the shared token rate limit and expiry check to both reads and deactivation requests.
- Added an opt-in Go SCIM user read handler with hashed-token resolution, expiry checks, paginated collection reads, accurate filtered totals, and organization-scoped queries; production route ownership remains unchanged.
- Connected Go public support knowledge search to the organization-scoped semantic article index and added an opt-in worker for published article embeddings. Both route and worker remain disabled by default.
- Added exponential retry backoff for failed support article embeddings so a provider failure does not starve later articles in the same organization.
- Added separate opt-in Go SCIM provisioning and deactivation routes through governed external-IdP capabilities. Standard clients can omit `Idempotency-Key`; explicit UUID keys are also supported. Audit records omit email values and fingerprints.

- Vite routes explicitly implemented auth method and path pairs to Go by default. Unsupported Better Auth methods and paths continue through the legacy auth handler.
- Vite vendor creation can opt into Go's session-authenticated `purchasing.createVendor` capability with `GO_SESSION_CAPABILITY_ROUTE=1`, `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`, and `CHASTE_GO_PURCHASING_VENDOR_SLICE=1`. It preserves approval responses and falls back to the existing Purchasing action only when the Go route is absent; default flags keep the legacy request path.
- **Added direct Go reads for the Vite dashboard, ledger, and metrics APIs.** Dashboard and setup reads now use Go by default; ledger and metrics remain legacy-owned unless their matching Go mount and Vite proxy flags are enabled.
- **Opt-in Go ownership for projects, team, module settings, branding, and analytics.** Go can now serve session-authenticated `GET`/`POST /api/modules`, `GET`/`POST /api/team`, `GET`/`POST /api/projects`, `GET`/`POST /api/branding`, and `GET /api/analytics` behind matching API and Vite flags. State changes run through the governed capability executor; the team response derives its permission catalog from Go capability metadata. Other methods keep their current owner.
- **Added opt-in Go ownership for invoice, support-channel, and governed-action endpoints.** Go now resolves Better Auth cookie or bearer sessions directly for `/api/sales/{orderId}`, `/api/support/channels`, and `/api/capabilities/execute`; native clients can select an organization with `X-Organization-ID`, which the Go session resolver checks against membership. Public portal invoice reads use a narrowly granted token resolver. Go and Vite route flags keep the legacy API as the default until each route is proven.
- **Made Go auth mode explicit and email delivery durable.** `GO_AUTH_ROUTE=1` now requires `GO_AUTH_MODE`; production auth independently enforces an explicit HTTPS origin and secure cookie policy. Verification and recovery links enter a PostgreSQL outbox in the same transaction as their account or recovery token, with leased retry, expiry cleanup, and process restart recovery.
- **Made the Go organization route compatible with runtime RLS.** A narrowly granted security-definer function resolves a valid Better Auth session to its domain identity and membership ids. Go now loads role grants, organization fields, and agent persona data inside `dbx.WithOrgTx`, and rechecks membership before returning tenant data.
- **Hardened Go worker lease handling.** Job and routine work now stops when lease renewal errors, times out, or reports lost ownership, and stale workers cannot write completion or retry state after their lease is uncertain.
- **Hardened Go accounting report and FX totals.** Report and exposure calculations now reject unsafe integer totals and preserve zero exposure rows for fully settled currencies, matching the TypeScript behavior.
- **Validated Vite CRM API responses.** Saved-view writes now require the documented success envelope, and customer import and undo only treat valid approval responses as pending.
- **Hardened public support widget polling.** The Next and Go endpoints now accept polling credentials in POST bodies only, and widget state is scoped to its embed token so a prior visitor thread is not shown after switching tokens. Go auto-reply behavior still needs parity before this endpoint can be cut over.
- **Every application page now lives in the React workspace.** All 30 route-manifest pages are served by the Vite app, so no business page redirects back to the legacy Next.js app. Newly ported: `/accounting`, `/messages`, `/settings`, `/purchasing`, `/purchasing/receiving`, `/support`, `/manufacturing`, `/marketing`, `/proposals`, `/onboarding`, `/documents/editor/[id]`, `/portal/[token]`, `/widget/[token]`, and `/print/invoice/[orderId]`. The public share surfaces (`/portal`, `/widget`), the onboarding wizard, and the print sheet render outside the authenticated shell so they keep their chrome-less layout. Each port validates every response at runtime with strict schemas, preserves `intentId` idempotency on governed writes, surfaces HTTP 202 approval-pending states as pending rather than as success or failure, keeps money in integer minor units, and fails closed on malformed payloads.
- **Fixed a Vite dev proxy gap that silently broke API calls.** The dev proxy listed API prefixes by hand and had drifted 36 prefixes behind the route manifest, including `/api/crm`, `/api/inventory`, `/api/documents`, `/api/pos`, and `/api/marketing`. An unproxied `/api` path fell through to the SPA fallback, which answered `index.html` at HTTP 200, so the client surfaced a JSON parse error instead of the real configuration fault. The proxy now forwards all `/api` traffic to the legacy app behind a single catch-all, with `/api/health` still routed to the Go API first.
- **Added a read-only endpoint for the ported invoice print view.** `GET /api/sales/[orderId]` returns the org-scoped order, lines, and governed branding behind authentication. The Next page read those tables server-side, which the Vite client cannot do. It keeps the legacy contract of answering an unknown order with HTTP 200 and the message `Invoice not found.` rather than introducing a 404 before the API version changes.
- **Complete Go capability coverage.** All 315 ids in the live capability registry now have a Go implementation: 22 `documents` capabilities, 22 `messaging` capabilities, `settings.configureAiProvider`, `settings.restoreAiProvider`, and `harness.approveComposition`. Each preserves its manifest schema, Zod parser behavior, organization scoping, approval payloads, audit and receipt contracts, and fails closed on malformed input. `messaging` preserves the existing non-monotonic read cursors, the ignored `listConversations` filters, and agent mention suppression. Database-backed proofs cover tenant isolation, folder ancestors, version restore, conversation membership, and attachment handling.
- **Fixed a Go module gate divergence.** `isModuleEnabled` now always allows `settings` and the protected spine modules `iam`, `signals`, and `routines`, matching `createDbModuleGate` in the TypeScript kernel. Previously any organization that had saved a module list silently lost IAM governance in Go while TypeScript still permitted it.
- **Fixed a Go integer validation divergence.** The shared `requiredSafeInteger` parser rejected nothing about quoted numbers, because `json.Unmarshal` decodes `"5"` into a `json.Number`. Go accepted integer fields that Zod's `z.number()` refuses, across 81 call sites. It now rejects every quoted spelling, and two tests that asserted the lenient behavior under the name "mirror Zod contracts" were corrected to assert the real Zod contract.
- **TypeScript 7.0.2 (native Go compiler).** Every workspace package type-checks with the native compiler, measured 5.7x faster on `packages/kernel` and 6.1x on `apps/web-vite` than TypeScript 5.9.3 on the same machine and sources. Following Microsoft's side-by-side guidance, `typescript` is aliased to `@typescript/typescript6` so `typescript-eslint` and the migration scripts that read the compiler AST keep the TypeScript 6 API, while `@typescript/native` provides the 7.0 `tsc` binary. `tsconfig.base.json` now declares `"types": ["node"]` explicitly, which TypeScript 7 no longer includes by default. Type checking, lint, tests, and the Vite production build are unchanged.
- **Migration performance measurements.** README and benchmark reports show a three-run Vite build median of 25.77s versus 34.90s for Next. A refreshed server startup sample measured 2.767s for Vite and 3.491s for Next to the first TCP listener connection; edit-to-ready and route readiness remain unmeasured.
- **Go accounting and inventory parity proofs.** Database-backed executor tests cover concurrent invoice-payment overage prevention, approved stock-adjustment audit details, and cross-organization item isolation.
- **Go Purchasing bill payment parity proof.** A database-backed governed executor test confirms simultaneous bill payments cannot exceed the outstanding balance or duplicate payment postings.
- **Go Purchasing receipt-history parity proof.** The database-backed Go projection test now confirms legacy stock movements appear in accepted and remaining order-line totals without creating synthetic receipt records.
- **Go routine stock-history access.** The opt-in Go routine agent can now read recent stock movements through the governed inventory capability, with database-backed organization isolation coverage.
- **Go routine trial-balance access.** The opt-in Go routine agent can now check account totals by currency through the governed accounting capability, with database-backed organization isolation coverage.
- **Go routine balance-sheet access.** The opt-in Go routine agent can now read balanced assets, liabilities, equity, and retained results through the governed accounting capability, with database-backed organization isolation coverage.
- **Go routine income-statement access.** The opt-in Go routine agent can now read base-currency revenue, expenses, and net income through the governed accounting capability, with database-backed organization isolation coverage.
- **Go approval decision atomicity.** Rejection status and its audit event commit together. Approved capability effects, execution audit, and final status now share one transaction; failure injection confirms the effect rolls back and the approval returns to pending.
- **Legacy approval decision atomicity.** The production TypeScript route commits approved capability effects, audit entries, and final status together. Failure injection verifies rollback and restores the approval to pending; rejection status and its ledger event remain atomic as well.
- **HR interaction parity.** Preserve draft input when an action is waiting for approval, and add arrow, Home, and End keyboard navigation to People workspace tabs. Inventory history and marketplace reads now time out instead of remaining in loading states indefinitely.
- **Vite People workspace.** The React app now exposes People, hiring, leave, time, and payroll draft/history surfaces through the existing governed HR endpoints. Payroll execution and voiding, plus Expense controls, continue to use the full legacy workspace.
- **Vite Documents preview and safer file delivery.** The React app now browses document records and extracted text, while module-disabled organizations cannot list or fetch document files. Detail responses omit original base64 and raw text fields; active or unknown file types download instead of rendering inline.
- **Go Creator capabilities.** Implement all 13 Creator proposal, scaffolding, plugin marketplace, and controlled release capabilities in the governed Go executor, preserving tenant scope, approval payload checks, audit records, and replay behavior.
- **Opt-in Go Creator workflows.** Creator evolution mutations and marketplace verification, listing reads, publish, install, and uninstall can dispatch through the signed Go capability bridge behind default-off flags. The listing read bridge validates every field and fails closed on uncertain outcomes. Marketplace writes validate their success and approval responses in the Vite client. Human verification preserves the legacy signed-session and organization-membership access; agents retain their Creator module and permission gates, and system executions retain the module gate.
- **Vite inventory operations.** The React inventory page now supports item creation and stock adjustment, location creation, reservations and release, cycle counts, partial transfer confirmation, and stock movement history through the existing governed inventory API. Writes carry intent IDs, preserve approval-pending responses, and reconcile timed-out outcomes through refreshed history. History unit costs use the organization base currency and its minor-unit exponent.
- **Marketplace verification errors.** The opt-in Go verification bridge now preserves the legacy verdict contract for invalid manifests and passes permission errors to the Vite page with their actual message.
- **Vite CRM task assignments.** Load team members when opening Customers or Tasks so owners can be assigned from a fresh Tasks view; a failed team lookup can be retried.
- **Opt-in Go inventory valuation reversals.** The `reverseValuationSummary` action can use `inventory.reverseValuationSummary` behind `GO_INVENTORY_VALUATION_SUMMARY_WRITE=1`. The flag defaults off, preserving the TypeScript executor path; Go responses retain approval and error contracts, and unavailable or malformed results fail closed without a TypeScript retry.
- **Vite Products catalog.** The React app now owns `/products` with catalog filtering, product and service create/edit/archive, opening stock, mapped CSV previews and validation, duplicate reporting, governed import, and import undo through existing same-origin business APIs.
- **Migration build benchmarks.** README now summarizes measured Next.js, Vite, and Go build times and peak memory, with the existing scope and sample-size caveats.
- **Inventory reversal approval parity.** The Go bridge validates its pending approval envelope and removes the internal approval ID to match the legacy API response.
- **Preserved empty inventory location strings through Go.** The opt-in stock-location bridge now accepts the empty `code` or `name` strings allowed by the legacy output contract and database schema.
- **Opt-in Go support inbox reads.** `GET /api/support` can dispatch customer-bound inbox lists through `support.listConversations` behind `GO_SUPPORT_CONVERSATION_READS=1`. The Go query filters customer-bound threads before the limit to preserve the legacy join and pagination behavior; strict response validation and missing actor context fail closed without TypeScript fallback.
- **Opt-in Go support conversation detail reads.** `GET /api/support?id=<id>` can dispatch through `support.readConversation` behind `GO_SUPPORT_CONVERSATION_DETAIL_READS=1`. The Go output preserves the legacy oldest-first 200-message detail projection while routine calls without a limit retain their existing shape.
- **Hardened Go support conversation detail reads.** Uppercase UUID query values now match Go's canonical response IDs, transcript row-stream errors fail closed instead of returning partial messages, and empty transcripts serialize as arrays.
- **Opt-in Go CRM task reads.** `GET /api/crm` task lists can dispatch through `crm.listTasks` behind `GO_CRM_TASK_READS=1`, preserving open-task filtering and the existing response shape. Other CRM reads remain on their current handlers.
- **Opt-in Go supplier statement reads.** The `supplierStatement` action on `POST /api/purchasing` can use `purchasing.supplierStatement` behind `GO_PURCHASING_SUPPLIER_STATEMENT_READS=1`. The flag defaults off, response fields are strictly validated, and unavailable or malformed Go results fail closed without a TypeScript retry.
- **Go routine supplier statements.** Go routines can read a tenant-scoped supplier statement through `purchasing.supplierStatement` using `purchasing.read`, with a session-linked audit event.
- **Hardened supplier statement reads.** Bill, credit, and payment row-stream errors now fail closed, and equal-date/equal-kind rows retain stable TypeScript ordering.
- **No-store Go invoice reads.** Go-backed `GET /api/accounting` responses, including unauthorized and permission-denial responses, explicitly disable caching.
- **Opt-in Go support library reads.** `GET /api/support?library=1` can dispatch through the signed `support.listLibrary` capability behind `GO_SUPPORT_LIBRARY_READS=1`. The response keeps its organization-scoped canned response and article lists, uses no-store caching, and fails closed without a TypeScript retry.
- **Opt-in Go inventory item metadata reads.** `GET /api/inventory` can fetch the IDs and catalog metadata merged into stock report rows through `inventory.listItemMetadata` behind `GO_INVENTORY_ITEM_METADATA_READS=1`. The bridge is organization-scoped, strictly validated, and fails closed without a TypeScript retry.
- **Opt-in Go supplier performance reads.** `GET /api/purchasing` can dispatch vendor performance metrics through `purchasing.supplierPerformance` behind `GO_PURCHASING_SUPPLIER_PERFORMANCE_READS=1`. The flag defaults off; responses are strictly validated and unavailable or malformed Go results fail closed without a TypeScript retry.
- **Hardened supplier performance reads.** Go now checks vendor, order, and line row-stream errors before returning supplier metrics, preventing partial reports from appearing successful.
- **Opt-in Go HR applicant reads.** Applicant lists in `GET /api/hr` can use the signed `hr.listApplicants` capability behind `GO_HR_APPLICANT_READS=1`. The flag defaults off, and unavailable or malformed Go results fail closed without querying the TypeScript executor.
- **Go routine authored-document reads.** With the Go routine runner enabled, routines can list authored documents through the governed `documents.listDocs` capability using `documents.read`, preserving organization scope, document metadata, version counts, and session-linked system audit history.
- **Go routine document version reads.** With the Go routine runner enabled, routines can list authored document version history through the governed `documents.listDocVersions` capability using `documents.read`, preserving ascending version order, nullable notes and authors, the `workmate` agent label, millisecond timestamps, organization scope, and session-linked system audit history.
- **Go routine document version details.** With the Go routine runner enabled, routines can read one authored document version through the governed `documents.getDocVersion` capability using `documents.read`, preserving content, HTML, nullable notes, millisecond timestamps, organization scope, and session-linked system audit history.
- **Go routine inventory locations.** Routines can list organization-scoped stock location codes and names through the governed `inventory.listLocations` capability using `inventory.read`, with results ordered by code and a session-linked system audit event.
- **Go routine quote reads.** Go routines can list organization-scoped customer quotes through the governed `accounting.listQuotes` capability using `accounting.read`, with the legacy status filter, newest-first ordering, nullable invoice and expiry fields, and session-linked system audit history.
- **Opt-in Go recurring-template reads.** `GET /api/recurring` can dispatch through signed Go `accounting.listRecurringTemplates` behind `GO_ACCOUNTING_RECURRING_READS=1`. The flag defaults off; the response is strictly validated, and unavailable or malformed Go results fail closed without a TypeScript retry.
- **Opt-in Go cash forecast reads.** The `cashForecast` action on `POST /api/accounting` can use signed Go `accounting.cashForecast` behind `GO_ACCOUNTING_CASH_FORECAST_READS=1`. The flag defaults off; forecast weeks and integer minor-unit fields are validated, explicitly null saved assumptions are rejected while missing fields use TypeScript defaults, and unavailable or malformed Go results fail closed without a TypeScript retry.
- **Opt-in Go purchasing price history reads.** `GET /api/purchasing` can dispatch `purchasing.priceHistory` through signed Go behind `GO_PURCHASING_PRICE_HISTORY_READS=1`. The flag defaults off; price rows retain the existing response shape, and unavailable or malformed Go results fail closed.
- **Go routine customer timelines.** Go routines can read a customer timeline through governed `crm.customerTimeline` using `crm.read`, with the legacy per-activity limit and reverse-chronological entries. The database-backed proof checks organization scope and the session-linked system audit event.
- **Opt-in Go inventory barcode lookup.** The `lookupByBarcode` action on `POST /api/inventory` can use signed Go `inventory.lookupByBarcode` reads behind `GO_INVENTORY_BARCODE_LOOKUP_READS=1`. The flag defaults off; the legacy response envelope and nullable item result are preserved, and unavailable or malformed Go responses fail closed without a TypeScript retry.
- **Opt-in Go customer statement reads.** The `customerStatement` action on `POST /api/accounting` can use the signed Go `accounting.customerStatement` capability behind `GO_ACCOUNTING_CUSTOMER_STATEMENT_READS=1`. The flag defaults off; statement rows and currency balances are validated and preserved, and unavailable or malformed Go responses fail closed without a TypeScript retry.
- **Fixed Go organization settings validation parity.** Inventory module settings now trim and validate configured defaults like the TypeScript schema, unknown keys are stripped, JSON `null` is rejected, and omitted approval categories persist as an empty array.
- **Fixed Go stock report average cost parity.** Go now divides the ledger valuation by the same projected on-hand quantity displayed in the report, matching the TypeScript report when the stock projection and movement replay differ.
- **Opt-in Go routine scheduler.** `GO_ROUTINE_SCHEDULER=1` moves due routine discovery and enqueue to Go with globally ordered bounded candidates, tenant-scoped row locking, and duplicate-safe occurrence/job creation. The TypeScript worker skips only routine scheduling under the same flag. Go routine claiming and execution remain separately default-off behind `GO_ROUTINE_AGENT_RUNNER=1`; when only scheduling is enabled, keep the TypeScript worker running to consume routine jobs.
- **Preserved routine credential behavior.** When an organization has stored AI settings but no stored provider key, Go routine execution no longer falls back to a process-wide provider key.
- **Default-off Go routine execution.** With `GO_ROUTINE_AGENT_RUNNER=1`, the Go jobs worker can execute scheduled and manual `routines.executeRoutine` jobs. It rechecks disabled scheduled routines, creates replayable sessions, invokes the workspace-configured OpenAI-compatible provider, routes schema-described CRM customer, invoice, inventory stock report, and support read tools through the governed Go executor, and finalizes notifications and scheduled occurrences. Broader routine tool parity remains open.
- **Go routine CRM task-list tool.** Go routine agents can call `crm_listTasks` through governed `crm.listTasks` execution with the optional `openOnly` filter. The tool uses `crm.read` and produces a system audit event linked to the routine session; broader routine tool parity remains open.
- **Go routine cash-flow report tool.** Go routine agents can call `accounting_cashFlow` through governed `accounting.cashFlow` execution, optionally selecting cash account codes and otherwise using the legacy `1000` default. The routine integration proof verifies the tied local cash total and tenant isolation.
- **Go routine customer statement tool.** Go routine agents can call `accounting_customerStatement` through governed `accounting.customerStatement` execution. Its database-backed routine proof checks the selected customer's invoice balance and excludes other customer and tenant data.
- **Go routine receivables aging tool.** Go routine agents can call `accounting_arAging` through governed `accounting.arAging` execution. The routine proof verifies the aging totals include only the organization's outstanding invoices.
- **Go routine AP aging tool.** Go routine agents can call `purchasing_apAging` through governed `purchasing.apAging` execution. Its database-backed proof checks the local bill total and excludes foreign tenant balances.
- **Go routine HR, CRM view, budget, lot, reservation, and receipt tools.** Go routine agents can call `hr_listEmployees`, `hr_leaveBalance`, `crm_listCustomerViews`, `accounting_listBudgetScenarios`, `inventory_listLots`, `inventory_listReservations`, and `purchasing_listReceipts` through the same governed executor. The database-backed routine proof checks tenant isolation for each, that a system actor sees only shared saved customer views, that a cross-tenant employee leave balance is refused rather than returned empty, and that accepted and remaining purchase-order line totals exclude foreign receipts.
- **Opt-in Go period-close readiness reads.** `GET /api/accounting/close` can dispatch `accounting.periodCloseWorkbench` through the signed Go bridge behind `GO_ACCOUNTING_PERIOD_CLOSE_WRITES=1`. The default remains TypeScript; period, task, blocker, and FX fields are validated, and unavailable or malformed Go responses fail closed.
- **Fixed accounting report input parity.** Go's `accounting.reportCurrencyMetadata` parser now accepts and strips unknown object keys, matching the TypeScript Zod contract.
- **Vite CRM customer bulk updates.** Select visible customer records to assign an owner and add a tag through the existing governed profile API, retaining its approval-pending behavior.
- **Vite CRM follow-up task filters.** Task views now separate work due today, overdue, unassigned, and all open tasks, with counts and an option to include completed work.
- **Vite CRM selected customer export.** Export selected customer profiles as CSV with the legacy columns and spreadsheet formula protection.
- **Fixed Go read parity for supplier metrics and support conversations.** Void purchase orders no longer affect supplier performance, and support conversation lists use the conversation creation time when a thread has no messages.
- **Opt-in Go authored-document version reads.** Version history and single-version content reads on `GET /api/docs/:id` can use signed Go capabilities behind `GO_DOCUMENTS_VERSION_READS=1`. The flag defaults off, preserves the legacy response projection, and fails closed when Go is unavailable or returns invalid data.
- **Opt-in Go POS shift-summary reads.** The `shiftSummary` action on `/api/pos` can use the signed `pos.shiftSummary` capability behind `GO_POS_SHIFT_SUMMARY_READS=1`. The flag defaults off, the summary response is validated and preserved, and unavailable or malformed Go responses fail closed without a TypeScript retry.
- **Opt-in Go payment-run reads.** `GET /api/purchasing/payment-runs` can use the signed Go `purchasing.listPaymentRuns` capability behind `GO_PURCHASING_PAYMENT_RUN_READS=1`. The flag defaults off; run state, timestamps, journal references, and bill-level remittance fields are validated and preserved, and unavailable or malformed Go results fail closed.
- **Opt-in Go inventory transfer reads.** The transfer list on `GET /api/inventory` can use signed Go `inventory.listTransfers` reads behind `GO_INVENTORY_TRANSFER_READS=1`. The flag defaults off; transfer routes, notes, the 50-row limit, and line quantities are preserved, and unavailable or malformed Go results fail closed.
- **Opt-in Go inventory lot reads.** The lot list on `GET /api/inventory` can use signed Go `inventory.listLots` reads behind `GO_INVENTORY_LOTS_READS=1`. The flag defaults off; the 200-row newest-first order, SKU, lot code, nullable expiration timestamp, and response fields are preserved, and unavailable or malformed Go results fail closed.
- **Opt-in Go inventory reservation reads.** The reservation list on `GET /api/inventory` can use signed Go `inventory.listReservations` reads behind `GO_INVENTORY_RESERVATIONS_READS=1`. The flag defaults off; all statuses, the 100-row newest-first order, and complete reservation response fields are preserved, and unavailable or malformed Go results fail closed.
- **Opt-in Go inventory cycle-count reads.** The cycle-count list on `GET /api/inventory` can use signed Go `inventory.listCycleCounts` reads behind `GO_INVENTORY_CYCLE_COUNTS_READS=1`. The flag defaults off; the 20-row newest-first order and full cycle-count header and line projection are preserved, and unavailable or malformed Go results fail closed.
- **Opt-in Go inventory location reads.** The location list on `GET /api/inventory` can use the signed Go `inventory.listLocationRecords` capability behind `GO_INVENTORY_LOCATIONS_READS=1`. The flag defaults off; full row fields and code ordering come from Go, the routine tool keeps its existing shape, and unavailable or malformed Go results fail closed without a duplicate TypeScript location query.
- **Opt-in Go accounts payable aging.** The `apAging` report in `GET /api/purchasing` can use the signed Go `purchasing.apAging` capability behind `GO_PURCHASING_AP_AGING_READS=1`. The flag defaults off; outstanding balance filters, bill-date bucket boundaries, workspace currency, and the response fields are preserved, and unavailable or malformed Go results fail closed.

- **Opt-in Go purchasing workflow reads.** Purchase requests and RFQs in `GET /api/purchasing` can use the signed `purchasing.listPurchaseWorkflow` capability behind `GO_PURCHASING_WORKFLOW_READS=1`. The flag defaults off; decision reasons, vendor names, quote notes, ordering, timestamps, and the aggregate response stay stable, and unavailable or malformed Go responses fail closed.
- **Opt-in Go accounting invoice reads.** The invoice list in `GET /api/accounting` can use the signed Go `accounting.listInvoices` capability behind `GO_ACCOUNTING_INVOICE_READS=1`. The flag defaults off; response fields are validated and preserved, and unavailable or malformed Go results fail closed without a TypeScript retry.
- **Opt-in Go CRM saved-view reads.** Saved customer views can use a signed Go reader behind `GO_CRM_VIEW_READS=1`. The flag defaults off; shared and current-user private views retain their organization scope, ordering, and response fields, and unavailable or invalid Go responses fail closed.
- **Opt-in Go CRM saved-view writes.** Saving customer views can use the signed Go capability executor behind `GO_CRM_VIEW_WRITES=1`. The flag defaults off; human session checks, private-view ownership, approval handling, audit receipts, snapshot restore, and the legacy response contract are preserved. Unavailable or invalid Go outcomes fail closed without a TypeScript retry.

### Added
- **Go IAM org settings and purchasing supplier analytics.** Module switchboard (set and restore, protected spine unioned in), per-module configuration, the blanket autonomy policy, print branding, and the supplier performance, price history, and statement reads are ported to the signed Go capability executor and jobs worker under `iam.admin` and `purchasing.read`. They are reachable through governed agent and worker dispatch; the settings routes keep their TypeScript handlers for now, so no new flags ship with this slice.
- **Go manufacturing, marketing, HR openings, and reminder parity.** The manufacturing BOM and work-order surface (definition, explosion, costing, feasibility, production, reversal, lot traceability), the marketing campaign surface (segments, campaigns, opt-out-honoring sends, delivery analytics), HR job openings, and payment reminder building are ported to the signed Go capability executor and jobs worker. Job opening writes (`GO_HR_OPENINGS_WRITE=1`) and reminder building (`GO_ACCOUNTING_REMINDERS_READS=1`) are bridged behind default-off flags; manufacturing and marketing are reachable through governed agent and worker dispatch since no public route serves them today. Existing handlers keep every other action, and uncertain writes fail closed without retrying through TypeScript.
- **Opt-in Go supplier AP aging read.** The purchasing AP aging report can be served by the signed Go capability executor behind `GO_PURCHASING_AP_AGING_READS=1`. The flag defaults off, all other purchasing actions keep their current handlers, the aging shape stays stable, and an unavailable Go service fails closed without retrying through TypeScript.
- **Vite accounting and purchasing previews.** Added read-only invoice and supplier payment-run pages with validated same-origin APIs, currency-aware amounts, accessible loading and error states, and links to the full legacy workspaces.
- **Vite period-close readiness preview.** Added a read-only Accounting page with period selection, validated close tasks and blockers, reconciliation and FX exposure status, and accessible loading, empty, disabled, and error states. Checklist changes, FX revaluation, close, and reopen remain in the full workspace.
- **Vite purchase receipt history preview.** Added a read-only React page to choose a purchase order and review receipt dates, accepted, rejected, returned, and outstanding quantities. It validates the existing same-origin Purchasing APIs, preserves currency and thousandth-unit formatting, provides accessible loading, empty, and error states, and links receiving actions to the full workspace.
- **Vite inventory and POS summaries.** Added read-only React previews for inventory stock levels, reorder needs, and POS shift summaries. Both use validated same-origin APIs, preserve workspace currency formatting, and link to the full legacy workspaces for actions.
- **Vite inventory lot preview.** The read-only inventory page now shows SKU, lot code, and expiry date from the existing inventory API. A current-balance column appears only when the API supplies lot balances; lot operations remain in the full workspace.
- **Vite inventory location preview.** The read-only inventory page now shows stock location codes and names from the existing inventory API. Location changes remain in the full workspace.
- **Vite cycle-count preview.** The read-only inventory page now shows cycle-count status, location, date, progress, and expected, counted, and variance quantities from the existing inventory API. Count creation and posting remain in the full workspace.
- **Vite inventory transfer preview.** The read-only inventory page now shows transfer status, source and destination, notes, and requested and confirmed quantities from the existing inventory API. Transfer actions remain in the full workspace.
- **Vite accounts payable aging preview.** Added an authenticated read-only Purchasing page with the outstanding total, age-band amounts, proportional aging meter, and accessible loading, disabled, and error states. Bill review and payment remain in the full workspace.
- **Vite sales order filters.** The Sales orders preview now filters by draft, confirmed, delivered, and cancelled status, while retaining customer/order search and the `/` search shortcut.
- **Vite sales orders preview.** Added a React sales orders page with same-origin API loading, validated order data, search, totals, backorder labels, and recoverable loading and error states. Sales mutations remain on the current route owner.
- **Opt-in Go authored-document reads.** The authored-document list in `GET /api/docs` can use signed Go `documents.listDocs` reads behind `GO_DOCUMENTS_LIST_READS=1`. The flag defaults off, templates stay on the legacy executor, the combined response is preserved, and unavailable or malformed Go results fail closed.
- **Opt-in Go ingested-document reads.** `GET /api/documents` list and detail reads can use the signed Go `documents.listIngestedDocuments` capability behind `GO_DOCUMENT_INGESTED_READS=1`. The flag defaults off, list and vendor data plus detail suggestions stay compatible, `preview=1` omits suggestions, raw upload/text columns remain excluded, and unavailable or malformed Go responses fail closed.
- **Opt-in Go inventory stock report reads.** The main inventory report and reorder alerts can use signed Go `inventory.stockReport` reads behind `GO_INVENTORY_STOCK_REPORT_READS=1`. The flag defaults off, existing report fields stay stable, and unavailable or malformed Go results fail closed.
- **Opt-in Go inventory valuation posting.** The `postValuationSummary` action on `POST /api/inventory` can use `inventory.postValuationSummary` behind `GO_INVENTORY_VALUATION_SUMMARY_WRITE=1`. The flag defaults off; memo defaults, approval responses, no-op results, and valuation fields stay stable, and unavailable or malformed Go results fail closed.
- **Opt-in Go sales order reads.** `GET /api/sales` can use the signed Go `sales.listOrders` capability behind `GO_SALES_LIST_ORDERS_READS=1`. The flag defaults off; status filtering and the `{ orders }` response stay stable, and unavailable or malformed Go responses fail closed.
- **Opt-in Go payment reversals.** `accounting.reversePayment` can use the signed Go capability bridge behind `GO_ACCOUNTING_REVERSE_PAYMENT_WRITE=1`. The flag defaults off; approval and response fields stay stable, and uncertain outcomes fail closed without a TypeScript retry.
- **Opt-in Go FX rate recording.** `accounting.recordFxRate` can use the signed Go capability bridge behind `GO_ACCOUNTING_FX_RATE_WRITE=1`. The flag defaults off; input normalization and approval responses stay stable, and uncertain outcomes fail closed without a TypeScript retry.
- **Opt-in Go FX revaluation.** The month-end `revalue` action on `POST /api/accounting/close` can use `accounting.revalueForeignReceivables` behind `GO_ACCOUNTING_FX_REVALUATION_WRITE=1`. The flag defaults off; `accounting.post` checks, approval responses, and all revaluation fields stay stable, and unavailable or malformed Go results fail closed.
- **Opt-in Go supplier payment reversals.** `purchasing.reverseVendorPayment` can use the signed Go capability bridge behind `GO_PURCHASING_REVERSE_VENDOR_PAYMENT_WRITE=1`. The flag defaults off; approval and error responses stay stable, and uncertain outcomes fail closed without a TypeScript retry.
- **Opt-in Go payment recording.** `accounting.recordPayment` can use the signed Go capability bridge behind `GO_ACCOUNTING_RECORD_PAYMENT_WRITE=1`. The flag defaults off; approval and validation responses remain stable, and uncertain outcomes fail closed without a TypeScript retry.
- **Opt-in Go supplier bill credits.** `purchasing.billCreditNote` can use the signed Go capability bridge behind `GO_PURCHASING_BILL_CREDIT_WRITES=1`. The flag defaults off; approval and validation responses remain stable, and uncertain outcomes fail closed without a TypeScript retry.
- **Opt-in Go CRM timeline reads.** Customer timelines can use the signed Go reader behind `GO_CRM_TIMELINE_READS=1`. The flag defaults off; task reads stay on their current path, timeline entries are strictly validated, and unavailable or malformed Go results fail closed.
- **Opt-in Go quote reads.** `GET /api/quotes` can use the signed Go `accounting.listQuotes` capability behind `GO_ACCOUNTING_QUOTES_READS=1`. The flag defaults off, status filtering and response fields stay stable, and unavailable or malformed Go results fail closed.
- **Opt-in Go inventory item history.** `GET /api/inventory?sku=...` can read item movements through the signed Go capability behind `GO_INVENTORY_ITEM_HISTORY_READS=1`. The flag defaults off, preserves the movement response and missing-item behavior, and fails closed for unavailable or malformed Go results.
- **Opt-in Go purchase receipt reads.** The purchasing `receiptDetail` action can use the signed Go `purchasing.listReceipts` capability behind `GO_PURCHASING_RECEIPT_READS=1`. The flag defaults off, preserves receipt and order-line response fields, and fails closed when Go is unavailable.
- **Opt-in Go purchase order closure.** The `closePurchaseOrder` action can use the signed Go capability behind `GO_PURCHASING_PO_CLOSE_WRITES=1`. The flag defaults off, preserves approval and response behavior, and fails closed without a TypeScript retry when the Go outcome is uncertain.
- **Opt-in Go accounting report reads.** The report capabilities and dedicated signed `accounting.reportCurrencyMetadata` read consumed by `GET /api/reports` can use the Go executor behind `GO_ACCOUNTING_REPORTS_READ=1`. The flag defaults off; base and unsupported currency metadata, report fields, and optional null behavior stay stable, and unavailable or malformed Go responses fail closed.
- **Go Wave 6 accounting, inventory, and purchasing capabilities.** Added governed Go execution and worker support for accounting reports and FX revaluation, inventory valuation and read models, and purchasing bill credits, purchase order closure, and receipt listing. Public route ownership remains unchanged while opt-in bridges and parity proofs are completed.
- **Human approval for automated system money actions.** System jobs now use the configured money thresholds, and above-threshold or unknown amounts require a matching executing human approval. The legacy TypeScript and Go executors reject system jobs that try to create or reuse an unverified approval.
- **Opt-in Go tax returns, HR leave and time, and HR payroll and applicants.** Sales tax return filing (`GO_ACCOUNTING_TAX_RETURNS_WRITE`), leave requests, decisions, cancellation, and clock in/out (`GO_HR_LEAVE_TIME_WRITES`), and payroll run creation, execution, voiding plus the applicant pipeline (`GO_HR_PAYROLL_APPLICANT_WRITES`) can use the signed Go capability executor and jobs worker. The three flags default off, existing handlers keep every other action, tax master writes ride the executor and worker without a route flag, public response shapes stay stable, and uncertain writes fail closed without retrying through TypeScript.
- **Go Wave 4 capability families.** Budget scenarios, period close, inventory imports and reservations, and supplier payment runs now have Go parsers, tenant-scoped governed execution, approval replay, audit receipts, and worker claim support. Existing API actions can opt into signed Go dispatch with the new `GO_ACCOUNTING_BUDGET_WRITES`, `GO_ACCOUNTING_PERIOD_CLOSE_WRITES`, `GO_INVENTORY_IMPORT_WRITES`, `GO_INVENTORY_RESERVATION_WRITES`, and `GO_PURCHASING_PAYMENT_RUN_WRITES` flags. All default off, response contracts stay stable, and uncertain writes fail closed.
- **Opt-in Go purchase returns.** `purchasing.returnGoods` allocates returns to received receipt lines, rejects returned or unavailable stock, preserves legacy no-receipt history, and records audited stock movements. The `/api/purchasing` action and jobs worker use the governed Go executor behind `GO_PURCHASING_RETURN_WRITES=1`, which defaults off.
- **Opt-in Go credit notes, entry reversals, banking, purchase requests, and item master.** Credit notes and journal entry reversals (`GO_ACCOUNTING_INVOICE_OPS_WRITE`), bank account, feed, matching, exclusion, and deletion writes (`GO_BANKING_WRITES`), the purchase request through RFQ award workflow (`GO_PURCHASING_REQUEST_WRITES`), and inventory item and location master writes (`GO_INVENTORY_ITEM_WRITES`) can use the signed Go capability executor and jobs worker. All four flags default off, existing handlers keep every other action, public response shapes stay stable, and uncertain writes fail closed without retrying through TypeScript.
- **Opt-in Go purchase order receiving.** `receiveGoods` can use the signed Go capability executor and jobs worker behind `GO_PURCHASING_RECEIPT_WRITES=1`. The flag defaults off; reads and other purchasing actions keep their current handlers. Duplicate lines, accepted and rejected quantities, over-receipt authority, stock effects, three-way matching, and fail-closed uncertain writes are preserved.
- **Opt-in Go inventory cycle counts.** Starting, recording, posting, and cancelling cycle counts can use the signed Go capability executor and jobs worker behind `GO_INVENTORY_CYCLE_COUNTS=1`. The flag defaults off; the existing `startCycleCount` alias and unrelated inventory actions keep their current handlers. Movement drift checks, location snapshots, audit and approval behavior, and fail-closed uncertain writes are preserved.
- **Generated Go policy API contract.** Added a versioned OpenAPI contract for the signed Go policy read, with generated Go and TypeScript models and a drift check. Existing paths, runtime validation, and response behavior remain in place.
- **Opt-in Go purchase order creation.** The purchasing route can create purchase orders through the signed Go capability executor and worker behind `GO_PURCHASING_PO_WRITES=1`. The flag defaults off, other purchasing actions keep their existing handlers, and uncertain writes fail closed without TypeScript retry.
- **Opt-in Go expense, purchasing, inventory, and POS capabilities.** Expense claim submission, decisions, and payments; vendor and bill creation and bill payments; stock adjustments and transfer lifecycle actions; and POS session, sale, return, and summary actions now have Go capability and worker paths. Four independent flags default off, public route ownership and existing data remain intact, and uncertain writes fail closed without TypeScript retry.
- **Opt-in Go expense policy updates.** The `setPolicy` action now uses the governed Go capability and worker path when `GO_ACCOUNTING_EXPENSE_WRITES=1`; the flag remains off by default, and the existing upsert, approvals, audit, receipts, and response stay intact.
- **Opt-in Go expense reads.** Expense claims and category limits can use separately governed Go reads behind `GO_ACCOUNTING_EXPENSE_READS=1`; the combined API response stays unchanged, the flag remains off by default, and unavailable Go reads fail closed.
- **Opt-in Go sales order writes.** Sales order creation, confirmation, delivery, and cancellation can use the signed Go capability executor behind `GO_SALES_WRITE=1`. The flag defaults off; order listing and other sales actions keep their existing handlers. Public response shapes stay stable, and uncertain writes fail closed without retrying through TypeScript.
- **Opt-in Go accounting quote writes.** Quote creation, acceptance, decline, and expiry sweeps can use the signed Go capability executor behind `GO_ACCOUNTING_QUOTES_WRITE=1`. The flag defaults off; the dedicated quotes route and other accounting actions keep their existing handlers. Public response shapes stay stable, and uncertain writes fail closed without retrying through TypeScript.
- **Opt-in Go recurring invoice template writes.** Recurring template creation, pausing, and resumption can use the signed Go capability executor behind `GO_ACCOUNTING_RECURRING_WRITE=1`. The flag defaults off; template listing and other accounting actions keep their existing handlers. Public response shapes stay stable, and uncertain writes fail closed without retrying through TypeScript.
- **Opt-in Go HR employee writes.** Employee hiring, deactivation, and structure updates can use the signed Go capability executor behind `GO_HR_EMPLOYEE_WRITES=1`. The flag defaults off; leave, payroll, and other HR actions keep their existing handlers. Public response shapes stay stable, and uncertain writes fail closed without retrying through TypeScript.
- **Opt-in Go CRM task writes.** CRM task creation, completion, and detail updates can use the signed Go capability executor behind `GO_CRM_TASK_WRITES=1`. The flag defaults off; CRM reads, follow-up drafting, and other writes keep their existing handlers. Public response shapes stay stable, and uncertain writes fail closed without retrying through TypeScript.
- **Opt-in Go customer imports.** Customer import and undo can use the existing governed Go CRM capabilities behind `GO_CRM_IMPORT_WRITES=1`. The flag defaults off; product imports and other CRM actions keep their current handlers. Row validation, duplicate results, partial errors, approval responses, and fail-closed uncertain writes are preserved.
- **Opt-in Go customer writes.** Customer creation, deactivation, merge, merge undo, and profile updates can use the existing governed Go CRM capabilities behind `GO_CRM_CUSTOMER_WRITES=1`. The flag defaults off; customer reads stay on the existing handler, approval responses keep their shape, and uncertain outcomes fail closed without retrying through TypeScript.
- **Opt-in Go CRM deal lifecycle writes.** Deal creation, stage changes, and lead conversion can use the signed Go capability executor behind `GO_CRM_DEAL_WRITES=1`. The flag defaults off; CRM reads and other writes keep their existing handlers. Public response shapes remain stable, and uncertain writes fail closed without retrying through TypeScript.
- **Opt-in Go CRM deal reads.** The deals list can use the signed Go `crm.listDeals` capability behind `GO_CRM_DEAL_READS=1`. The flag defaults off; the org-scoped 200-row response fields and timestamps are preserved, and unavailable or invalid Go responses fail closed.
- **Opt-in Go invoice creation.** `POST /api/accounting` can dispatch only `action: "createInvoice"` to the signed Go capability executor behind `GO_ACCOUNTING_CREATE_INVOICE=1`. The flag defaults off; all other accounting actions and GET remain legacy-owned. Pending approval responses keep the existing public shape, and uncertain writes fail closed without a TypeScript retry.
- **Go API migration foundation.** Added a pinned Go service, graceful HTTP server startup, a transaction-local tenant RLS helper, and Go implementations of the existing health response and a read-only governance policy query. The policy shadow uses a short-lived signed session assertion; the Go policy GET is an explicit opt-in while the existing response remains the default. CI now runs Go tests and vet; no production route has changed owners.
- **Go database isolation hardening.** Provisioning now repairs the dedicated `chaste_app` role and its password, clears role memberships, preserves database TLS options, and is an explicit setup command. Go requires and checks that role at startup; policy responses are not cacheable, and development shadow requests require loopback HTTP or HTTPS.
- **Vite React migration shell.** Added a parallel React 19 and Vite workspace app with strict TypeScript, Zod validation at the Go health boundary, and a development proxy to the Go API. Existing pages and production routing remain on their current owner while route parity is built.
- **Vite sign-in and registration flow.** Ported the existing Better Auth email sign-in and sign-up experience into the Vite client while keeping Better Auth and its session cookies on the legacy server. The development auth allowlist accepts the local Vite origin only in development.
- **Vite team and roles preview.** Added the team management screen with validated API calls for member and role reads, invitations, role assignment, and permission editing. It uses the existing `/api/team` route, which remains legacy-owned by default.
- **Vite CRM preview.** Added a React workspace for customer, deal, task, saved-view, profile, merge, lead conversion, follow-up draft, and CSV import workflows using the existing same-origin APIs. Direct `/crm` access uses the existing Better Auth session check before CRM APIs load. The legacy CRM remains the route owner until runtime and parity proofs pass.
- **Opt-in Go team and roles API.** Added Go parity for member and role reads, invitations, role assignment, and permission editing behind `GO_IAM_TEAM=1`. The full permission catalog and existing route responses are preserved, uncertain writes fail closed, and the public route remains legacy-owned by default.
- **Opt-in Go approvals inbox read.** Pending approvals and recent decision history can use a signed Go read bridge behind `GO_APPROVALS_READ=1`. The full TypeScript capability registry continues to govern row visibility, and Go rechecks session, membership, live permissions, ordering, limits, and org-scoped document titles. The flag defaults off; decision writes are unchanged.
- **Receivables aging filters.** Accounting aging cards now filter outstanding invoices by the displayed bands, return focus to the invoice list, and cap long lists at 30 rows until expanded.
- **Migration ownership inventory.** Checked in an API-method and page ownership manifest, with a CI check that requires the inventory to stay aligned with the current route source.
- **Runtime capability census.** Generated a manifest from the live capability registry with permissions, risk classes, inverses, and JSON Schemas; CI checks it for drift.
- **Database schema census.** Generated a source-linked manifest of every exported Drizzle table and added a CI drift check, giving the migration an explicit data-preservation inventory.
- **Policy read wire parity.** Go-backed policy reads preserve the legacy response for JSONB arrays, including arrays with mixed element types.
- **Go ledger read slice.** Added an opt-in, signed-assertion Go reader for existing audit rows, with organization-scoped PostgreSQL access, response validation, and development shadow comparison. The public route and all writes remain on the legacy owner.
- **Vite organization switching.** The React/Vite shell now lists the signed-in user's organizations and switches the active organization through the existing `/api/org` endpoint. The server remains responsible for membership checks and the HttpOnly active-org cookie; API ownership remains legacy.
- **Opt-in Go organization switching.** Added an independently signed Go membership check and active-org cookie writer behind `GO_ORG_SWITCH=1`; the legacy handler remains the default and production route owner.
- **Internal Go CRM capability slice.** The transactional Go executor now covers customer create/deactivate, merge and restore, import/undo/restore, and profile update/restore/reapply, with verified-session and grant rechecks, tenant RLS, approval decisions, existing ledger continuation, receipts, and same-intent replay. Merge restore preserves the current caller-snapshot contract. These Go operations remain internal; public customer/import routes and agent-tool dispatch remain legacy-owned.
- **Go-backed slice demo proof.** `pnpm demo:slice` now exercises Go capability, approval, and trial-balance APIs. Public business routes remain legacy-owned while the broader migration continues.
- **Internal Go accounting capability slice.** Go now records dated FX rates, snapshots rates on invoices, posts base and foreign settlement entries with realized gain or loss, and reverses both currencies through the same audited capability path. Human approval replay and exact-once payment decisions have DB-backed parity coverage; public accounting routes remain legacy-owned.
- **Internal Go dashboard read model.** Added tenant-scoped Go aggregates and parity tests for dashboard money, working capital, pipeline, operations, six-month trend, and ledger activity. Report-read outcomes are explicit inputs so inaccessible or failed financial reports keep the legacy zero/null defaults. Signals and the public dashboard route remain legacy-owned.
- **Vite home dashboard preview.** Added a session-checked React home with validated dashboard, setup, work queue, and brief responses; active-organization and display-currency handling; receipt reminders; and the existing workmate prompt actions. Unported pages use the legacy development fallback. Production page and API ownership remain unchanged while signed-in runtime parity is completed.
- **Vite approvals preview.** Added the approvals queue and recent decision history to the React client, using the existing governed approvals API by default and redacting credential-shaped fields from payload previews. Approval POST decisions can opt into the signed Go service with `GO_APPROVAL_DECISION=1`; queue reads and production route ownership remain on the legacy application.
- **Vite event ledger preview.** Added a read-only audit ledger with kind/capability/actor filters, full hash-chain disclosure, and loading, error, and empty states. It uses the existing API and authentication shell; route ownership remains unchanged.
- **Go CRM customer timeline read.** Added the internal `crm.customerTimeline` reader with legacy event summaries, source ordering, date formatting, limits, permission checks, and tenant isolation. The public CRM route remains legacy-owned.
- **Go webhook outbox worker.** Added a standalone webhook dispatcher with a dedicated least-privilege database role, tenant-scoped payload access, stable provider idempotency, retry and lease fencing, and scoped reconciliation. The existing TypeScript worker remains the default owner until cutover parity is complete.
- **Vite agent sessions preview.** Added a React sessions view backed by the existing session, event, replay, durable-run, and metrics APIs. It preserves selection and event order; the legacy page and API routes retain ownership.
- **Go CRM read parity.** Added tenant-scoped Go readers for CRM timeline and task GET modes with the existing response shapes. The signed bridge is opt-in; other CRM modes and public route ownership remain legacy.
- **Go capability jobs worker.** Added a standalone worker over existing durable job rows, receipts, approvals, audit events, and run transitions, with a dedicated restricted database role and an explicit executor allowlist. The TypeScript worker remains the sole default queue owner.
- **Vite Projects preview.** Added the existing Projects board to the authenticated React shell, including module-switchboard state, task controls, archive confirmation, approval notices, and organization-scoped reloads. It continues to use the legacy business API.
- **Vite Analytics preview.** Added the governed dataset report composer to the authenticated React shell, with permission-filtered discovery, previews, chart configuration, exact result tables, and downloadable HTML. The API stays legacy-owned; the Vite development proxy uses the existing `/api/analytics` handler.
- **Projects team lookup proxy.** The Vite preview now proxies the existing `/api/team` endpoint so task assignee names can load through the same origin.
- **Internal Go Projects write capabilities.** Added Go implementations for project creation and archival, and task creation, movement, and assignment. Database-backed parity covers module and permission checks, actor attribution, approvals, tenant isolation, audit rollback, and same-intent receipt replay.
- **Opt-in Go Projects writes.** `POST /api/projects` can dispatch through the signed Go capability bridge when `GO_PROJECTS_WRITE=1`; it preserves the legacy response shapes and fails closed on unknown outcomes. The flag defaults off.
- **Opt-in Go Projects reads.** The signed Go bridge can serve project list and board GETs with `GO_PROJECTS_READ=1`. The collection keeps its no-audit behavior, board reads keep the capability audit, and development shadow comparison is limited to the collection read.
- **Go metrics read parity.** Added a tenant-scoped reader over the newest 200 agent sessions and a signed HTTP adapter. `/api/metrics` remains legacy-owned unless `GO_METRICS_READ=1` is enabled.
- **Messages search and collaboration.** Conversations can be searched by channel name or latest preview, while a separate history search finds older messages and opens their surrounding thread. Messages now support per-member read positions and unread counts, private file attachments, emoji reactions, threaded replies, pinned messages, member-name lookup, and online or typing status refreshed in the background.
- **A more comfortable Messages workspace.** The conversation list has Active and Archived filters, clearer loading and retry states, a guided first-channel empty state, and an explicit mobile path back to the list. Drafts save in the browser per conversation, the composer grows with its text and accepts attachments, and messages group by sender and day for easier scanning.
- **Emoji in the message composer.** Choose from a compact emoji picker and insert at the current cursor position while writing.
- **Focused built-in template catalog.** Documents now present one canonical built-in template per type. Invoice, quotation, receipt, and delivery note use the supplied Chaste paper layouts, with editable document numbers, date fields, dynamic line items, calculated amounts, and matching preview/print output.
- **Business paper template system.** The 24 built-in document templates were redesigned around one professional anatomy: branded letterhead with a document title block, a ledger rule, party blocks, ruled data tables with right-aligned money columns, a compact totals block, and composed signature lines. One typesetting system now drives gallery thumbnails, live previews, the editor paper, and print/PDF output, and documents drawn freehand in the editor pick up the same treatment. Design groups dress the same anatomy per family: financial documents (quotations, invoices, receipts, vouchers, purchase orders) print a large ink title with dark ruled headers and a banded grand total; goods paper keeps light rules under a large title; people paper keeps the modest gold title. Fonts stay professional throughout.
- **The studio form is the template's editor.** Using a template no longer opens the word editor: the studio saves the filled paper under its file name in place, keeps the form open with a saved status, offers Download PDF from the live preview at any point, and offers Save a copy after further edits.
- **Template gallery categorization.** Category chips grouped under Financial, Operations, and People labels (plus Other) with live counts filter the gallery; each card leads with a real miniature of the template paper, its name, and a spec chip, with descriptions moved into the preview dialog.
- **Mobile template studio tabs.** The template creation studio switches between Fields and Preview panes with a segmented tab bar on small screens instead of stacking both.
- **Quick actions and document organization.** Every module frame now exposes a keyboard-friendly Quick actions menu for the most common work, while Documents adds folder paths, folder-aware libraries, and upload/create entry points across the workspace.
- **Business document studio.** The editor now opens with page-like white paper, and the gallery includes three polished starting templates each for quotations, receipts, sales invoices, purchase orders, vouchers, delivery notes, employment contracts, and employment agreements.
- **Template previews and guided creation.** Template cards now show a useful paper preview with separate View template and Use template actions. The creation studio supports live field editing, per-field visibility, template switching, searchable business-record pickers, folder placement, and an immediate preview before the document is created.
- **Uploaded document viewer.** Uploaded PDFs and images can be opened inline from the library through an organization-scoped, no-store content endpoint, with a full-file link for formats that need the system viewer.
- **Accounting makes currency and recovery states clear.** Cash is directly reachable from the accounting section rail. Accounting reports and balances identify base currency, foreign amounts stay grouped by currency, and incomplete API currency metadata is surfaced instead of crashing or formatting money actions in an assumed currency. Bank import uses the selected account's currency, failed cash forecasts can be retried in place, and tax reports require complete currency coverage before filing. Accounting's page title and horizontally scrollable tables are accessible by keyboard, and muted financial labels keep sufficient contrast in dark mode.
- **Accounting calculations respect currency precision.** Invoice totals use exact integer arithmetic and deterministic rounding; foreign exchange conversion accounts for each currency's minor-unit precision, including zero- and three-decimal currencies. Future-dated exchange rates are not used for earlier transactions.
- **POS sales now stay in the organization's accounting currency.** Register invoices, payments, and journal entries use the same base currency, and the sale authorization amount shares the same exact invoice calculation as the posted totals.
- **Sales points to the next useful action.** The overview now prioritizes quotes awaiting a decision, accepted quotes, the open pipeline, and open orders, with direct follow-ups and links to CRM and Accounting. Sales also has a searchable customer directory with quick quote creation, search shortcuts, clearer quote/order builders with live totals, and recovery states when data fails to load.
- **Quote validity is usable from Sales.** Quotes can carry a valid-through date that appears in the list and is enforced when the quote is accepted or expired. Accepting a quote now asks for confirmation before posting its invoice. Order confirmation also explains stock and credit checks, with backorder choice scoped to the individual order.
- **App section navigation is easier to scan on phones.** Common sections appear first in a swipeable horizontal rail, with a pinned direction button to reveal more destinations. Compact quick actions stay in the top bar, keeping the page header clear for Accounting's Ask workmate action, which uses an icon on the narrowest screens.
- **Phone quick links stay on phone sized screens.** The fixed Home, Documents, Messages, and Settings bar hides from tablet widths upward, and page content reclaims its bottom space there.
- **Small supporting text is easier to read.** Sales KPI labels and the workspace clock meet stronger contrast, and the floating workmate composer is exposed as a named accessibility region.
- **Saved budgets connect planning to actuals.** Versioned monthly scenarios compare posted income and expense with plan and remaining unbilled purchase commitments. Collection delays, spend uplift, and cash assumptions can be passed into the 13-week forecast; commitment totals are net of tax until a bill is coded.
- **Month-end has a guided close workbench.** Bank reconciliation, foreign receivable revaluation, and four explicit journal, receivables, payables, and tax reviews gate close. Closed-period history and approval-gated reopening give accountants a clear correction path.
- **Tax returns preserve review and filing evidence.** Jurisdiction profiles and tax codes capture each line's rate and inclusive treatment; return snapshots show the code-level basis, authority references, acknowledgments, amendments, and separate ledger settlement. Authority submission remains a manual portal step until a jurisdiction provider is integrated.
- **Supplier bills can be paid in reviewed batches.** Same-currency bill selection supports partial amounts, drafts, approval-gated consolidated posting, remittance advice, reversal before bank confirmation, and confirmation through statement matching. Bank instruction files are schedules only because supplier bank details are not configured.
- **Documents you write, not just ingest.** New Write tab: rich text
  documents with a full formatting toolbar (headings, lists, tables,
  images), debounced autosave with a Saved indicator, live presence of
  other editors, and soft locks so two people never clobber each other.
  Draft keystrokes live outside the hash-chained ledger on purpose
  (ADR 0056); publishing a version stays governed and append-only.
- **Version history you can trust.** Every publish archives the prior
  content as an immutable, noted version. Compare any two versions side by
  side, and restore an older one without ever deleting: restoration
  snapshots the current content first, so undoing is another restore.
- **Templates with fill-in fields.** Four built-ins (blank note, business
  letter, meeting notes, quote) plus save-your-own: wrap any value in
  double braces and it becomes a form field. The assistant can pre-fill
  fields from what the org has told it, and unfilled fields keep their
  tokens so nothing is silently blank.
- **AI writing assist, review-before-apply.** Select text and improve,
  fix grammar, change tone, shorten, expand or translate it; continue
  drafting from the cursor; ask questions about the document and get
  answers grounded only in what it says. Suggestions never touch the
  document without an explicit Apply. Uses the organization's configured
  model provider.
- **Memory manager.** Settings > AI & automation lists what the workmate
  has learned about the organization (profile facts, SOPs, decisions,
  document knowledge) with search; deleting an entry is governed
  (documents.deleteOrgMemory, destructive-class) so agent-proposed wipes
  wait for a person.
- **Spell and grammar checking in the editor.** Harper runs locally in a
  Web Worker: wavy underlines with suggestions, ignore, and add-to-
  dictionary (kept on the device). Off switch in Settings under writing
  aids.
- **Org-branded invoices and quotes.** Upload a logo, pick an accent
  color, choose classic or modern layout, and set the footer small print;
  any sales order then prints as a clean, branded invoice straight to PDF.
- **.docx export and print-styled PDF** for authored documents.
- **Print branding is governed.** iam.setOrgBranding rides the capability
  pipeline: agent-proposed branding changes wait for a human, and the
  ledger records who changed what.

- **Services are first-class.** Items now carry a kind: goods or service
  (migration 0058). Create services from the product form or quick create
  ("Service (no stock)"); they show a service badge in the catalog, refuse
  stock adjustments, skip reservations and reorder machinery, sell at POS
  without touching stock, and - the long-standing gap - sales orders
  containing them now deliver completely: service lines (by SKU or bare
  descriptions) join the delivery invoice instead of silently never
  invoicing, and mixed orders finally reach "delivered" status.
- **Messages get real CRUD.** Conversations can be renamed, given or stripped
  of the workmate, archived and restored, left, and (channel creators)
  soft-deleted; colleagues can be pulled into channels. Your own messages
  can be edited (with an "edited" marker) and deleted (a tombstone everyone
  sees), all hover-reachable. Twelve governed `messaging.*` capabilities
  now cover the whole lifecycle - the workmate can use the same powers on
  the record - and deleted/archived items stay out of sight while the audit
  trail keeps every original (migration 0057).
- **Module settings, governed end to end.** New Settings > Modules tab: the
  module switchboard moves here next to per-module defaults (inventory's
  default unit label and reorder point are first; they prefill the product
  form immediately). Values are stored per org per module
  (module_settings table, migration 0056), written only through the new
  `iam.setModuleConfig` capability, and validated kernel-side against a
  per-module schema registry, so agents and UI share one boundary.
- **Governance tab: the missing policy editor.** Settings > Governance edits
  the org's blanket autonomy policy through the new `iam.setOrgPolicy`
  capability (identity-class): max autonomous risk for the workmate, the
  payment threshold that forces sign-off, and ADR 0055's maker-checker
  strict mode for humans, per risk class. Changes apply to the next action.
- **Quick create, Odoo-style.** A "+" next to customer, product, and vendor
  pickers (sales order lines, the purchase order builder, the deal convert
  dialog) opens a compact creation modal without leaving the page, with
  "Create", "Create & new", and "Cancel" buttons; the new record is selected
  in the picker and the list refreshes underneath. The command palette
  (Ctrl/Cmd+K) gains "New customer / product / vendor" entries, gated by the
  organization's module switchboard. Every quick create rides the same
  governed capability as the module's own page.
- **The Chaste emblem ships.** The logo from `assets/` is now the favicon,
  the rail's home coin, the mobile top-bar home button, and the brand mark on
  the sign-in and setup screens.
- **Branded route loading.** Navigations show the emblem spinning like a
  struck coin ("Opening the books...") instead of a blank frame, both
  full-screen for top-level segments and in-content inside the app shell;
  honors reduced motion.
- **Mobile account access.** The mobile top bar gains the account avatar; it
  opens the same account menu as the desktop rail (identity, org switcher,
  sign out).

- **Workspace model provider and currency controls.** Administrators can now
  choose supported providers or an OpenAI-compatible endpoint, configure model
  roles, rotate or clear an encrypted workspace key, and use the active
  organization/device currency in shared money formatting. Local Codex,
  OpenCode, and Kilo subscription files are deliberately not imported.
- **Durable agent run checkpoints.** Agent goals now have version-pinned,
  tenant-scoped run and step records that link approvals, queue jobs, and
  action receipts. A replacement worker can reclaim a lease after a crash and
  replay the same intent without creating a second purchase order.
- **Read-only trajectory replay.** Persisted user, assistant, tool-call, and
  tool-result events can now be reconstructed into the model-visible trace
  without invoking a model, capability, or executor.
- **Structured capability-gap tickets.** Unavailable behavior can be captured
  with a requested capability id, desired behavior, acceptance criteria, and
  example input; the ticket records that no execution was attempted.
- **Isolated Creator candidate evidence.** A sanitized gap can be rendered in
  a disposable detached worktree, independently checked, hashed, and recorded
  with rollback evidence while remaining `in_review`; generated code is not
  promoted or executed by the verifier.
- **Cordis-like harness composition boundary.** Versioned profiles, deterministic
  bundle/configuration digests, dependency-ordered service lifecycle, rollback,
  runtime inspection, and live events now wrap the existing registry and kernel
  executor without creating a second capability execution path.
- **Persisted harness identity and safe inspection.** Approved composition
  snapshots are now tenant-scoped and idempotent, durable runs pin their
  profile/version/digest, and inspection returns metadata and config keys
  without exposing patch values.
- **Profile-aware durable-run coordination.** Durable runs can now resolve a
  tenant-approved composition, verify the requested profile and live runtime
  digest, mount the existing kernel bridge, and fail closed before run creation
  for cross-tenant, unsupported, or mismatched compositions.
- **Approved harness bundle resolution.** The adapter now resolves persisted
  bundle manifests through an explicit resolver list, supports additional
  lifecycle services and runtime configuration patches, and rejects unknown
  bundles before a durable run can be created.
- **Governed harness composition approval.** Composition requests now use the
  existing capability registry, approval inbox, atomic decision path, and
  append-only audit ledger; durable coordination requires an executed approval
  for the exact tenant-owned composition digest before mounting or run creation.
- **Controlled Creator evolution release handoff.** Approved isolated
  candidates can now be staged and promoted only through the existing kernel
  approval path, with the exact evidence digest and immutable artifact
  reference recorded in a tenant-scoped release row. Staged or promoted
  handoffs can be rolled back conditionally; no candidate source is installed
  or executed by this runtime.
- **Creator canary outcome evidence.** Promoted releases now retain their
  originating capability-gap ticket, and a distinct
  `platform.creator.release` principal can record durable canary pass/fail
  evidence for the exact digest. Outcomes do not automatically deploy or roll
  back the release; source execution remains outside this runtime.
- **Integrated operations surfaces.** Sessions now show durable run
  checkpoints and canonical read-only replay; Creator proposals now include
  capability gaps, controlled release state, and canary evidence; and Settings
  exposes safe tenant-scoped harness composition inspection. Release actions
  request the existing kernel approval path rather than creating a second
  authority surface.
- **Docker deployment smoke path.** The Compose stack now runs the production
  web image beside pgvector, supports isolated host ports and runtime settings,
  checks the database-backed health endpoint, and includes an executable
  `scripts/verify-docker.mjs` cleanup-safe smoke test.
- **the pilot surfaces are built (W0.5).** A receiving desk that records
  what arrived line by line - accepted, rejected with a reason, and what
  stays outstanding - through the governed receiving capabilities; a "My
  Work" home section ranking approvals, outstanding deliveries and module
  signals deterministically, each card with one primary action; an optional
  AI brief over that ranked list (openrouter/stealth/union-alpha, honest
  degradation without a key); a supplier view remembering open orders and
  owed bills; and client-side pilot metrics for time-to-first-action.
- **pilot selection recorded (W0.5).** The audit's "one pilot cohort,
  P01–P04 first" decision is made on evidence: a distribution/wholesale
  purchasing-and-receiving team piloting the receive → exception → bill →
  pay chain from a "My work" home, with the receiving desk as the first
  vertical journey. `docs/w05-pilot-selection.md` records the cohort, the
  workflow, alternatives (reconciliation workspace, checkout deferred) and
  the measurement plan; owner confirmation unlocks the UI build.

- **SCIM provisioning tokens expire (0054).** Tokens used to be valid until
  manually deactivated. New tokens live 90 days by default (1–365
  configurable), expired tokens are refused outright, and rotation is
  create-new + deactivate-old; pre-policy tokens stay valid until
  deactivated.
- **stock reads hit a maintained projection; one number allocator; bin-scoped
  counts (N22).** Every stock report used to re-sum the entire movement
  ledger, cycle counts could only count the whole warehouse at once, and
  each module rolled its own `max(number)+1` document numbering that could
  race under two concurrent creators. The ledger now projects into
  `stock_balances` via a database trigger - consistent by construction,
  repairable by replay - so on-hand reads are constant-cost; cycle counts
  scope to a single location with per-bin adjustments; and document numbers
  come from one per-org allocator seeded from existing maxima.
- **goods receipts are documents with stable line positions and explicit
  authority (N16).** Receiving used to be inferred back out of the stock
  ledger: no record of who received or when, no home for refused goods,
  no way to say which receipt a return undid, and "line 1" meant whatever
  row the database happened to return first. Receiving now writes receipt
  documents - accepted versus rejected quantities per line, returns drawn
  from concrete receipts, overreceipt only with paired tolerance and
  authority reason - and order lines carry stable display positions that
  survive reordering across the module and the human API.
- **year-end closes are explicit exceptional entries, with eligible posting
  and dated corrections (N13).** The closing roll used to be an
  indistinguishable manual entry: it zeroed income accounts inside the year
  it sealed, so the P&L report silently showed zero revenue for every
  closed year, closing twice double-rolled retained earnings, reversals
  were indistinguishable from fresh postings, and any caller holding a
  pre-resolved account id could post through an archived or foreign
  account. The roll now carries `entry_kind = 'year_end_close'`, is
  replaced inside its own reopened December on re-close (one live roll per
  sealed year), the P&L report excludes the close family so operating
  history survives the seal, reversals post in the approved open period
  while carrying the original business date (`business_at`), and the
  posting service validates every account id against posting eligibility.
- **vendor payments undo through their own domain compensation (N12).**
  Reversing a vendor payment with the generic journal mirror used to leave
  the bill marked paid and its paid amount consumed - the books balanced
  while the payable lied. The new `purchasing.reverseVendorPayment` mirrors
  the payment entry in its original currency, releases the bill's paid
  amount, demotes a paid bill back to open, and refuses a second or
  replayed reversal. `payBill` declares it as the real inverse and now
  settles bills through the balance contract, so vendor credits alone can
  mark a bill paid.
- **bank matching grows an allocation model with a real reconciled
  definition (N14).** A statement line is explained by explicit
  allocations - a payment (whole, split across lines, or grouped with other
  payments on one line), a journal entry, a reviewed bank fee, or an FX
  difference - that share the line's sign and fit inside its amount.
  Payment and entry claims are enforced by row locks and remaining-amount
  budgets instead of single-claim unique indexes, so splits and grouped
  settlements are expressible without loose matches. New
  `accounting.bankReconciliation` reports per-line and per-period
  allocations and the unexplained difference; a statement period is
  reconciled when that difference is exactly zero.
- **one credit-adjusted balance everywhere, with locked money application
  (N11).** Every surface that shows an outstanding amount - invoice lists,
  AR aging, the dashboard's receivables and payables, vendor bill due
  amounts, the customer portal, support invoice lookup, FX exposure and
  overdue signals - now nets credits against the total, so a credited
  invoice no longer looks collectible in one place and settled in another.
  Overdue aging and signals run from the due date rather than the issue
  date, and not-yet-due invoices stay current. Payments and credits
  serialize on a per-document row lock, so two simultaneous payments that
  would jointly overpay are refused instead of racing past the cap.
- **worker-kill proof for the queue and outbox (B03).** A new fixture kills
  a worker mid-flight while it holds the lease and pins the recovery
  contract for three windows: killed after the effect (the replacement
  replays the receipt - exactly one effect), killed mid-execution
  (at-least-once redelivery, the dead worker's acknowledgement stays
  fenced), and an external webhook whose acknowledgement died in transit
  (the delivery converges to an honest "unknown", never auto re-fires, and
  reconciliation settles it from the provider receipt exactly once).
- **the stock ledger is append-only at the database (ADR 0052 extension).**
  Stock movements can no longer be edited or deleted by any code path:
  corrections are compensating movements - reversal runs, transfer
  reversals, cycle-count postings - exactly like financial corrections.
  Database triggers refuse mutations outside a declared maintenance
  context used only by teardown and repair, and the runtime role holds the
  same append-only privilege shape as the journal tables.
- **intent-keyed, honest bootstrap (B01/T08).** Workspace creation now
  commits a receipt atomically with the organization, keyed by the browser's
  intent id: if the response is lost, a retry replays the original result
  instead of creating a second company, and reusing an intent id with
  different details is refused. Slug collisions are settled by the database
  inside the transaction, and the AI embedding of the business description
  is upgraded after commit so a slow or failing provider can never stall or
  break setup. The setup wizard remembers its intent across retries and
  clears it once the workspace exists.
- **intent action identity on every mutating UI request (B02 adoption).**
  The UI's single API seam now stamps each POST with a per-call `intentId`
  (callers can pass their own to span retries of one logical action), and
  every mutating API route threads it into the actor context. A request
  that is retried - double-click, flaky network, proxy replay - now
  reconciles to the original server-side receipt instead of executing
  twice, and reusing an identity with a different payload is refused.
  Agent loops are excluded by design (one context spans many tool steps;
  scheduled runs already key receipts by job id).
- **identity lifecycle and public-widget containment (N03/N04/N07/N08,
  ADR 0053).** Invitation acceptance is now a row-locked, compare-and-set
  transaction - a concurrent double accept yields exactly one winner, an
  unverified mailbox cannot claim a pre-provisioned binding, and expired or
  mismatched invitations fail honestly. Member deactivation (SCIM DELETE)
  removes membership, every role grant, and pending invitations in one
  transaction, and neither it nor role reassignment can strip the
  organization's last owner. The customer widget no longer binds a customer
  from a visitor's email: threads start unbound with a per-conversation
  secret (issued once, stored hashed) gating every later read, message, and
  escalation, so knowing someone's email plus the public token reveals
  nothing about them. Conversation and ticket creation go through governed
  kernel capabilities - chat's honesty path files audited tickets with a
  real id in the receipt and reports refusals honestly.

- **The database now enforces the ledger's defining invariants (N09,
  ADR 0052).** Migration 0046 makes the books' guarantees commit-time facts
  instead of application-code assertions: journal lines are CHECKed
  nonnegative, single-sided and nonzero; deferred triggers refuse any entry
  that would commit unbalanced, incomplete (fewer than two lines), with a
  zero total, or with a line whose account belongs to another organization;
  posted journal rows and event-ledger rows refuse UPDATE, DELETE and
  TRUNCATE - corrections are reversal entries. Teardowns and out-of-band
  repairs use one declared maintenance context
  (`beginLedgerMaintenance`/`purgeTenantFinancials` in @chaste/db) that the
  immutability guards honor but the balance guards ignore, so nothing broken
  can ever commit. The runtime role (`chaste_app`) additionally lost
  mutation rights on the append-only tables, re-revoked on every role
  provisioning run and asserted by the RLS conformance sweep. A dirty legacy
  database fails the migration naming the offending entries - reconcile
  first, never silently rewrite history. Pinned by `journal-guards.test.ts`
  (the audit's full negative/positive proof list), the runtime-role suite,
  the conformance sweep, and a discharged `probe-n09`.

- **The web UI now reaches backend capability sets that had no human
  surface.** Sales orders got their full lifecycle (draft → confirm with
  credit check and stock reservation → deliver-and-invoice → cancel) plus
  an orders tab in the Sales app. HR gained the recruitment pipeline
  (openings, applicants, stage moves, hire-to-employee), attendance clock
  in/out with late flagging, leave balances, the team leave calendar,
  employee structure editing, and per-entry timesheet approvals. CRM
  exposed lead conversion, follow-up tasks, and per-customer timelines.
  Purchasing reached supplier credit notes, purchase-order closing with
  backorder marking, vendor goods returns, and the supplier performance
  report. Accounting gained human paths to issue invoices, record and
  reverse payments, credit invoices, reopen sealed periods, record FX
  rates, and read the cash-flow statement and unrealized FX exposure,
  plus undo controls for matched/excluded bank transactions. Support
  gained ticket reopen, priority/category/assignee/SLA editing, rule-based
  category suggestions, canned responses, and knowledge-base authoring.
  Manufacturing exposed BOM tree, production feasibility, and BOM report
  surfaces. Inventory reached item editing, barcode lookup, and posting
  valuation summaries; the Marketplace gained the plugin verify/publish
  surface. Money-gated actions route through the existing approvals flow
  (202 → Approvals inbox); everything else executes the same governed
  capabilities the agent uses.

- **Recoverable queue leases and recurring occurrence receipts (T03/T06).**
  Capability jobs now have availability timestamps, expiring worker leases,
  fencing tokens, heartbeat renewal and capped exponential retry backoff;
  stale workers cannot finalize reclaimed rows, and queued capability retries
  reuse the job's governed action intent. Recurring invoices now persist a
  unique `(org, template, scheduled instant)` occurrence and create the
  invoice plus schedule advancement transactionally, so the same occurrence
  cannot bill twice. Covered by queue lease/fencing and recurring-invoice
  integration tests; external provider delivery is handled by the B03 outbox
  slice below.
- **Durable outbound notification outbox (B03).** Approval and support
  notification intents now commit before webhook/SMTP delivery, carry stable
  provider operation IDs, and preserve uncertain provider outcomes for
  explicit reconciliation instead of automatic duplicate sends.
- **Atomic unit of work for governed payments (B02)**:
  `executeAtomically` runs one action's mutation, audit fact and action
  receipt inside a single transaction - modules nest via savepoints - with a
  `failOnAuditError` executor mode so an audit failure rolls the whole unit
  back instead of reporting an unproven outcome. `api/accounting` `payBill`
  adopts it whenever the client sends `intentId`, and the accounting page
  generates one identity per confirmed intent. Pinned by tests proving
  commit+replay in one unit and full rollback on crash-after-write.
- **Honest effect semantics and action receipts in the kernel (B02 slice)**:
  `KernelExecutor` validates capability output against its declared schema -
  a write returning invalid output now reports `outcome: "unknown"` instead
  of `ok: true`, and an audit append failure after a committed write reports
  unknown instead of a retryable failure (closing the F01/F02 reproductions
  in the evidence register). New `EffectReceiptStore` seam +
  `action_receipts` table (migration 0035, tenant-RLS policy included) give
  every action an idempotent identity: with `ctx.intentId`, retries serve
  the stored receipt - a committed effect replays its receipt instead of
  re-executing, a reused key with a changed payload conflicts, and an
  unproven outcome reconciles rather than double-posting. Wired through
  `buildExecutor`; `api/accounting` mutations accept `intentId`. Pinned by
  six kernel tests and three integration tests including the
  payment-crash-retry money case.
- **Least-privilege runtime database role** (`@chaste/db/roles`): `chaste_app`
  - NOBYPASSRLS, DML-only, no DDL - provisioned idempotently with grants on
  existing tables and default privileges for future ones, so the application
  can stop running as the superuser migration owner (migration 0014's stated
  intent, previously never wired up: the deployed database had a single
  superuser role, making RLS inert). `runMigrations` accepts
  `MIGRATION_DATABASE_URL` for separated owner credentials. The role's
  security contract (tenant-scoped reads, fail-closed without context, no
  cross-tenant writes, no DDL) is pinned by five tests in
  `packages/db/src/runtime-role.test.ts`. The application's own role flip is
  deliberately not done yet - it requires the entry-point context audit (S01).
- **W0 evidence register** (`docs/W0_EVIDENCE_REGISTER.md`): F01–F17 and
  N01–N10 revalidated at the current commit with executed probes where
  possible - F01 (committed write reported as failure when the audit append
  fails), F02 (capability output schema not enforced at the executor
  boundary), F05 (agent-loop trajectory events silently unpersisted,
  reproduced from test logs), N09 (no database-enforced ledger balance or
  posted-line immutability, reproduced on a fixture database), and N11's
  AR side (full payment accepted past credit-adjusted outstanding). The
  remaining findings carry source-confirmed status with their named
  reproduction still pending.
- **The module test suites now actually run.** Nineteen module `.test.ts`
  files across fifteen packages existed but were invisible to
  `pnpm test` (only manufacturing and signals declared a `test` script, and
  the web Vitest config did not discover them). Every module package now has
  a Vitest project with per-run database fixtures, `vitest` declared as a
  devDependency, and the lockfile regenerated; `pnpm test` executes all
  22 module test files plus `web` and `db`. The `turbo test` task is no
  longer cached, since results depend on live database state.

- Personal Codex and OpenCode plan connections. Users can sign into Codex with its device flow or connect an authenticated OpenCode server, choose a personal default, and see request and provider-reported token usage.
- Personal coding-plan controls now appear before shared model settings, so people can find their own inference connection quickly and manage it even when workspace provider settings are unavailable.
- Coding-plan inference for Buzz, internal chat assistance, support drafting, document writing assist, and My Work summaries. User-started runs use the selected personal plan; scheduled runs continue to use the workspace provider.
- Coding-agent business tools connect through a short-lived, signed MCP grant scoped to the user's permissions, enabled modules, session, and tools already exposed to that agent. Tool calls still pass through the kernel executor and audit ledger.
- CRM customer search and active, inactive, and all views, with mobile customer cards that keep timeline and deactivation actions visible.
- CRM customer profiles combine related deals, tasks, invoices, quotes, payments, linked documents, notes, ownership, tags, and quick email or follow-up actions.
- CRM customer profiles include an editable customer name saved with an audited undo path.
- CRM follow-up drafts use recent invoices, quotes, and tasks as source context, show links to those records, stay editable, and only open an email composer after a deliberate user action.
- CRM customer cards and wide-table rows now open the profile across their main surface, with selection, email, next-step, and record actions kept independent.
- Accounting receivables aging cards filter the underlying invoice list by age range, keep the active range visible, and offer a one-tap reset.
- CRM customer import uses editable row cards on phones, keeping validation, duplicate choices, and import selection visible without horizontal table scrolling.
- Summary cards across CRM, Sales, POS, Products, Inventory, Documents, Support, Purchasing, Manufacturing, and HR now show a clear action affordance and open the relevant list, status filter, or workflow. Sales pipeline metrics deep-link into the filtered CRM pipeline.
- Document summary cards open the library with matching parsed, awaiting-parse, or recent-document filters. Support summary cards open the inbox with the matching conversation status selected.
- CRM saved filters, stale follow-up and owner views, duplicate suggestions, bulk owner and tag updates, and selected-customer CSV export.
- CRM saved views now sync with the workspace, can be shared or pinned, and show live result counts. Customer cards and profiles show their next action; profiles also include preferred contact method, do-not-contact status, owner, and last editor. A guided customer CSV preview supports column mapping, duplicate review, inline fixes, and reversible import.
- CRM duplicate review compares contact and name details, previews linked activity, preserves existing record links, and offers an immediate audited undo. On phones, comparison cards fit the dialog width and wrap full customer names so similar records stay distinguishable.
- POS product search by name, SKU, or barcode; stock-aware cart quantities; custom line items; and a structured return request dialog.
- POS empty-register quick add captures price, barcode, and optional opening stock, and explains when zero stock or an approval means the item cannot be sold yet. Less-used unit and SKU fields stay behind More details.
- Inventory stock value now leads with a plain-language estimate and keeps moving-average and ledger details in an expandable explanation.
- Inventory stock levels keep Add item beside the heading on phones, then focus the item name field in the creation flow.
- POS customer lookup with purchase history, cash tender and change calculation, split cash/card/mobile-money tenders, shareable printable receipts, a selected refund destination, and register-scoped offline carts that can be parked and resumed from the same device.
- POS sale history opens a receipt preview with print, download, email-draft, and messaging-share actions. Return review selects item quantities, previews the refund, traces prior returned quantities, and restores only stock tied to the original sale lines. Older sales without line-to-stock links keep a full-return path, and unlinked prior credits require accounting review.
- POS shift closeout shows captured sales by tender alongside the separate drawer expectation, counts cash by denomination, requires a note for variances, and repeats the figures in a final review. Inventory empty states point to setup actions, and the overview surfaces draft transfers alongside counts, reservations, and reorder work.
- Products & Services can import a mapped catalog CSV from the catalog screen, preview likely SKU or barcode duplicates, import services without a supplied SKU, and undo a recent batch while preserving item history.
- Approval cards with plain-language summaries, affected-field previews, linked document shortcuts, and recent decision history with audit-ledger links.
- Document library search and status filters, mobile document cards, explicit loading and error states, and file type and size validation.
- Document review pairs the original source with extracted lines and coding suggestions, shows matched terms and account names, and supports linking new ingests to a customer.
- Horizontally scrolling app tabs with arrow-key navigation and selected-tab semantics.
- Messages loads its conversations on entry, gives connection failures a retry action, and guides first-time users into creating a conversation.
- App sections remain visible as horizontally scrollable tabs on phones, with a swipe hint when the full set does not fit.
- Mobile app headers now include a shared Ask workmate action. Sales summary cards fill the phone width cleanly, and the Workmate composer grows to fit prompts instead of showing a clipped one-line field.
- Inventory cycle counts can start from a location, barcode scan, or selected products; the count sheet tracks progress and requires a review of every variance before posting.
- Inventory transfer and reservation forms now search location names, item names, SKUs, and barcodes, with available quantity shown before selection.
- Inventory Locations groups transfers and reservations into collapsible work areas with clear pending and active counts, keeping setup and movement workflows easy to scan on phones.
  document without an explicit Apply. Uses the user's selected coding plan
  for user-started runs, or the organization's configured model provider.

### Fixed
- **CRM timeline profile switching.** Closing a customer profile or opening another surface invalidates its pending timeline request, so late results and errors do not update a dismissed profile.
- **Unverified sessions could inspect organization membership names.** The organization list and switch endpoints now stop before querying memberships for unverified email sessions, preserving the empty organization context and preventing the active-org cookie from being set.
- **Messages stayed on the loading screen.** The conversation list now loads on mount, and request failures leave loading state so the retry message can render.
- **Templates outside the catalog were invisible in the gallery.** Built-in general templates (blank note, business letter, meeting notes, quote) and anything saved with Save as template lacked a catalog entry and silently skipped their cards; they now render under Other with their own paper thumbnails.
- **Authored document creation now returns the created record reliably.** The document API returns capability results at the shape the editor expects, so template and blank-document creation navigate to the saved document instead of appearing to fail after persistence.
- **Template seeding is organization-safe.** Built-in template discovery now scopes its existence check to the current organization, preventing templates in one workspace from suppressing another workspace's catalog.
- **PDF pagination preserves business-document structure.** Export uses a dedicated print surface with saved page settings, repeating long-table headers, unbroken rows and signature blocks, responsive images, clean page backgrounds, and no trailing blank page.
- **Upload failures are actionable.** The ingest form rejects unsupported files and files above 5 MB before upload, preserves the form, and explains how to recover.
- **Accounting scenario math stays within exact integer limits.** Budget
  comparisons use integer-safe rounding for utilization and reject derived
  values outside the supported amount range.
- **Supplier bill forms are easier to read and use with assistive technology.**
  Aging labels and payment guidance have stronger dark-mode contrast, and the
  vendor and purchase-order controls have accessible names.
- **Document and suggestion counts were silently zero.** Correlated count
  subqueries interpolated unqualified column names, so a subquery like
  `where document_id = id` compared a table to itself and always returned
  0. Authored-document version counts and the long-standing open-coding-
  suggestions count now qualify their columns explicitly.
- **Deleted conversations and messages could still leak through detail paths.**
  Conversation lists, reads, sends, and the workmate transcript now exclude
  deleted records, and mention notifications stay inside the conversation.
- **Renaming a channel lost focus after one character.** Dialog focus setup and restoration now run only when the dialog opens or closes, so ordinary state updates keep the rename field active.
- **Dev routes hung after Next reported Ready.** Default local development now aliases boot migration to a no-op, keeping Node-only migration and backup dependencies out of route compilation while preserving production migrations and explicit local opt-in.
- **Partial print-branding updates could erase saved fields.** Omitting a
  logo, accent, footer, or layout now preserves the organization's existing
  value.

- **The module switchboard can no longer brick an organization.** Toggling
  any module used to silently disable `iam`, `routines`, and `signals`
  (they were missing from the UI catalog and dropped by the full-set save),
  and the kernel then refused the very capability that could re-enable
  them, surfacing only "Module "iam" is disabled for this organization"
  with no recovery path. Those spine modules are now protected: rendered
  locked-on in the switchboard, unioned into every save by
  `iam.setModules`/`iam.restoreModules`, and always enabled in the kernel
  module gate. The raw "disabled" error also got a friendly, actionable
  mapping.
- **Display currency actually works.** The Localization setting was writing a
  preference that no page consumed; every money formatter hardcoded `$`.
  Money now renders in the organization's base currency by default (a UGX
  org sees `USh 8,000,000`, with ISO 4217 minor-unit digits: zero decimals
  for UGX), and an explicit per-device choice in Settings wins on top.
  Formatting and input parsing share one source of truth; stored minor
  units are untouched (presentation only, no FX conversion).

- **The consolidated Needs you badge could undercount receipt remainders.**
  The queue now includes those fetched work cards in its visible count as
  soon as they arrive.
- **Sign-up ended in a hung spinner with no explanation.** Under the
  verified-binding profile (N03) sign-up creates the account but skips
  auto sign-in, so `router.replace("/")` bounced off the auth guard straight
  back to `/login` while the submit button read "Please wait…" forever. The
  form now detects the no-session response and shows a "Check your inbox"
  state with the address and next steps, and an unverified sign-in attempt
  maps to "we just sent a fresh link" instead of a raw better-auth error.
- **Auth and onboarding rendered broken under dark mode.** The login form and
  the setup wizard are authored as a fixed warm-paper composition (hardcoded
  ink hero, cream panels), but the tokens they use for inputs, cards and text
  (`white`, `ink`, `sand-*`, `cream`, `gold-*`) flip with `data-mode` - dark
  mode produced near-black inputs on the cream card, charcoal path cards, and
  washed-out headings. An `.auth-surface` scope now re-pins those tokens to
  the designed light values (and paints the page canvas to match), so the
  gateway reads identically in both modes.
- **Onboarding was cut off on large screens.** The wizard pinned itself to
  `100svh` with `overflow: hidden`, so on a short desktop window the step
  content (path cards, profile form) clipped with no way to scroll - the same
  content scrolled fine on small screens. The page now scrolls naturally and
  the context column sticks beside it; the login page drops its viewport lock
  the same way.
- **My Work remainders read full outstanding (W0.5).** The receipt-remainder
  query correlated receipt lines with a bare `"id"` (Drizzle renders an
  embedded column unqualified, so the subquery compared each receipt's
  `po_line_id` against its *own* id and always summed zero) - every card
  read the full order as outstanding. The correlation is now explicit, the
  remainder subtracts returns net of receipts (a returned delivery demotes
  the order to partial in the domain but read as received here), quantities
  print in units instead of raw thousandths, PO data is gated on
  `purchasing.read` like every other surface, a non-throwing
  `signals.list` failure shows the honest unavailable card, and the dead
  severity term in the ranker is gone (signals.list already sorts red
  first). Pinned by amount-asserting route tests.
- **Concurrent vendor-payment reversals double-refunded (N12).** The
  already-reversed check ran before the bill row lock, so two concurrent
  reversals both passed it and both mirrored (surfacing as a `RangeError`
  on negative paidMinor). The check now runs after the bill lock is
  acquired - the loser sees the winner's committed reversal - and the bill
  read is org-scoped. Pinned by a `Promise.allSettled` racer (exactly one
  mirror; proven to fail on the old order).
- **`accounting.recordPayment` declared a dead inverse.** It pointed at
  `accounting.reverseEntry`, which refuses payment entries by design, so any
  kernel-driven undo of a payment failed. It now points at
  `accounting.reversePayment` (same pattern as payBill →
  reverseVendorPayment), pinned by a buildInput-from-actual-output test.
- **Queue/worker-kill fixtures vs the append-only ledger (N09).**
  `jobs.test.ts` teardown deleted `ledger_events` raw, which the commit-time
  immutability triggers refuse - it now purges through the declared
  maintenance helper; the worker-kill "after the receipt" case synchronized
  on effect-start rather than receipt durability and flaked under load when
  the replacement read before the receipt landed - it now waits for the
  receipt row.
- **Client intent stamp bypass (B02).** `withIntentId` kept any present
  `intentId` key without checking its type, so `{intentId: undefined}` (or a
  number, or `""`) sailed through unstamped and executed with no identity.
  Only non-empty strings win now; everything else is stamped fresh.

- **POS sales patched their journal entry after posting (N09).** The sale
  entry was inserted before the invoice row existed, so the register code
  reached back to stamp `source_id` on a posted ledger row. The invoice is
  now created first and the entry posts with its source link at insert time
  - the only legitimate post-insert journal mutation is gone, and returns
  find the sale entry exactly as before.
- **A generic journal reversal was offered as a complete business undo
  (N12).** Reversing a payment's GL entry left the invoice collecting on
  money already returned, reversing a payroll posting left the run marked
  executed with its ledger leg gone, and a POS sale's declared inverse read
  an output key that never existed. Source types that own subledger or
  lifecycle state now undo through domain compensations: payments mirror
  every entry in its original currency (FX settlements as a coherent pair)
  and release the invoice balance; payroll reversals repair the run
  lifecycle; register sales undo through returns that restore stock, drawer
  and money together; invoices route to credit notes. The generic path
  refuses protected entries and names the workflow that actually undoes
  the thing, preserves the original currency, and the kernel now types
  inverse builders against the real output so a phantom key is a compile
  error (ADR 0051). Pinned by live-DB tests across accounting, POS and HR.
- **Stock commands raced each other and trusted unvalidated lots (N22).**
  One inventory command service now owns every quantity change: all writers
  (inventory, POS, purchasing receipts/returns, sales delivery,
  manufacturing production) lock the item rows in stable order and move
  quantity through shared guards, so concurrent commands serialize instead
  of each passing the same check and driving stock negative. A lot can no
  longer move another item's stock, the balance can no longer go negative
  org-wide or at a named location, and cycle counts snapshot a movement
  watermark - a receipt plus a sale during counting is caught at post time
  even when net quantity landed back where it started (a drifted sheet is
  refused permanently; re-count). POS and purchasing import the inventory
  command service directly - the sanctioned stock-ledger seam now matches
  the one every writer actually uses (ADR 0050). Pinned by seven live-DB
  inventory tests; manufacturing's cycle-count suite asserts the stricter
  watermark semantics.
- **Receiving, returns, and bills ignored ordered quantities and each other
  (N16).** Every purchasing command now spends one budget per order line:
  receipts refuse quantities beyond what was ordered (overreceipt needs an
  amended order), repeated line references inside one receipt, return, or
  bill consume each other's allowance instead of each seeing full stock, and
  a vendor bill is only valid from the vendor who holds the order. Service
  lines join the receiving contract through an explicit accepted milestone
  on the order line - no fake stock - so mixed and service-only orders can
  complete. Returns require the goods to still be on hand (shipped goods
  need a customer return) and demote a fully-received order back to
  partial. Pinned by six live-DB purchasing tests (ADR 0049).
- **Bank matching reconciled identities, not money (N14).** A statement line
  can now claim a payment or entry only when it is economically equivalent:
  same amount (100 banked refuses to explain a 10 payment), same direction
  (a customer payment is money in), same currency as the statement account,
  and - for entries - the entry must move the cash account by the line's
  signed amount. One reconciled payment or entry belongs to exactly one
  statement line, enforced by unique indexes in data (unmatched lines carry
  NULL and never conflict) with readable refusals for racing claims, and
  unmatching restores availability. Fees, splits and grouped settlements
  stay explicit-review work: they refuse as mismatches instead of matching
  loosely. Pinned by six live-DB tests including a data-level duplicate
  claim rejection (ADR 0048).
- **Repeated order lines could over-reserve the same stock (N15).** Stock
  checks now aggregate demand by item identity and spend one running
  availability budget - 7 + 7 against 10 reserves 10, never 14 - and readers
  lock the touched item rows in stable id order, so two concurrent orders (or
  an order and a register sale) can no longer both claim the last unit: the
  loser re-reads the budget and refuses. The register now also sells only
  available-to-promise (on hand minus open reservations), so stock promised
  to a confirmed order is no longer sellable over the counter, and a refused
  sale leaves no invoice or stock movement behind. Pinned by sales tests for
  repeated/mixed-line budgeting and a two-buyer last-unit race, plus POS
  tests for the shared budget and reservation honoring (ADR 0047).
- **Every `demo:*` script failed to start with `Cannot find module '@/…'`.**
  The onboarding wizard's `@/lib/onboarding-plan` import was the first alias
  import in the demos' server chain, and tsx running from the repo root never
  saw the web app's path mapping. Demo scripts now pass
  `--tsconfig apps/web/tsconfig.json`, restoring all live demo proofs.
- **Some postings could land in a closed accounting period (N13).** The
  shared posting service now owns the guard: every entry carries a mandatory
  effective posting time, the service checks it under a per-org lock shared
  with period close/reopen, and close/reopen commit transactionally - so a
  post and a close always finish in one serial order. Expense reimbursement
  and the inventory valuation reversal (previously unguarded) refuse sealed
  months along with every other producer; payroll posts at execution time
  instead of a mid-month guess. With one clock basis, same-instant statement
  rows order by business sequence (invoice → payment → credit note) and
  payment timestamps come from the actor's `now`, not a second database
  clock. Pinned by five live-DB tests: guarded reimbursement, direct-posting
  refusal, year-end seal holding, close-behind-post serialization, and a
  synchronized close/post race with one serial order (ADR 0046).
- **Disabled routines could still execute already-queued schedule jobs (N28).**
  Scheduled execution now rechecks the routine state and cancels the occurrence
  before any agent work begins when the routine was disabled after enqueue.
- **Scheduled routine claims could lose or duplicate occurrences (N28).**
  Due-routine selection, occurrence creation, rescheduling, and durable job
  enqueue now commit together, with a unique routine/scheduled-time key and
  linked run status updates.
- **Routine schedule edits could silently change execution timing (N27).**
  Structured schedules now require kind-specific fields and valid clock ranges,
  natural-language intervals reject trailing qualifiers, and edits unrelated
  to the schedule preserve the existing next occurrence.
- **Marketing sends could claim delivery without an external operation
  (N26).** Campaign recipients now bind to durable, idempotent email outbox
  rows; opted-out, deactivated, missing-address, and changed-address contacts
  are excluded or fail closed at dispatch, while analytics count only
  provider-confirmed delivery. The Marketing UI now distinguishes queued work
  from confirmed delivery.
- **Outstanding balances ignored customer credits (N11).** A single
  document-balance contract (`@chaste/erp-core` `documentBalance` /
  `canAcceptPayment`) now gates `accounting.recordPayment` and
  `purchasing.payBill`: payments are capped at `total − credited − paid`,
  drafts and voids refuse money, and "fully paid" accounts for credits.
  Analytics invoice aging and the support invoice projection derive
  outstanding through the same contract, so no surface can show a debt the
  ledger no longer believes. Integer-exact with `RangeError` on bad money;
  pinned by seven erp-core tests including conservation and acceptance-cap
  sweeps.
- **CSV import wrote domain rows on session membership alone (X15/N08) and
  parsed money through floats.** Importing customers now requires
  `crm.write` and products `inventory.write`; money converts exactly from
  the raw string (`"1,234.56"` → 123456 minor units) with sub-cent
  precision, negatives and malformed amounts returned as per-row errors
  instead of silent float coercion.
- **A filed ticket answered "ticket filed" with no reference (X11).** The
  ticket sink returns the durable id and the `file_ticket` tool result now
  carries `ticketId` across chat, conversation replies, and routines.
- **Route read authorization (N01) and the conversation list leak (N06)**:
  unguarded GET routes no longer return another module's records to any
  signed-in member - hr salaries (`hr.read`), ledger payloads
  (`accounting.read`), customers/deals (`crm.read`), marketing
  (`marketing.read`), projects (`projects.read`), POS lists (`pos.read`),
  accounting summaries (`accounting.read`), and the setup checklist
  (`iam.admin`, it exposes the support embed token).
  The agent-session list applies the detail route's visibility rule (own
  sessions, all for admins). The conversations list is now membership-scoped
  like the detail boundary - a nonmember sees neither titles nor message
  previews of a DM. Owners (`*`) are unaffected; restricted roles need the
  explicit read grants. Pinned by a six-case route matrix calling real
  handlers with mocked sessions against a fixture database. The web suite's
  hook timeout is raised to 30s: 18 files share one fixture database per run
  and a 5-second `beforeAll` under parallel load legitimately exceeded the
  10s default (the historical `products.test.ts` flake).
- **Six org-scoped tables had no row-level security.** `bank_accounts`,
  `bank_transactions`, `purchase_requests`, `rfqs`, `sales_tax_filings` and
  `support_settings` were created after migration 0014's RLS pass and never
  received policies - a tenant's rows were fully visible to any same-database
  reader bypassing the application layer. Migration 0037 applies the standard
  `tenant_isolation` policy, and a new mechanical conformance suite
  (`packages/db/src/rls-conformance.test.ts`) now sweeps every org-scoped
  table on every test run: RLS enabled, policy present, DML granted to the
  least-privilege runtime role, fail-closed without tenant context, and no
  cross-tenant reads under another org's context. Every fixture database also
  provisions the `chaste_app` role automatically.
- **Notification broadcasts were cleared for everyone by one read (N29).**
  Notifications are now immutable events with per-user receipts
  (`notification_reads`, migration 0036): reading a broadcast marks it read
  only for that person, repeats are idempotent, and one user cannot mark
  another user's personal notification.
- **Proposal review decisions could double-apply (N34).** The review decision
  is now compare-and-set - the status check lives in the UPDATE - so two
  concurrent reviewers produce exactly one decision and one conflict.
  Marketplace browsing no longer requires `accounting.read` (new
  `platform.browse` permission).
- **Reading support channel settings created secrets as a side effect (N08).**
  GET no longer lazily provisions the embed token and only admins receive it;
  changing auto-reply, greeting or rotating the token requires `iam.admin`,
  and the settings UI reflects the unconfigured and non-admin states.
- **Tests no longer run against the shared development database.** Every
  Vitest project now provisions its own throwaway database (migrated from the
  current branch's own migrations) in a `globalSetup` and drops it on
  teardown, so a branch that reshapes the schema can no longer break tests
  running from another branch. This is the root cause of the intermittent
  `products.test.ts` setup timeout and of `jobs.test.ts` failing with a raw
  SQL error against `documents`: the shared `chaste_os_v2` database had been
  migrated by out-of-branch work (37 applied migrations vs 35 in the repo; a
  `documents` layout with `content`/`lifecycle`/`visibility` that no migration
  on this branch produces). Against a fixture database the whole suite is
  green with no code changes. Opt out with `CHASTE_TEST_DB=1` to test against
  `DATABASE_URL` directly; that path now refuses to run when the target's
  applied-migration count does not match the branch's migration files (schema
  drift), and `CHASTE_TEST_KEEP_DB=1` keeps a fixture for debugging.
  (`@chaste/db` gains a `test-fixture` export and `runMigrations` accepts
  `backup: false` for fresh fixtures.)

- Switching app sections no longer scrolls page content behind the sticky app header; the tab rail now reveals the selected section horizontally.
- The floating mobile Workmate bubble no longer covers app cards when the app header already offers Ask workmate.
- Hidden mobile Workmate controls no longer intercept taps on app cards and actions.
- POS sell content now gives barcode search the first position, collapses optional customer lookup, prevents phone-width overflow, and keeps the focused next-scan field above the sticky checkout. The cart bar shows the full total, separates Review cart from Complete sale, and opens the line list on demand.
- POS split-payment rows now give each tender a readable full-width method selector on small screens, with the amount and remove action kept together. The sticky checkout explains whether payment allocation or cash received is short.
- The Products & Services catalog stacks its heading, import action, and search field on narrow screens instead of overflowing horizontally.
- Dialog rerenders no longer steal focus from text fields. Dialogs focus their first usable input without scrolling content under the sticky title, and descriptions now begin below the title without overlap.
- Dialog overlays now cover floating chat controls, keeping modal fields and actions clear on phones.
- Saving a CRM view now uses a focused review dialog with the active filter summary and matching customer count; on phones the filter panel collapses while saved filters remain applied.
- Customer name changes now update the CRM record through the governed profile capability and remain reversible with the original customer name in the audit snapshot.
- Coding-plan connection and MCP routes now use the Next.js 16.3 default Node runtime, which is compatible with this project's Cache Components configuration.
- Messages now loads the conversation list on entry and shows a recoverable error state if that request fails, instead of staying on the loading skeleton.

### Changed
- Added an opt-in Vite POS return dispatch through the Go `pos.returnSale` capability, with 404-only same-intent fallback and actor/org scoped exact retry recovery. Pending and uncertain returns keep their UUID and locked payload across reloads until completion or a definitive refusal.
- **Vite owns the main local app port.** The React preview now opens at `http://localhost:3000`; the legacy compatibility server runs at `http://localhost:3001`, and Vite proxies its remaining API routes there.
- **The desktop sidebar is less crowded.** Removed its two compact quick-action shortcuts; module actions remain available in the page header.
- **Document studio entry points are quieter.** Removed the editor and upload shortcuts from the Documents top bar; invoices now prefill their issue date using the local calendar date, and generated numbers or references across document templates are labeled as editable.
- **Built-in templates are code-owned.** Organizations that seeded templates under an older catalog automatically receive the redesigned papers on their next visit to Documents; custom templates are never touched.
- **Boards support direct stage movement.** Projects tasks and hiring candidates can now be dragged between status or pipeline columns, with visible drop targets and existing keyboard/touch controls retained as fallbacks.
- **Documents support direct folder filing.** Drag a document from the library onto any virtual folder, including Unfiled, with an immediate saved confirmation and the existing Organize action retained as a precise fallback.
- **Module headers stay usable on small screens.** Shared quick actions now wrap into a full-width mobile row, and section tabs wrap without clipping or introducing a stray scrollbar; desktop headers retain their compact horizontal layout.
- **Message composer controls share one input surface.** The paperclip, emoji picker, selected files, draft status, and send action sit together inside the composer border.
- **Local web development skips boot-time database migration by default.** The existing `pnpm --filter @chaste/db db:migrate` setup command remains the explicit schema step; set `AUTO_MIGRATE_ON_BOOT=1` when a local dev start should apply migrations.
- **Dark-mode stat cards use coherent semantic surfaces.** Accent, warning, danger, and success cards now switch to dark semantic fills and borders instead of retaining bright light-mode panels.
- **Authored documents retain their working context.** Document type, linked business record, virtual folder, and page settings now survive drafts, published versions, restores, and reopen flows.
- **Folders are first-class and tenant-scoped.** Empty and nested folders persist independently of documents, parent paths are real records, and rename or move operations update descendants atomically.
- **Dropdowns stop looking generic.** Every `<select>` in the app now shares
  one chrome: browser default chrome removed, a custom chevron, aligned
  padding, and the shared gold focus ring. A `Select` primitive lands in the
  UI kit so future dropdowns inherit it for free.
- **The floating AI bar can live on hover.** A new "Hover reveal" dock mode
  (now the default) keeps the bar out of the way until the pointer rests
  near the bottom edge of the screen: the bar rises into view, stays while
  you are using it or while the workmate is working, and hides again when
  you move away. A subtle handle at the bottom edge marks the trigger, it
  is reachable by keyboard (Tab reveals and focuses the input), and tapping
  elsewhere dismisses it. The previous always-visible bar remains available
  as the "Floating bar" dock choice in the workmate's preferences.
- **Humans act under their own authority (ADR 0055).** A permitted human
  executing an identity- or destructive-class action in the UI applies it
  directly, fully audited, instead of being asked to approve their own
  click in the Approvals inbox. Approval gates now target the workmate and
  system jobs: identity/destructive always, money above thresholds. Orgs
  can re-impose dual control for humans per risk class via the org policy
  rules (`requiresApprovalFor`), and the workmate's proposals still land in
  the inbox exactly as before.
- **The Approvals inbox and Event Ledger now say who acted.** Approval
  cards carry an actor chip ("agent · for <name>" vs "human · <name>"), and
  agent-driven ledger rows show the session they came from
  (`ledger_events.session_id`, a new indexed column, deliberately not part
  of the hash chain so old entries stay verifiable).

- **Module chrome rides the inked band.** Every module's header (breadcrumb,
  description, tabs, actions) is now the brand's dark cover plate: "Home /
  Accounting" is written large in paper and gold instead of an easy-to-miss
  grey whisper, with the tabs styled for the dark surface.
- **Icons match the notifications bell.** The shared icon base draws at the
  bell's stroke weight, so every icon across the rail, launcher, tabs and
  page bodies carries the same confident weight.
- **The dashboard keeps one attention list.** The separate "My work" card is
  gone; "Needs you" is the single queue (receipt remainders folded in) and
  the "Brief me" button lives in its header in the brand ink instead of grey.
- **One brand identity across the product (ADR-0054).** The gateway's warm
  paper + inked band + burnished gold palette is now the product-wide system:
  `stone-*` re-pointed to warm paper greys, the accent ramp renamed and
  re-pointed to `gold-*` (the `maroon-*` name is retired), and the four-theme
  picker removed from settings, the command palette and the rail - Light,
  Dark and System remain. The inked `#111416` band (masthead, login hero,
  setup header, support widget) is a brand constant in both modes; the auth
  pages are tokenized and drop the `.auth-surface` light-mode pin, so the
  gateway now follows the mode like every other page. Primary buttons are the
  gateway's ink style (inverting in dark mode), and `dark:` utilities now
  follow the attribute-based mode via a custom variant.
- **One color for app icons.** Every tile in the apps catalogue, the command
  palette, the app frame header, and the rail's pinned/recent apps renders in
  the single brand ink (`#111416` with paper icon) instead of per-app hues;
  rail icons moved to the same dark ink. (ADR-0054 continuation.)
- **No em dashes anywhere.** All 1,251 em dashes across docs, source
  comments, and UI copy were replaced with hyphens, and `AGENTS.md` now
  instructs agents never to write them.

- **Auth and onboarding first impression.** Reworked the first-run surfaces around
  the Chaste black, ivory, and champagne-gold identity with a responsive split auth
  composition, orbital brand mark, reduced-motion-safe entrance motion, persistent
  onboarding status header, glowing linear-gradient progress bar, and clearer
  recovery copy while preserving the existing setup paths and governed API flow.
- **sign-in is sealed until the email is verified; unverified sessions
  inherit nothing (N03).** Domain identities are pre-provisioned (SCIM,
  invitations) and bind by email, so a password sign-up for that email used
  to walk straight into memberships without owning the mailbox. Sign-in now
  requires verification (the link is re-sent on each sign-in attempt), and
  an unverified session resolves to a bare identity - no memberships, no
  permissions - until the address is verified or proven by a trusted IdP.
  Existing unverified accounts receive a fresh verification email at their
  next sign-in attempt.

- CRM forecast assumptions now show every stage rate, and monetary inputs use the workspace currency.
- CRM profile and bulk changes run through reversible, audited capability actions; duplicate matches remain review suggestions and are never merged automatically.
- POS preserves a cart when a sale fails or needs approval, prevents closing a register with an open cart, and labels drawer totals separately from cash sales. Returns now request approval with an audited reason.
- POS stores explicitly queued offline sales on the device, marks them as unposted, and lets staff review and send them after reconnecting with an idempotent retry identity.
- POS checkout blocks register actions while offline and explains that saved carts require a connection before posting. Loyalty points are shown as unavailable until the workspace configures a program.
- Document match counts are presented as lexical evidence, not confidence percentages; the review view explains when the parser does not provide extraction confidence.
- Mobile CRM, POS, and document lists use cards so key values and actions stay in view.
- Mobile app sections use visible, horizontally scrollable tabs again, and narrow app headers wrap action buttons instead of overflowing the page.
- CRM customer filters and create/import actions fit 320px screens without horizontal scrolling, and saved-view creation stays closed until requested.
- Empty Products & Services catalogs point to add and spreadsheet-import actions instead of reporting stock as healthy.

## [0.5.0] - 2026-09-09

M7–M13 had been accumulating under `[Unreleased]` since 0.4.0 while
`package.json` still read `0.2.0`, so nothing in the repository named the
version it was actually on. This release closes that gap and, on the way,
puts tests around the two surfaces a new business touches first: the setup
wizard and the spreadsheet import.

### Added
- **Tests for the CSV importer and the setup wizard**: 140 tests covering
  `lib/csv.ts` (RFC 4180 quoting, line endings, ragged rows, header
  guessing), `lib/onboarding-flow.ts`, `components/onboarding/wizard.tsx`,
  and the shell app/module catalogs. The wizard's decisions - which screen
  comes next, whether a profile may be submitted, how a failure is explained
  - now live in `lib/onboarding-flow.ts` so they can be tested without
  rendering React; the component tests then drive the real wizard through its
  flows, including the one where a skipped step comes back. `jsdom` and
  `@testing-library/react` are new `apps/web` dev dependencies, and
  `pnpm-lock.yaml` is regenerated with them.
- **Retail & reach (M13, ADR 0040)**: `pos.returnSale` - always-gated
  full-sale reversal that refunds through a mirrored entry, credits the
  invoice, and restores stock; per-register shift summaries; marketing-lite
  with saved deterministic segments, campaigns, opt-out honored at send
  time, and the append-only send log as the analytics - no tracking pixels
  (`pnpm demo:m13 [shifts|marketing]`).
- **Front ends for every shipped capability**: POS page gains a Return
  action on recent sales (202 → approvals-inbox state) and a shift-summary
  card (takings, expected vs counted cash, variance); new Marketing page
  (segments, campaigns, send log) at `/marketing` with `/api/marketing`;
  new Projects board page at `/projects` with `/api/projects` plus an
  Expenses tab on the HR page consuming the existing expense-claims API;
  new "Cash & collections" tab on Accounting (13-week cash forecast,
  reminder drafts, customer statements) and "Prices & statements" tab on
  Purchasing (supplier price history, supplier statements).
- **Understanding layer (M12, ADR 0039)**: `analytics.explainChange`
  decomposes a revenue change across customers or products with exact,
  property-tested contributions and drill-to-invoice ids;
  `analytics.askYourBusiness` composes cited extracts and signals ending
  in a proposed governed action; helpdesk tickets gain numbers,
  priority/category/SLA fields, canned responses, KB articles, rules-first
  category drafts, and SLA-breach signals; documents gain folders,
  business-record links, append-only version history, and expiry signals
  (`pnpm demo:m12 [decompose|ask|tickets|documents]`).
- **People, projects, expenses (M11, ADR 0038)**: employee structure
  (department/position/manager/emergency contacts), attendance clock-in/
  clock-out on time entries with late flags and chronic-lateness signals,
  derived leave balances and calendar; recruitment-lite (openings →
  applicants → stages → hire converts to employee); manufacturing planning
  lite (can-we-produce-N with BOM-explosion arithmetic and producible
  ceiling, work centers, lead-time estimates); a standalone projects module
  (kanban tasks/subtasks, assignment, priorities); expenses depth
  (rules-first categories, receipts via the documents seam, per-category
  policy limits raising signals, duplicate-claim detection)
  (`pnpm demo:m11 [hr|projects|flow]`).
- **Accounting & purchasing depth (M10, ADR 0037)**: direct-method cash
  flow statement derived purely from the ledger with a built-in tie check;
  always-gated AR/AP credit notes as reversal-style documents on immutable
  credited columns; payment terms (net-days) driving invoice and bill due
  dates; customer and supplier statements with running balances;
  deterministic reminder drafting with opt-out delivered over the
  messaging seam; supplier memory from receipts (lead time, on-time rate,
  fill rate, price history); purchase close-with-backorder flag and
  ledger-true returns; 13-week cash forecast; duplicate-payment signals
  (`pnpm demo:m10 [cashflow|creditnote|statements|reminders|supplier|forecast|duplicate]`).
- **Sales orders + fulfillment (M9, ADR 0036)**: `modules/sales` with
  reservation-anchored orders - confirming checks the customer's credit
  headroom (`customers.creditLimitMinor`) and reserves stock; delivery
  consumes reservations, writes the stock leg through the shared writer,
  and invoices exactly what shipped via the shared posting path;
  oversell is refused, `allowBackorder` reserves what exists and flags
  the order, cancellation releases untouched reservations
  (`pnpm demo:m9 [fulfillment|credit]`).
- **Quote expiry (M9)**: `quotes.expires_at` with expiry-refusing
  acceptance, an idempotent `accounting.expireQuote` sweep, and an
  expired-quote signal suggesting the governed decline.
- **CRM depth (M9)**: `crm.convertLead` (creates/attaches the customer,
  qualifies the deal), deal `source`/`ownerUserId`/`lostReason`, tasks
  with due dates feeding red overdue-task signals, and deterministic
  duplicate detection in `erp-core` (property-tested) that warns on
  `crm.createCustomer` without ever refusing.
- **Customer 360 (M9)**: `crm.customerTimeline` merges invoices,
  payments, quotes, deals, and tasks into one reverse-chronological feed.
- **Needs-attention signal registry (M8, ADR 0034)**: modules contribute
  deterministic signals (inventory reorder pressure, dead stock, anomalous
  adjustments; overdue receivables; stalled deals) through injected
  producers; `signals.list` aggregates them red-first with evidence and
  suggested governed actions; `/api/signals` and the home dashboard's
  needs-you queue consume the same feed; a failing producer degrades to
  missing signals, never a broken dashboard.
- **Reorder intelligence (M8)**: deterministic orderpoint math in
  `erp-core/reorder.ts` (average demand, variability, safety stock by
  service level, reorder point, target, suggested quantity, days of
  cover) with property and golden tests; `buildReorderPlan` composes the
  purchase proposal; the agent narrates the arithmetic, never computes it.
- **Governed reorder loop (M8)**: signal → plan → policy-gated PO draft →
  human approval; decline is audited and creates nothing
  (`pnpm demo:m8 [signals|reorder-approve|reorder-decline]`).
- **Composition conformance (M8, ADR 0035)**: the module gate is surfaced
  to capabilities via `ctx.services.moduleGate`; POS sales degrade
  gracefully with Inventory disabled (money posts, no stock legs); subset
  matrix + degradation tests guard it. Org policies now resolve by
  specificity - the most specific matching pattern wins, ties resolve to
  the stricter cap, so the onboarding blanket rule can be tightened per
  module without loosening anything.


- **Inventory → GL closure (M7, ADR 0033)**: `inventory.postValuationSummary`
  reconciles the GL inventory account (1200) to the stock ledger's
  moving-average value with one balanced entry against COGS; money-class
  with fail-closed human approval, idempotent no-op when already
  reconciled, single-use reversal via `inventory.reverseValuationSummary`.
  Reconciliation math is pure and property-tested (`erp-core/gl.ts`).
- **Internal stock transfers (M7)**: draft → partial/confirm → reverse
  through governed capabilities; paired out/in legs on the shared ledger
  (reason `transfer`) conserve quantity across locations, and transfer legs
  are value-neutral in valuation replay so round trips cannot drift the
  moving average. Stock tab gains a transfers panel with tooltips.
- **Product surface (M7)**: items carry image URL, tags, and a barcode;
  `inventory.updateItem` (snapshot-inverse) and `inventory.lookupByBarcode`
  (honest null on miss); Products page gains image/tags/barcode inputs,
  thumbnails in the catalog, and explanatory tooltips on stock terms.
- **Demo proof**: `pnpm demo:m7 [reconciliation|transfers|products|all]`.
- **Z.ai (GLM) model provider**: `MODEL_PROVIDER=zai` routes agent turns
  through Z.ai's OpenAI-compatible endpoint (`ZAI_API_KEY`, `ZAI_BASE_URL`);
  `zai/` model prefixes are stripped like `groq/`. `resolveClient` now gives
  an explicit model prefix precedence over `MODEL_PROVIDER`, so one process
  can talk to a secondary provider per call. Settings → AI & Automation
  shows the provider and connection state.
- **Routines (Paperclip-style recurring agent runs, ADR 0031)**: a new
  `routines` module and table let a business schedule the agent in plain
  language ("every 30 minutes", "weekdays at 9am", "weekly on monday at
  09:00"; model-assisted normalization for anything else). Runs fire from
  the durable job queue (claimed `FOR UPDATE SKIP LOCKED`, schedule advanced
  at claim time, at-most-once), execute as headless, replayable agent
  sessions under a fixed least-privilege system bundle (org reads +
  `messaging.write`), stay silent on `NO_ACTION`, and surface findings as
  notifications. Each routine can own a secret webhook token:
  `POST /api/routines/webhook/:token` lets Paperclip, cron, or any external
  orchestrator trigger a governed run. New Settings → Routines tab (create
  from natural language, pause/resume, run now, delete, copy webhook URL)
  plus a daily heartbeat preset (OpenClaw-style proactive check).
- **Agent persona (SOUL)**: `organizations.agent_soul` holds standing,
  admin-editable persona instructions (Settings → AI & Automation → Agent
  persona), injected into every chat system prompt framed as preferences
  that cannot override security, approvals, or financial integrity.
- **`ask_user` clarification tool**: the agent can now ask the human one
  structured question instead of guessing or hallucinating. Kernel loop
  gains an `AskUserChannel`; the chat route streams an `ask` event; the chat
  UI renders a question card with tappable options and a free-text "Other",
  locks after answering, and the answer flows back as the next user turn.
  Questions are persisted to the trajectory so replays show them.
- **Live agent console in the chat dock**: while the agent works, the dock
  header shows "Step N/M · last-tool", and a console strip shows run state
  and cumulative token count; finished replies carry a per-turn token chip
  (input / output / % served from provider cache).
- **Message queueing and mid-run steering (opencode-style)**: messages typed
  while the agent runs are queued (visible, dismissible, auto-sent when the
  run settles) instead of silently dropped; `POST /api/chat/steer` injects a
  message into the running loop between steps, persisted to the trajectory
  as a steering event. The kernel loop drains steering via
  `getSteering()` each step.
- **Coding-agent detection, fixed and unified**: detection now scans PATH
  natively (the old `which`-spawn approach failed under an overridden PATH
  with ENOENT) and config dirs for opencode, Claude Code, Codex, Kilo Code
  (including its real binary and config locations), Aider (its config-file
  globs never matched before), and Gemini CLI, with version probing. The
  Creator-mode setup card lists every detected agent with versions and
  flags config-only installs; detection is unit-tested with fixture homes
  and fake PATHs (`scripts/gates/detector-positive-control.ts` is the live
  positive control).
- **Context-window-aware compaction**: the agent loop compacts when the
  transcript exceeds the model's context window minus a reserve
  (`MODEL_CONTEXT_WINDOW`, default 131072, reserve 24,576) instead of a
  fixed 24k budget, so larger-window models keep far more history; loop
  options `contextWindow`/`reserveTokens` and the legacy budget remain.
- **Routine-run observability**: routine runs create `Routine: <name>`
  agent sessions visible in Sessions, and the worker script (`pnpm worker`)
  now loads `.env` and actually runs - its import paths previously pointed
  at a nonexistent `./apps/...` location, so the queue never drained.

### Changed
- **Document memory indexing degrades to a zero vector**: `embedDocChunk` now
  inserts a content chunk with a zero-length embedding when the embedding
  service is unavailable (previously an embedding failure silently skipped the
  insert, so parsed documents produced zero searchable memory).
- **Demo and worker scripts load `.env`** (`--env-file-if-exists=.env` /
  shared loader), so the documented local proofs (`pnpm demo:*`,
  `pnpm worker`) work without exporting variables by hand.
- **Migration 0028**: `routines` table under standard tenant-isolation RLS,
  `organizations.agent_soul`, and pg_trgm adoption (below).
- **CI: fast lockfile pre-flight.** A new DB-free `lockfile` job fails in
  ~30s with the actual remedy when `pnpm-lock.yaml` drifts from the workspace
  manifests, instead of surfacing a bare `ERR_PNPM_OUTDATED_LOCKFILE` after
  Postgres is already up and migrations have run.
- **CI: secret scanning allowlists environment templates.** `.gitleaks.toml`
  permits `.env.example`, `.env.sample` and `.env.template`, which hold
  `KEY=` placeholders rather than credentials. Both the legacy `[allowlist]`
  and current `[[allowlists]]` keys are set, because CI pins gitleaks 8.24.3
  and only the legacy key is honoured by that version.
- **`main` is branch-protected.** The `verify` and `gitleaks` checks are
  required, branches must be up to date with `main` before merging, and force
  pushes and branch deletion are disabled.
- **Contributing: stacked-PR policy and PR template.** A stacked PR is not
  independently reviewable - its diff is the delta against its parent branch,
  not against `main`. The template now forces authors to declare the chain,
  and `CONTRIBUTING.md` documents how to keep a stack from rotting.

### Fixed
- **Version drift**: `package.json` said `0.2.0` while the changelog's latest
  release was `0.4.0`, so no file in the repository named the version it was
  on. The manifest now reads `0.5.0`, matching this entry. One gap is recorded
  here rather than invented: `v0.3.0` was tagged and released, but this file
  has no `[0.3.0]` section, so whatever shipped in it is described only in
  that release's own notes.
- **CSV: an inch mark no longer disappears**: `parseCsv` opened a quoted field
  on any `"`, so a product named `6" pipe` was imported as `6 pipe`. RFC 4180
  treats a quote as data unless it starts a field, and the parser now agrees.
- **CSV: "Unit Price" maps to the price**: `guessMapping` ran its substring
  pass per field, so `unitLabel` - declared before `salePrice` - claimed a
  "Unit Price" column on the strength of "unit" alone and left the price
  unmapped. Exact matches are now resolved for every field before any
  substring match runs, and short synonyms (`id`, `ean`, `upc`) match exactly
  only, so a "Paid" column no longer reads as an SKU nor a "Cleaner" column as
  a barcode.
- **Wizard: one rate limit no longer rewrites the next**: the failure mapping
  assigned back into its shared lookup table, so the first throttled
  request's countdown became the hint for every later `rate_limited` failure.
  The mapping is now a pure function of the response.
- **Provider prefix precedence**: `resolveClient` checked `MODEL_PROVIDER`
  before the model's `provider/` prefix, so e.g. `zai/model` silently routed
  to the env's provider; explicit prefixes now win.
- **Real server-side stop**: the chat route now wires the request abort
  signal into the kernel loop and model adapter, so Stop (or closing the
  tab) cancels the in-flight provider call instead of letting the loop run
  to completion invisibly.
- **`pg_trgm` adopted for memory text search (ADR 0032)**: migration 0028
  enables the extension and adds a GIN trigram index on `memories.content`,
  so keyword/ILIKE fallback search no longer sequential-scans.
- **`pnpm worker` was dead on arrival**: wrong relative imports meant the
  queue drained never; fixed (and env-loading added), verified end-to-end by
  the routines E2E gate.
- **`insertInvoiceWithPosting` was never exported** from `modules/accounting`
  (`TS2459`). It survived the life of its PR because CI aborted at
  `pnpm install` on a stale lockfile, so the typecheck never ran - a good
  example of a broken pipeline hiding a real defect rather than just being
  noisy.
- **Inventory posting-seam lint rule restored**: `eslint.config.mjs` listed
  `inventory` in the wrong `no-restricted-imports` group, rejecting
  `@chaste/module-accounting/posting` imports. Because the milestone branches
  were siblings rather than a chain, the fix made in M7 never reached
  M8–M13; the stack was rebuilt as a true linear chain (each branch's parent
  is the branch below it) so the boundary now holds everywhere.
- **`pnpm-lock.yaml` regenerated on seven branches**: workspace dependencies
  had been added without it, so `pnpm install --frozen-lockfile` aborted CI
  before lint, typecheck, or tests ran.

## [0.4.0], 2026-08-26

### Added
- **Tabbed app framework (`AppFrame`)**: every business app now opens into a
  shared frame - breadcrumb, app identity, underline tabs with live counts.
  Tabs persist per app (`persistKey`) and initialize from `?tab=` for
  deep-linking; writes `chaste-app-tab:{key}` to localStorage. CRM, Settings,
  POS, Inventory, Purchasing, Manufacturing, Documents, Support, Analytics,
  Messages, and Proposals all adopt it; Products, Sales, HR, and Accounting
  gain tab counts and persistence.
- **Overview dashboards**: CRM, POS, Inventory, Purchasing, Manufacturing,
  Documents, and Support each open on an operational overview (KPI stat
  cards, needs-attention lists, recent activity) derived from live data;
  operation surfaces live in tabs.
- **CRM pipeline drag-and-drop**: deal cards drag between stages (HTML5 DnD)
  with optimistic moves, rollback on failure, and an `aria-live` status
  region for screen readers; keyboard paths (Advance / Mark lost / Reopen)
  are preserved. Every move flows through the governed `crm.moveDealStage`
  capability.
- **Settings rebuilt as four tabs**: Appearance (mode, themes, pinned apps),
  Workspace (org, modules, email/SMTP), Localization (display currency,
  metric/imperial units, date format, week start - persisted per device via
  the new `chaste-prefs` store), and AI & Automation (new `GET /api/ai-config`
  honestly reflecting provider, endpoint, and model configuration from the
  server environment; API keys never reach the browser).
- **Device-local preferences** (`lib/prefs.ts`): `usePrefs()` hook with
  pub/sub sync, `CURRENCIES` constant (USD/KES/EUR/GBP/TZS/UGX), and
  `formatMoneyIn(code, minor)` for currency-aware display.
- **Meridian is the default theme** for new devices.

### Changed
- **Dashboard fits one desktop screen**: the ledger band compacts (tighter
  paddings, chart drawn inside the band), setup shows the first two steps
  with "Show N more" expandable, the ledger feed trims to three entries, and
  the body reflows into three columns (needs-you · working capital ·
  operations & ledger) on wide screens. Mobile keeps its natural scroll.
- **Dashboard redesign ("the bookkeeper's cover page")**: the home screen
  opens with a deep ledger band - net income set as a cover figure over fine
  ruling, revenue/expenses/cash inline, and the income-vs-expenses trend
  drawn as a smooth SVG area chart inside the band (theme-aware via `--band`
  tokens). Below it the paper body is re-set: setup steps as a quiet card,
  the needs-you queue as whole-row links, working capital and pipeline in
  bordered ledgers, and a staggered entrance that respects reduced motion.

### Fixed
- **ThemeMenu hydration mismatch**: replaced direct DOM read
  (`document.documentElement.dataset.mode`) with the `useMode()` state
  during render, eliminating the server/client HTML mismatch that triggered
  a full client-side tree regeneration.
- **Theme hydration flash**: the pre-paint theme script now runs with
  `suppressHydrationWarning` on `<html>`, ending the React hydration console
  error on every page.
- Dev server picks the next free port when 3000 is occupied.

### Added
- **Guided setup ("what is expected of me")**: `GET /api/setup` computes a
  live checklist per organization - products, customers, vendors, team,
  email, website widget, Creator-mode agent - each item with a one-sentence
  "why", done-state computed from real data, and a take-me-there link.
- **Creator-mode coding-agent wizard**: `GET /api/creator/agent` detects
  installed coding CLIs (Claude Code, Codex CLI, Gemini CLI) read-only on
  the server PATH. The Proposals page shows a connected badge or a
  three-step install/auth wizard with copyable commands.
- **Product sale prices & archiving**: items carry a default sale price
  (`sale_price_minor`) exposed through `inventory.stockReport`; governed
  capability `inventory.archiveItem` retires products without destroying
  history. Products app gets a sale-price field, catalog column, per-row
  archive; Sales quote form gets a product picker.
- **Customer care inline customer create**: the new-conversation dialog can
  create a missing customer on the spot and continue.
- **Products & sales test coverage**: new end-to-end suite
  (`products.test.ts`) covering catalog creation, duplicate-SKU rejection,
  archive/restore semantics, quote totals, accept-converts-to-invoice with
  balanced-posting assertion, double-convert race safety, and terminal
  decline.
- **Purchasing workflow (request → approval → RFQ → award)**: new
  `purchase_requests` and `rfqs` tables plus governed capabilities -
  `purchasing.createPurchaseRequest`, `purchasing.decidePurchaseRequest`,
  `purchasing.createRfq`, `purchasing.recordQuote`,
  `purchasing.selectWinningQuote`, and the read-only
  `purchasing.listPurchaseWorkflow`.
- **@mentions in internal messaging**: messages carry explicit mentions
  (`messages.mentions`); `messaging.listPeople` lists mention targets;
  mentioning a colleague sends a notification. Messages composer has a
  type-`@` picker with keyboard navigation.
- **Dark mode**: proper tri-state toggle (Light / Dark / System) in the rail
  and Settings → Appearance. Dark themes per palette, `bg-white` surfaces
  invert globally, and a pre-paint bootstrap applies the stored preference
  with no flash.
- **Digital clock** in the workspace chrome: quiet live HH:MM:SS at the
  bottom of the desktop rail and in the mobile top bar, hydration-safe.
- **Bank feeds & reconciliation** (Accounting → Bank tab): bank accounts
  and imported statement lines with governed capabilities for import, match,
  exclude, and delete; `/api/banking` route; paste-CSV feed import and
  payment-match flow.
- **Sales tax filing** (Accounting → Tax tab): `accounting.salesTaxReport`
  and `accounting.fileSalesTaxReturn` with overlap rejection and reversal
  support.
- **Console tabs** (follow-up to ADR 0030): co-worker panel identity header
  with New / History / Preferences tabs; composer footer with send/newline
  hints and a creator chip.
- **Pinned apps**: pin up to five favorites from the launcher or Settings;
  pins appear on the workspace rail under a hairline divider.
- **Settings application** (`/settings`): appearance, pinned-app manager,
  and workspace facts linking to Team & roles and the session log.
- **Rail affordances**: every rail icon shows a styled hover/focus tooltip
  with keyboard hints; active interface marked by an accent notch.
- **Governed analytics module** (ADR 0029, `@chaste/module-analytics`):
  five read-only dataset extractors, Arquero frame-op layer, and
  `analytics.renderReport` composing narrative text, SVG charts, and tables
  into a downloadable HTML document.
- **Full CRM surface**: "Pipeline" is now "CRM" with two tabs - Customers
  (list, create, soft-deactivate) alongside the existing deal pipeline.
- **Boot-time auto-migration with pre-migration snapshots**: the web server
  applies pending Drizzle migrations at startup, serialized by advisory lock,
  with `pg_dump` snapshots for rollback.
- **Next.js 16.3 agent tooling** (ADR 0027): bundled docs, `.mcp.json`
  wiring, `agent-browser` CLI, and official Skills committed.
- **Cache Components adoption, incremental pass** (ADR 0028):
  `cacheComponents: true` validated by `next build`.
- **Official Next.js Skills** committed at `.agents/skills/`.
- **Manufacturing module split** (`modules/manufacturing`, ADR 0026): full
  production lifecycle - work orders, multi-level BOMs with scrap, cost
  previews, run reversal, lot traceability.
- **Inventory module surface**: stock history, available-to-promise,
  reservations, cycle counts, locations, lot balances, valuation.
- **Purchasing UI** (`/purchasing`): vendors, purchase orders, goods
  receipts, vendor bills (three-way match), partial/full bill payments,
  AP aging.
- **Customer care agent module** (`modules/support`, ADR 0025): support
  conversations, draft-only AI reply flow, escalation, 11 regression tests.
- **Security hardening pass** (ADR 0024): session ownership checks,
  marketplace publisher ownership, least-privilege job workers, rate limiting,
  conversation membership enforcement, prompt-injection guard, 7-day approval
  expiry, security headers, and low-severity fixes.
- **Durable capability-job queue**: `jobs` table with FOR UPDATE SKIP LOCKED
  worker (`pnpm worker`), executing through the governed KernelExecutor path.
- **Governance eval harness v1**: six golden agent trajectories asserting
  harness invariants against a scripted model adapter.
- **Cash-basis view + formal year-end close (ADR 0019)**:
  `accounting.cashBasisReport` and `accounting.closeYear`.
- **BOM-lite**: `bom_lines` table, `explodeBom`/`checkAvailability` pure
  functions, and governed capabilities for define/produce/report.
- **Email notifications** behind `NotificationSink`: SMTP fan-out for
  approval requests and tickets.
- **Signed plugin distribution + marketplace (ADR 0018)**: `@chaste/plugin-kit`,
  ed25519 signatures, `creator.verifyPlugin`/`publishListing`/`installListing`.
- **Creator Mode scaffolding generator**: `creator.scaffoldCapability` emits
  capability source, test skeleton, and risk-assessment doc.
- **RLS everywhere (ADR 0017)**: policies on all 46 tenant tables with
  probe tests under NOBYPASSRLS.
- **SSO + SCIM groundwork**: `sso_connections` table, admin CRUD, SCIM 2.0
  provisioning at `/api/scim/v2/Users`.
- **Trajectory compaction + KV-cache metrics**: token-budget folding and
  `/api/metrics` cache hit-rate dashboard.
- **OpenRouter model support**: `MODEL_PROVIDER=openrouter` with automatic
  NIM fallback on rate limits.
- **Org memory retrieval (ADR 0016)**: `documents.searchMemory` semantic
  top-k over pgvector with text-search fallback.
- **Natural-language task suite** (`pnpm nl:test`): 31 plain-language tasks
  driving the real app end-to-end with per-tier scoring.
- **Friendly error layer**: `lib/api.ts` maps every API failure to a calm
  headline + actionable hint with collapsible technical details.
- **Design system + console redesign (ADR 0015)**: brand dark-maroon accent,
  warm-stone neutrals, Tailwind v4 `@theme` token layer, component kit
  (`components/ui.tsx`), inline SVG icon set, grouped sidebar shell, ⌘K
  command palette, split-screen branded login, full responsive to 375px.

### Changed
- **OS navigation model** (ADR 0030): five-group ERP sidebar replaced by
  workspace rail + full-screen Apps Launcher with type-to-filter and
  keyboard grid navigation.
- **Application frames and tabs** (`_shell/app-frame.tsx`): applications
  open at an Overview with breadcrumb and operation tabs.
- **Four designed color themes**: Chaste, Graphite, Verdant, Meridian -
  switching re-skins the entire product via Tailwind v4 token architecture.
- **Command-center dashboard**: financial pulse, "Needs you" triage queue,
  working-capital figures, pipeline shape, operations signals, event ledger.
- **Redesigned authentication and onboarding**: ledger-ruled burgundy panel
  with Governed/Auditable/Reversible proof points.
- **Manufacturing split out of inventory** (ADR 0026): BOM/production/
  work-order capabilities under `manufacturing.*` namespace.
- **Capability output contracts renamed for clarity**: `reservedThousandths`,
  `expectedGoodThousandths`, `postedVariances`, `reversedMovements`.
- **Structured logging seam**: zero-dependency JSON kernel logger.
- **Model-call resilience**: typed `ModelProviderError`, exponential backoff.
- **Registry cached per process** instead of per request.
- **RLS wired into every capability transaction**: 19 module transaction
  sites through `withOrgContext`.
- **One posting service**: `@chaste/module-accounting/posting` replaces four
  divergent private period guards.
- **Next.js 15.5 → 16.3.2**: Turbopack default for dev and build.
- **AI co-worker dock** reachable from the rail; visual language follows
  theme tokens.
- **Main content width** widened to `max-w-7xl`.
- ARCHITECTURE.md tech table updated to reflect actual shipping stack.
- CI gains gitleaks workflow; `.env.example` cleaned up.

### Removed
- `_shell/nav.ts` (sidebar navigation tree) - superseded by the application
  catalog in `_shell/apps.ts`.

### Fixed
- **ThemeMenu hydration mismatch** (see above).
- **Theme hydration flash** (see above).
- Accounting's year-end close lives behind its own confirmation dialog.
- **Fresh-install migration chain repaired**: `0019_cheerful_spyke` RLS
  policy on `quote_lines` referencing a nonexistent `org_id` removed.
- **Migration tooling integrity**: `0021` Drizzle snapshot reconstructed.
- **Shadow timestamp columns broke FX rate posting (critical)**: four schema
  fields with `createdAt()` hardcoded `created_at`; real column names now.
- **Capability input schemas with `z.date()`/`z.coerce.date()`** now take
  ISO date strings.
- **BOM explosion stopped at level one**: sub-assemblies now reach real leaves.
- **Work-order completions**: now partial-aware with plan-exceeded refusal.
- Cycle-count posting no longer accepts an empty sheet.
- **Approval double-execution race (critical)**: atomic gate claiming with
  concurrency regression suite.
- **Event-ledger hash chain can no longer fork (critical)**: transaction-
  scoped advisory lock on chain-head reads/writes.
- **Money gating is fail-closed**: declared `Capability.moneyAmount(input)`
  extractor replaces the field-name heuristic.
- **Kernel verifies claimed approvals**: `ApprovalFlow.verify()` confirms
  org, capability, status, and canonical payload match.
- **Postgres connection exhaustion under dev**: bounded pools cached on
  `globalThis`.
- **Channel creation rejected for owners**: kernel matcher replaces direct
  permission check.
- Model-provider 429s surface a retry hint.
- **Email/password sign-up broken**: `auth_account.issuer` column added.
- Fresh databases: pgvector extension now enabled in initial migration.
- Migration journal timestamps for 0025+ no longer silently skipped.
- Unfinished WIP: missing `tsconfig.json`, unresolved imports, type errors,
  missing drizzle snapshot for migration 0024.
- Dev server picks next free port when 3000 is occupied.

### Added
- ADRs 0015–0030 covering design system, org memory, RLS, plugin kit,
  trust-spine hardening, multi-currency, ledger partitioning, creator-mode
  sandbox, support module, security audit remediation, OS navigation model,
  cache components, and Next.js agent tooling.

## [0.2.0], 2026-08-22

The v2 capability-kernel rewrite of the entire platform, replacing the
archived v1 codebase. Shipped in four batches:

### Added

**Foundation and trust spine**

- Monorepo scaffold: Turborepo + pnpm, TypeScript strict, Next.js 15 app.
- `packages/kernel`: governed capability pipeline (validate → authorize →
  policy gate → execute → audit), hash-chained event ledger, streaming-capable
  agent loop, honest-gap ticket filing.
- `packages/db`: Postgres schema with pgvector-backed org memory.
- `packages/ai`: NVIDIA NIM adapter with tool-call protocol preservation,
  embeddings, coding-agent detection.
- Live proof demos (`pnpm demo:*`) as executable specifications.
- M1 trust spine: approval inbox (approve→execute under human authority,
  reject with audit), hash-chain ledger viewer, per-org policy engine,
  onboarding wizard (business description → seeded chart of accounts +
  embedded org memory), better-auth email/password with domain-user mirroring.
- First vertical slice proven end-to-end: customer → invoice → GL posting →
  gated payment → human approval → balanced trial balance (`pnpm demo:slice`).
- Accounting module: journal entries/reversals, period close/reopen
  (destructive-gated) with closed-period posting guards, AR aging,
  trial balance.
- CRM basics: customers with soft-delete inverses.

**Domain depth**

- POS-lite (`modules/pos`): register sessions with opening float,
  atomic cash/card sale capability (invoice + payment + GL posting),
  drawer counting with variance flagging, closed-session guard,
  `/pos` console with register history.
- CRM pipeline depth: deals across six stages, weighted forecast by stage
  probability, `/crm` kanban with advance/lose/reopen actions.
- Session replay UI (`/sessions`): full trajectory viewer over persisted
  session events, user/assistant/tool-call/tool-result in order.
- Kernel loop emits `tool_result` events so replays show outcomes.
- Report pack: P&L + balance sheet as pure functions in `erp-core`
  (property-tested accounting equation) with UI cards on `/accounting`.
- AP subledger (`modules/purchasing`): vendors, bills with per-line expense
  coding, threshold-gated bill payments, AP aging, pay-in-full UI action.
- Internal messaging: channels/DMs, agent participation via capabilities,
  auto-reply in agent-enabled conversations.
- Streaming chat UX: token-level NDJSON streaming from the model through the
  kernel loop, tool-call activity chips, progressive rendering.

**Governance hardening**

- Capability conformance system: `assertWellFormedCapability` rejects
  malformed capabilities at registration; `registry.validateAll()` runs at
  boot (missing inverse targets are fatal, missing inverses are warnings).
  6 new kernel tests.
- `docs/adr/`, architecture decision records with index.
- Webhook notification seam (`NOTIFICATION_WEBHOOK_URL`) for approval
  requests and filed tickets.

**Teams, inventory, purchasing depth, Creator Mode**

- **Teams & RBAC**: invitations with token acceptance, multi-membership with
  per-session active-org cookie, role editor UI driven by the live permission
  catalog, identity-class gating on every authority change, and an approvals
  inbox filtered by what each member may actually decide.
- **Inventory**: append-only stock ledger (`recordStockMovement` shared
  writer), items with SKUs and reorder points, stock report with reorder
  alerts; POS sales decrement stock in the same transaction and refuse to
  oversell.
- **Purchasing depth**: purchase orders with lines linked to stocked items,
  goods receipts that feed both order status and stock, and classic three-way
  matching (order ↔ receipts ↔ bill) with quantity, cumulative-billing, and
  ±2% price-tolerance checks.
- **Creator Mode**: `platform.creator` permission gates a chat mode where the
  agent files platform-change proposals (diff, test evidence, risk assessment)
  as governed artifacts; humans approve or reject on `/proposals`; nothing
  merges automatically.
- GitHub Actions CI: migrations, typecheck, lint, unit tests, web build, and
  demo proofs when an NVIDIA key secret is present.

### Fixed

- Policy engine: money risk is now threshold-governed instead of blanket-
  capped by autonomy rank (an $11.50 coffee sale previously required
  sign-off). See ADR 0005.
- Property tests surfaced and fixed a double-negated revenue sign in the
  balance sheet computation.
- Inverse declarations completed for `accounting.createInvoice` and
  `purchasing.createBill`; removed a dishonest self-inverse on
  `crm.moveDealStage`.
- POS drawer math: `expected_cash_minor` NULL default made cash sales
  invisible to reconciliation (`NULL + x = NULL`); column now defaults 0.
- Migrations path broke under directories containing spaces
  (`new URL().pathname` URL-encodes); now uses `fileURLToPath`.
- Moving-average inventory cost stored as a rounded integer compounded
  rounding error; value is stored exactly and average cost derived.

---

## Changelog, v1 archive (superseded by the v2 rewrite)

The original v1 codebase was replaced by the capability-kernel rewrite.
Its history is preserved below and on the [`v1-archive`](https://github.com/benaiah-muga/ChasteBusinessOS/releases/tag/v1-archive) tag; version numbering above resumes from v1's 0.1.0.

<details>
<summary>v1 changelog (2026-07-16 &rarr; 2026-08-19)</summary>

## [Unreleased] (v1, archived)

### Added

- **Frontend chat consumption of the AI chat API (`apps/web`, `packages/ui-schema`,
  `packages/api-client`).** Verified end-to-end through the real browser UI
  (`agent-browser` driving `http://localhost:3000` against the live API):
  - `ChatWidget` now renders the `progress` part (live narration for auto-executed
    plans/single commands) instead of dumping raw JSON, and renders the dormant
    `form`, `button_group`, and `inbox_prompt` parts as readable summaries
    (chat only carries message/confirm/cancel today, so they are deliberately
    non-interactive until a submit path lands).
  - `explanation` now surfaces `plannedCommand`/`plannedInput` ("Planned: ...") for
    explainability, alongside the existing policy-used line.
  - Unknown/forward-compatible parts render as a collapsible "Unsupported part"
    disclosure instead of a raw JSON `<pre>` dump in the log.
  - UI-driven NL flows verified: token login → sign out → re-login; read/table
    answers; write → `confirm_action` card → Confirm → executed result table;
    natural-key gate (re-asking to create Kampala Flour Mills yields no
    confirm card, "already on file"); clarify when input is ambiguous.
- **Generative UI research + verdict (`docs/research/2026-08-19-generative-ui-assessment.md`).**
  The 13-part UiPart registry is runtime generative UI in its safest form (closed,
  Zod-validated component registry, "tools are components"); free-form LLM-authored
  React is not adopted (OWASP LLM01 / malicious AI-generated code, auditability,
  driver-verifiability). Recommended next steps: wire `form`/`button_group`/
  `inbox_prompt` to governed submit paths rather than a new framework.

- **Deterministic analytics / replenishment / data-quality / dashboard intents
  (`@chaste/ai-core` `orchestrator.ts`, research doc §Analytics, §Inventory,
  §Onboarding).** All 18 research-doc NL requests now behave correctly over
  `POST /api/v1/ai/chat` (verified end-to-end by `apps/api/src/nl-driver.ts`,
  a dynamic HTTP driver that sends each request through the same command/query
  bus a human uses and approves parked `confirm_action`s):
  - `planDataQuestion` + `answerDataQuestion`, margin trend ("why did margins
    fall this month?", "compare to last quarter"), sales grouped by location
    ("show this by branch", "show monthly sales by branch"), and stockout-risk
    proposals ("inventory is getting low; handle replenishment") are answered
    deterministically from the read-query bus (no LLM object dumps).
  - `planSingleSegment` gains deterministic parsers for import/data-quality
    rules (`core.importRule.create`: "treat blank tax IDs as unknown",
    "split full name into first and last name", "these two supplier columns are
    the same supplier") and the deictic dashboard save ("turn this into a
    dashboard" → `core.dashboard.create` with a deterministic default widget).
  - Compound read+schedule requests ("show monthly sales by branch and
    schedule this every Monday") now answer the read and still park the
    recurring watch-rule confirmation in the same turn.
- **`explanation` parts carry `plannedCommand`/`plannedInput`
  (`@chaste/ui-schema`, `@chaste/ai-core` `explanation.ts`)** so clients and
  evaluators can verify exactly which command/query ran (explainability).
- **Deterministic company-operations intents (`@chaste/ai-core`
  `orchestrator.ts`).** A second end-to-end NL suite, `apps/api/src/nl-driver-ops.ts`,
  15 requests across procurement, inventory, sales, invoicing, accounting,
  finance, and reporting, now resolves correctly over `POST /api/v1/ai/chat`
  (15/15, exit code 0). Each write's real effect is re-checked through the
  query bus, not just card presence:
  - **Operational writes with name→id resolution**, `pur.po.create`
    ("raise a purchase order for 60 bags of Wheat Flour from Kampala Flour
    Mills", deterministic `PO-YYYY-NNNN` numbering), `inv.stock.adjust`
    (goods-receive `+N`, spoilage `−N`), `acc.journal.post` ("debit Expenses
    800,000 and credit Cash 800,000", balanced lines), and
    `acc.invoice.create` with a resolved customer ("to Ntinda Supermarket",
    comma-separated amounts). New `hydrateEntityRefs` resolves vendor/product/
    warehouse/customer/account names to ids through the same read-query bus a
    human uses, so the AI never invents a foreign key, an unknown name yields
    a clear `ENTITY_NOT_FOUND` message instead of a bad write.
  - **Operational reads**, purchase orders, stock levels (optionally scoped
    to one warehouse), the customer list, outstanding/overdue receivables, and
    the monthly expense trend, plus location-filtered sales ("sales for the
    Jinja branch") and this-month-vs-last-month margin comparison. All answered
    from the read-query bus with a verifiable `plannedCommand`.
  - **Dashboard with a named subject**, "create a dashboard for our stock
    levels at Ntinda" → `core.dashboard.create` with an `inv.stock.list`
    widget and a real name.
  - **Read/write disambiguation**, read intents no longer shadow write
    messages ("raise a purchase order…" stays a write; "create a dashboard for
    our stock levels…" stays a dashboard create).
- **`nl-driver-ops.ts` verifies data, not just intents**, after approving a
  parked `confirm_action`, the driver re-queries the bus and asserts the actual
  state change (stock quantities, PO count/vendor, resolved invoice customer,
  expense total, dashboard record), so a "passing" write is proven in the
  database, not just in the chat log.
- **Native business-tool agent loop (`@chaste/ai-core` `providers.ts`,
  `orchestrator.ts`).** For providers with native function calling, the LLM now
  discovers and calls the permission-filtered business bus directly as OpenAI
  `tools`, one tool per command/query (143 bus registrations across 13
  modules, rendered via the existing `buildToolsFromBus`/`listForActor`
  surface), with the same Zod schemas, permissions, and request context as a
  human, so AI/manual parity is preserved:
  - `CompletionRequest.tools/toolHistory` + `CompletionResult.toolCalls` and
    the `AiProvider.toolCalling` capability flag; `OpenAiCompatibleProvider`
    sends `{type:"function",function:{...}}` tools with `tool_choice:"auto"`,
    parses `message.tool_calls`, feeds results back as `tool` messages, and
    raises `max_tokens` to 4096 when tools are present (muse-glimmer-30b emits
    `reasoning_content` + tool calls). `TracedProvider` forwards the capability.
  - `runBusinessToolLoop` (cap 10), the model chains read tools to resolve
    names → ids, then calls a write tool. Write calls dispatch only when
    `commandMayAutoExecute(deps.autonomy, meta)` permits (guarded_auto +
    `minAutonomyForAuto`); otherwise they park as `PendingPlanStep` confirm
    cards (single → `confirm_action`, multiple → multi-step plan) hydrated via
    `hydrateEntityRefs`, exactly like a deterministic plan. `full_autonomous`
    writes are denied unless `allowFullAutonomous` is on.
  - Read-then-narrate answers and a final "narrate pass": when the model stops
    calling tools it may answer in prose from the data it gathered; a
    duplicate-call or budget-exhaustion guard asks the model to answer from
    gathered data (falling back to a rendered summary) instead of returning a
    null response. A double-write guard filters writes the loop already
    dispatched from any terminal `command`/`plan` JSON.
  - Agent tools (`memory.search`/`memory.store`, `loadSkill`, `wakeOnJob`,
    `wakeOnEvent`) are offered under OpenAI-valid names (`memory_search` …) and
    routed back to the internal dotted names. Text-only providers keep the
    JSON `{"toolCall":…}` agent loop unchanged.
  - Unit coverage: `providers.test.ts` (tool serialization/parsing/history,
    capability flag) and `orchestrator-tools.test.ts` (read→answer chain,
    parked single/multi writes, guarded_auto auto-execute + double-write guard,
    full_autonomous deny, duplicate-break, budget-exhaustion synthesis, and the
    text-only fallback). **425 tests green; `pnpm lint`/`typecheck` 43/43.**
  - Verified live on NVIDIA NIM: `meta/muse-glimmer-30b` (default; native
    tool-calling works; 10–90 s/request at this tool-set size). Laguna
    `poolside/laguna-xs-2.1` was trialed and dropped, it exceeded the 30 s
    completion timeout on the 151-tool surface and skipped write proposals.
  - New driver `apps/api/src/nl-driver-agent.ts` exercises the loop end-to-end
    with novel cross-department requests (read questions answered from org
    data, write requests parking plans), evaluated behaviorally (PASS/WARN/FAIL),
    soft outcomes (model clarifying, parking a related-but-different write)
    count as warnings, not exit failures.
  - **Provider ergonomics (`@chaste/ai-core` `providers.ts`)**, the OpenAI
    completion timeout is now configurable (`CHASTE_AI_TIMEOUT_MS`, default
    30 s), and Nemotron-3 models (`nvidia/nemotron-3-ultra-550b-a55b`) get the
    `chat_template_kwargs` they need for tool calling on NIM (they 500 without
    it). Verified against both `meta/muse-glimmer-30b` and
    `nvidia/nemotron-3-ultra-550b-a55b`; see
    `docs/research/2026-08-18-loop-engineering-skills-write-reliability.md`.
- **Write-reliability hardening (research doc
  `2026-08-18-loop-engineering-skills-write-reliability.md`, §Preventing
  superfluous writes).** Prevents the agent from proposing redundant creates
  and steers tool selection by domain:
  - **Natural-key existence gate (`@chaste/ai-core`
    `tools/natural-key.ts`)**, before any `*_create` write dispatches (or
    parks), the actor's own read-query bus is consulted for the natural key
    (vendor/customer/bpartner by name, product by `sku`, account by `code`,
    branch by `code`). If the record already exists the write is skipped and
    the model is told the existing id, a best-effort guard that never blocks
    a legitimate write when the read fails or no rule matches.
  - **Plan dedup at confirmation**, parked and terminal-plan create steps
    whose natural key already resolves are dropped from the confirm card, so a
    user never sees a redundant create.
  - **Platform domain skills (`@chaste/ai-core`
    `skills/platform-skills.ts`, `@chaste/runtime` `PostgresSkillStore`)**,
    eight read-only platform-scoped skills (purchasing, sales, inventory,
    accounting, crm, hr, manufacturing, operations) bundle the check-then-write
    doctrine per domain; the skill catalog and `loadSkill` now see them, and a
    deterministic keyword router injects the matched domain's doctrine into the
    tool-loop system prompt before any tool call.
  - **Loop quality (`orchestrator.ts` `runBusinessToolLoop`)**,
    BudgetThinker-style remaining-budget re-injection on every tool round, and
    structured termination-cause logging (`[agent-loop] terminated: …`) so cap
    vs duplicate-break exits are distinguishable.
  - **Richer tool descriptions**, native tool defs now annotate read-only
    vs write and, for guarded creates, "skips if the <entity> already exists
    (checked via <query>)".
  - `nl-driver-agent.ts` gains a write-redundancy case (`a5`: "Add Kampala
    Flour Mills as a vendor …", already exists) asserting no
    `pur.vendor.create` reaches the confirm card. Live on muse: **5/5 passing**
    (a5 answers "Kampala Flour Mills is already in the purchasing vendor list"),
    with the deterministic suites unchanged (18/18, 15/15).
- **Authoring doctrine encoded (`AGENTS.md`, `skills/module-author`,
  `skills/command-safety`, `skills/pr-hygiene`, `docs/module-development.md`)**,
  the rules for adding modules/commands/tools now require the harness
  integration: a natural key + `NaturalKeyRule` per `*.create` (with the
  `*.list` query returning it), a `platform.<domain>` skill def + routing test
  for new domains, and domain `description`s on commands/queries, so new
  functionality is reliably and efficiently exercised by the agent loop.
- **Chat UX refinements.** The `explanation` part in `ChatWidget` now renders
  collapsed by default ("Why this is allowed") so the confirm card shows only
  what the user needs; `@chaste/ai-core` summarizes gathered read-tool results
  into readable bullets (`summarizeGathered`, label key + 8-char id, capped at
  8 rows) instead of the raw JSON dump when the terminal narration fails, with
  the message "Here's what I found from the business bus: …".

### Fixed

- **Platform module dead-code relocation (`modules/platform/src/index.ts`)**,
  the analytics / import-rule / dashboard registrations had drifted into
  `createScheduleProcessor` after `return row ?? null;`, so they referenced
  out-of-scope `commands`/`queries` and were unreachable; moved into the
  `register({ commands, queries })` callback. Watch rules, dashboards, import
  rules, and replenishment reads now execute through the same bus as humans.
- **Margin-trend sign bug (`core.analytics.marginTrend`)**, expense accounts
  were summed with a negative sign (`-debit`), inflating margin; revenue uses
  credits and expenses use debits, so `margin = revenue − expenses` is now
  correct. Also converted the `since` window to an ISO string for
  `postgres.js` (raw `Date` interpolation crashed the query).
- **Day-of-month watch-rule name duplication ("Schedule payroll approval for
  the 25th, and ping Finance if not approved by 3pm")**, the intent no longer
  repeats the trailing "ping Finance if not approved by 3pm" clause twice;
  the rule name reads "Monthly: payroll approval, ping Finance if not
  approved by 3pm".
- **Chat surfaces only respond to the running build**, the API resolves
  `@chaste/ai-core` / `@chaste/module-platform` via their `dist/`, so source
  edits require a rebuild (`pnpm --filter @chaste/ai-core build`, etc.) before
  restart; the NL driver run that previously appeared green for #14 was an
  artifact of the old process still owning :3001.

- **Agent harness spine (ADR 0014, research doc
  `2026-08-15-future-architecture-ai-native-business-os`), the first tranche
  of the pivot from "ERP with a chatbot" to "trustworthy business execution
  harness". Additive: nothing existing was removed; the command bus, outbox,
  audit, RBAC, and modules keep working unchanged.
  - **Command envelope (`@chaste/kernel` `envelope.ts`)**, `CommandEnvelope`
    with `commandId`, `idempotencyKey`, `tenantId`, `actor`, `origin`
    (`human | agent | workflow | integration | scheduled`), `requestedAt`,
    `commandType`, `payload`, `reason`, `evidenceRefs`, `correlationId`,
    `causationId`, `approvalGrantId`, and `policyContext`, plus
    `ApprovalGrant`, `PolicyDecision`, `createCommandEnvelope`, and
    `dispatchCommand`. `dispatchCommand` funnels through the same
    `executeCommand` path as every human caller, so an agent origin is never
    elevated, AI/manual parity by construction. Envelope provenance now flows
    into `RequestContext` and every `AuditEntry`, and is persisted by
    `PostgresAuditWriter` (`audit_log.origin` / `reason` / `evidence_refs` /
    `approval_grant_id` / `policy_context` / `idempotency_key` /
    `correlation_id` / `causation_id`, with an `audit_log_origin_idx` index).
  - **Append-only agent trajectory log (`@chaste/ai-core` `trajectory/`)**,
    `AgentSessionEvent` union over the doc's `session/start` … `session/end`
    vocabulary, `SessionLog` interface + `InMemorySessionLog`, and
    `reconstructModelRequest`, which replays the stream into the
    model-visible request (system sections, messages, tool schemas, evidence,
    memory reads, policy decisions) and verifies the hard reconstruction
    invariant (`complete`/`gaps`), with `summarizeModelRequest` for
    human/audit-facing summaries.
  - **Context engine (`@chaste/ai-core` `context-engine/`)**, `ContextBundle`,
    tiered `ContextSection`s (tiers 0–5), `TokenBudget` with the doc's reserve
    policy (ordinary vs document/report vs tool-heavy) and allocation order,
    admission rules (source + purpose + token estimate + authorization proof;
    unauthorized sections are redacted, never admitted), fail-closed
    `overflow` when required context cannot fit, and `explainContext` so the
    engine can say why a section was included, summarized, or omitted.
  - **Durable persistence (`@chaste/db`, `@chaste/runtime`)**, new
    `agent_session_events` (append-only, identity `seq`) and
    `context_bundles`/`context_sections` tables (Drizzle + idempotent SQL
    migration), with `PostgresSessionLog` and `PostgresContextBundleStore`
    wired into `createRuntime` as `runtime.sessionLog` /
    `runtime.contextBundles`.
  - **Tests**, kernel `envelope.test.ts` (envelope defaults, provenance
    recorded in audit, agent origin not elevated), ai-core
    `trajectory/session-log.test.ts` (append-only ordering, org-scoped session
    listing, complete + incomplete reconstruction), and
    `context-engine/context-engine.test.ts` (budget reserves, allocation
    order, fail-closed overflow, unauthorized redaction, explainability).
  - Docs: ADR 0014 `docs/adr/0014-agent-harness-spine-pivot.md`.

- **Tool and capability registry (ADR 0014 update, research doc §Tool and
  Capability Registry, §Tool Surface Optimization, §Agent Tool Wrapper
  Template), the second harness tranche** in `packages/ai-core/src/tools/`.
  Agent tools are thin consumers of the same command/query bus: no tool
  implements business logic and no tool may hide a write outside the bus.
  - **`BusinessToolDefinition` + `defineBusinessTool`**, the doc's wrapper
    template: `name`, short `description`, `kind` (`command`/`query`), the bus
    `command` name, optional `risk` override (defaults to the wrapped
    command's `CommandMeta` risk class), `exposeWhen` permission gates, strict
    `input`/`output` Zod contracts (the same ones the bus validates), and
    tool-surface metadata (idempotency, approval class, read/write access,
    expected latency/cost, good/bad examples, `renderResult`, `renderHuman`).
  - **Execution pipeline (`executeBusinessTool`)**, implements the doc's
    order verbatim: log `tool/call` → validate args → authorize visibility and
    execution → classify risk → require approval if policy says so → dispatch
    through `dispatchCommand`/`executeQuery` under the actor's own (never
    elevated) permissions → record `policy/decision` and
    `command/query/dispatched|result` → normalize to the canonical output →
    render a concise model-facing result → log `tool/result`. Approval-required
    calls are returned as `approval_required` (approval *requests*, never
    failures), and granted approvals carry the durable `approvalGrantId` into
    the envelope. `defaultToolPolicy` allows `read`/`write_local` under the
    actor's own authority and requires a durable grant for `exec`/`external`.
  - **`createToolRegistry`**, registers tools and `listForActor` hides every
    tool the actor cannot use, so tools stay out of model context unless the
    actor/task can use them.
  - **Tool surface (`describeTool` / `describeToolSet`)**, deterministic,
    model-facing rendering of each tool's metadata with a `catalog: true`
    capability-directory one-liner mode for staged tool exposure (doc Stage
    0–4); `zodToSchemaText` produces a stable summary of strict input and
    canonical output schemas (boundary validation still uses the real Zod
    schemas).
  - **Trajectory**, the `AgentSessionEvent` vocabulary gains `tool/result`
    alongside the existing `tool/call` / `policy/decision` / `approval/*` /
    `command/query/dispatched|result` events.
  - **Tests**, `tools/tools.test.ts` (21 tests) covering the doc's
    acceptance criteria: tools carry no business logic, call args are logged
    before dispatch, results logged after, approval-required renders as an
    approval request not a failure, denied/validation/error outcomes are
    typed, risk derives from command metadata, and tool visibility respects
    the actor's permissions.
  - Docs: ADR 0014 update `docs/adr/0014-agent-harness-spine-pivot.md`.

- **Durable approval grants (ADR 0014 update, research doc §Human
  Collaboration), the third harness tranche**. Human approval is a durable
  grant, who granted, what exact action, which actor it authorizes, expiry,
  conditions, policy basis, evidence shown, never a chat message the model may
  reinterpret.
  - **`@chaste/kernel` `approvals.ts`**, `ApprovalGrantRecord` (envelope
    `ApprovalGrant` + `organizationId`, `grantedToUserId`, `status`, revoke
    bookkeeping), `ApprovalGrantStore` interface, `InMemoryApprovalGrantStore`,
    and the pure `grantCovers` matcher (org + actor + scope + expiry + revoked).
  - **`@chaste/db` + `@chaste/runtime`**, `approval_grants` table (Drizzle +
    idempotent SQL) and `PostgresApprovalGrantStore`, wired into
    `createRuntime` as `runtime.approvalGrants` so grants survive restarts and
    are shared across API + worker hosts.
  - **`@chaste/ai-core` `tools/approvals.ts`**, `grantStoreApprovalResolver`
    surfaces an inbox approval item (when wired), awaits the human decision,
    and on `allow`/`always` mints a durable grant whose id becomes the tool
    call's `approvalGrantId`; without a decision surface the call stays an
    approval *request*, never a failure. `grantCoveredToolPolicy` checks the
    store before the default risk policy, so a durable grant auto-allows
    subsequent identical calls until expiry/revocation; the trajectory's
    `policy/decision` cites `grant:<id>`.
  - **Tool pipeline**, `ApprovalRequest` now carries `policyBasis` and
    `evidenceRefs`; the command envelope's `policyContext` records the policy
    that produced the decision so audit and trajectory cite the grant/policy.
  - **Tests**, kernel `approvals.test.ts` (scope/actor/org/expiry/revocation
    matching, create/get/list/revoke/check) and ai-core `tools/approvals.test.ts`
    (approval → durable grant, denied → approval request, grant-covered
    auto-allow, per-actor isolation).
  - Docs: ADR 0014 update `docs/adr/0014-agent-harness-spine-pivot.md`.
- **Typed agent plans (ADR 0014 update, research doc §Planning), the fourth
  harness tranche** in `packages/ai-core/src/planning/`. A plan is a typed,
  inspectable, revisable artifact connecting intent → approval → execution,
  validated by Zod at every boundary.
  - **`planning/types.ts`**, `AgentPlan` (`objective`, `assumptions`, `steps`,
    `requiredApprovals`, `risks`, `evidenceNeeded`, `stopConditions`),
    `PlanStep`, `ApprovalNeed`, `PlanRisk`, `EvidenceNeed`.
  - **`planning/schema.ts`**, `.strict()` Zod contracts (`agentPlanSchema`,
    `validatePlan`) so the model can propose a plan but never invent a shape
    the kernel rejects.
  - **`planning/plan.ts`**, pure analysis: `planRisk` maps risk tiers onto
    plan risk levels aligned with the tool policy (`read`→low,
    `write_local`→medium, `exec`/`external`→high), `planRequiresApproval`,
    `summarizePlan` (model-facing), `renderPlan` (approval card).
  - **`planning/approve.ts`**, `requestPlanApproval`: logs `plan/proposed`,
    auto-runs low-risk plans, surfaces medium/high-risk plans as an inbox
    `plan` item (editable/rejectable), and on approval mints one durable grant
    per `requiredApproval` (command/resource-scoped, TTL, `policyBasis:
    "plan-approval"`, conditioned on the reason + plan id) so
    `grantCoveredToolPolicy` auto-allows the matching steps. Rejection mints
    nothing and logs `approval/rejected`; no decision surface fails closed.
  - **Tests**, `planning/planning.test.ts` (risk classification, low-risk
    auto-run, approval → grants, rejection → no grants, fail-closed, grant
    covers approved command for the granted actor only).
  - Docs: ADR 0014 update `docs/adr/0014-agent-harness-spine-pivot.md`.
- **Activities + task foundations (ADR 0014 update, research doc
  §Proactive Scheduling / §Workflow, build item 7), the fifth harness
  tranche** in `@chaste/kernel` + `@chaste/db` + `@chaste/runtime`, following
  the durable-store pattern (model + in-memory store in kernel, Postgres store
  in runtime).
  - **`@chaste/kernel` `activities.ts`**, `Activity` (kind, assignee,
    createdBy, dueAt, timezone, recurrence, business-record link),
    `RecurrenceRule` with pure UTC `nextOccurrence` (daily/weekly/monthly +
    weekday narrowing + pinned time), `isOverdue` (derived, never stored),
    `ActivityStore` + `InMemoryActivityStore` with once-only complete/cancel,
    agenda ordering, and `overdue`.
  - **`@chaste/kernel` `tasks.ts`**, workflow/task foundations: `Task`
    (status, priority, dueAt, `dependsOn` dependency graph, blocker reason),
    pure `taskBlockers` / `canTransition` / `readyTasks` (work queue = pending
    tasks with no blockers, due-date then priority order), and `TaskStore` +
    `InMemoryTaskStore` with dependency-enforcing transitions.
  - **`@chaste/db` + `@chaste/runtime`**, `activities` and `workflow_tasks`
    tables (Drizzle + idempotent SQL), `PostgresActivityStore` and
    `PostgresTaskStore` wired into `createRuntime` as `runtime.activities` /
    `runtime.tasks`. Task transitions reuse the kernel's pure `canTransition`.
  - **Tests**, kernel `activities.test.ts` + `tasks.test.ts` (recurrence,
    overdue derivation, once-only transitions, dependency blocking, blocker
    reasons, work-queue ordering).
  - Docs: ADR 0014 update `docs/adr/0014-agent-harness-spine-pivot.md`.
- **Harness orchestrator wiring (ADR 0014 update, research doc §Agent
  Harness), the sixth harness tranche** in `packages/ai-core/src/harness/`.
  Connects the tool registry, durable grants, typed plans, and trajectory into
  a runnable whole, additively, leaving the existing ad-hoc orchestrator
  untouched.
  - **`createHarness`**, `toolSurface(actor)` (model-facing tool list +
    schemas from `listForActor` + `describeToolSet`), `call(params)` (executes
    a tool through `executeBusinessTool` with `grantCoveredToolPolicy` +
    `grantStoreApprovalResolver`; no grants/inbox/approver → approval calls
    fail closed as requests), and `runPlan(params)` (validates the plan,
    gates on `requestPlanApproval`, topologically orders steps, runs each
    through the bus, skips dependents of failed steps, honors stop
    conditions, attaches `evidence/attached` per `expectedEvidence`).
  - **`tools/execute.ts`**, an `allow` from `grant:<id>` now cites the
    durable grant as the envelope's `approvalGrantId`, so a plan-approved
    step's audit and handler trace the exact grant that authorized it.
  - **Tests**, `harness/harness.test.ts` (permission-filtered tool surfaces,
    read dispatch with trajectory, fail-closed approvals, plan grants covering
    external steps, dependency ordering + dep-failure skipping, stop
    conditions, boundary validation + missing-approver fail closed).
  - Docs: ADR 0014 update `docs/adr/0014-agent-harness-spine-pivot.md`.

- **(Activities + workflow tasks) command surface, the seventh harness
  tranche**, `modules/workflow-tasks` (`@chaste/module-workflow-tasks`),
  completing build-sequence item 7 of the research doc. Humans and agents
  exercise the same bus contract over the durable stores, so AI/manual parity
  holds by construction.
  - `createWorkflowTasksModule({ activities, tasks })` layers strict
    (`z.object(...).strict()`) Zod boundaries over the kernel
    `ActivityStore`/`TaskStore` interfaces, the module owns no storage.
  - Commands: `activities.create` / `activities.complete` / `activities.cancel`;
    `workflow.tasks.create` / `workflow.tasks.complete`
    (dependency-enforced via `taskBlockers`) / `workflow.tasks.block` (records
    the reason). Queries: `activities.list` / `activities.overdue`;
    `workflow.tasks.workQueue` (ready pending tasks) / `workflow.tasks.list`.
  - Permissions `activities.read` / `activities.write` /
    `workflow.tasks.read` / `workflow.tasks.write` declared in the manifest.
  - `packages/runtime` builds the durable Postgres stores *before* module
    registration and injects them into the module, so the same stores serve
    the module and the harness.
  - Tests: `workflow-tasks.test.ts`, manifest, CRUD round-trips, overdue
    derivation, dependency-enforced completion, work-queue ordering, blocked
    reasons, strict input rejection, permission denial, and bus reachability
    with envelope provenance.
  - Docs: ADR 0014 tranche-7 update `docs/adr/0014-agent-harness-spine-pivot.md`.

- **Host layer (harness over HTTP/chat), the eighth harness tranche**,
  laying the build-item-9 foundation: the surface that *runs the native
  harness* and serves inbox plan/approval decisions through durable grants.
  Additive, `/api/v1/ai/chat` and the legacy orchestrator are untouched.
  - **Bus→tool adapter (`@chaste/ai-core` `tools/from-bus.ts`)**, every
    registered command and query becomes a tool wrapping the same bus contract
    (`command` = bus name, `exposeWhen` = the command's permission strings,
    input/output = the same Zod schemas). No tool implements business logic and
    risk is never invented, it derives from the wrapped command's metadata.
    This is what populates the tool registry in production.
  - **`harness/host.ts`, `createHarnessHost`**, wires the harness to durable
    stores and exposes `runPlan` (blocking), `submitPlan` (non-blocking:
    low-risk plans execute immediately; gated plans surface an inbox `plan`
    item and are stored), `decide` (a human's resolution: approval mints the
    plan's durable grants and executes its steps; rejection records the
    rejection; other item kinds resolve generically), `pendingItems` /
    `pendingPlans`, and `harnessFor(approverUserId)`.
  - **`planning/approve.ts` split**, `proposePlanApproval` surfaces a plan
    without blocking (`via: "awaiting"`), `grantPlanApprovals` mints the durable
    grants, and `requestPlanApproval` reuses both. Proposals now record an
    `approval/requested` trajectory event.
  - **Harness extraction**, `harness/tool-context.ts` +
    `harness/run-plan-steps.ts` let the host execute plan steps under identical
    authority (same grants/policy/trajectory) after an external approval.
  - **API routes (`apps/api`)**, `POST /api/v1/ai/plans`, `GET /api/v1/inbox`,
    `POST /api/v1/inbox/:id/decide`, backed by `app.harnessHost` (built once in
    `createAppContext` from the Postgres grant store, inbox, and trajectory).
  - Tests: `tools/from-bus.test.ts`, `harness/host.test.ts` (submit→decide→
    execute with durable grants, rejection, ownership checks, blocking
    wait/resolve), and `apps/api/src/e2e-harness.test.ts` (the full gated-plan
    submit → inbox → decide → execute round-trip over HTTP).
  - Docs: ADR 0014 tranche-8 update `docs/adr/0014-agent-harness-spine-pivot.md`.

- **Durable workflow instances (build item 10), the ninth harness tranche**,
  the durable, resumable run state for workflows (`@chaste/kernel`
  `workflow-instances.ts`), executed over the bus through
  `modules/workflow-instances` (`@chaste/module-workflow-instances`).
  Additive, the engine's one-shot resume and the legacy direct-run path are
  untouched.
  - **Kernel state model + store interface**, `WorkflowInstance` (status,
    context, per-step results, error, timestamps) mutated only through pure
    helpers (`newWorkflowInstance`, `applyStepResult`, `finalizeInstance`,
    `completedStepIds`), with an `InMemoryWorkflowInstanceStore` and a
    `WorkflowInstanceStore` interface.
  - **Additive engine options (`@chaste/ai-core` `workflows/engine.ts`)**,
    `skipStepIds` (prior-run steps skipped without re-executing), `baseContext`
    (stored context resolves later steps' inputs), `runId` (persists across
    resume calls), `checkpoint` (per-step persistence hook).
  - **`workflow.instance.*` bus surface**, `start` (runs the definition from
    `core.workflow.get` with `runId = instance.id`), `advance` (resumes from the
    checkpoint, accepting newly approved gate ids), `cancel`, and org-scoped
    `get`/`list`. Permissions `workflow.instance.read` / `workflow.instance.write`
    declared in the manifest; everything flows through the command/query bus so
    AI/manual parity, audit, and permissions hold by construction.
  - **`@chaste/db` + `@chaste/runtime`**, `workflow_runs` gains
    `created_by_user_id` + `updated_at` (ADD COLUMN IF NOT EXISTS migration);
    `PostgresWorkflowInstanceStore` upserts each checkpoint; wired as
    `runtime.workflowInstances` and registered in `createRuntime`.
  - Tests: kernel `workflow-instances.test.ts`, engine resume/checkpoint tests,
    module contract tests (run-to-completion, approval-gate park + resume,
    terminated rejection, cancel, org scoping, strict validation), and
    `packages/runtime/src/workflow-instances.e2e.test.ts` (definition started
    via one host checkpoints into `workflow_runs`; a second host resumes a
    gated instance to completion without re-running steps).
  - Docs: ADR 0014 tranche-9 update `docs/adr/0014-agent-harness-spine-pivot.md`.

- **Durable pending plans, the tenth harness tranche**, replacing the host
  layer's last process-local state: a gated plan now persists to the shared
  `harness_plans` table (keyed by inbox item id), so a plan submitted on the
  API host is decidable on the worker host. Additive, the host falls back to
  the in-memory map when no `planStore` is supplied.
  - **`@chaste/ai-core` `harness/plan-store.ts`**, `PlanStore` interface
    (`save`, `getByItemId`, `getByPlanId`, `listByOrg`, `listAll`, `remove`)
    with `InMemoryPlanStore`; the stored record serializes the plan's
    `Actor.permissions` Set to an array and rebuilds it on load, so a replayed
    decision re-executes under the exact same authority.
  - **`harness/host.ts`**, `createHarnessHost` accepts `planStore?`;
    `submitPlan` persists the entry, `decide` loads it durably, `pendingPlans`
    lists from the store (now async). `PendingPlanEntry` moved to `plan-store.ts`.
  - **`@chaste/db` + `@chaste/runtime`**, new `harness_plans` table with
    `pending`/`resolved` tombstone status; `PostgresPlanStore` wired as
    `runtime.planStore` and passed into `createHarnessHost` by `apps/api`.
  - Tests: `plan-store.test.ts` (serialization round-trip preserving
    permissions/evidence/policy context, CRUD, defensive copies), `host.test.ts`
    durable path (submit through one host, decide through another sharing the
    store), and `packages/runtime/src/plan-store.e2e.test.ts`, submit on the
    API host → `harness_plans` row → worker host decides → step executes under
    the replayed actor authority (grant minted, activity created by the agent
    user) → entry tombstoned; rejection tombstones without executing.
  - Docs: ADR 0014 tranche-10 update `docs/adr/0014-agent-harness-spine-pivot.md`.

- **Model router + cost controls, the eleventh harness tranche** (build item
  13, cost-control half): the `ModelRouter` stage between the prompt envelope
  and the LLM call selects a provider per task class and records token/cost
  attribution. Every routed completion appends an append-only row to the
  shared `model_usage` table; budget caps are enforced *before* dispatch by
  summing recorded spend, so a cap configured on one host reflects spend
  recorded on every host. Fail-closed: unroutable task classes and exhausted
  budgets refuse the request.
  - **`@chaste/ai-core` `model-router.ts`**, `TaskClass` (`rules`/`chat`/
    `planning`/`report`, zod-validated), `UsageLedger` (`record`,
    `spendForOrganization(since)`, `spendForSession`) + `InMemoryUsageLedger`,
    `createModelRouter({ providers, config, budget, prices, ledger })`,
    `estimateCostCents` (per-1M-token prices), `BudgetPolicy`,
    `ModelRouteError`, `BudgetLimitError`. Recording is unconditional;
    `budget.enabled` gates only the cap check.
  - **Workflow builder**, optional `router` + `routerTaskClass` (default
    `planning`); with a per-request context, `generateWorkflowFromNL` routes
    the planning completion instead of calling the provider directly.
  - **`@chaste/config`**, `ai.routerRoutes` (task class → provider id) and
    `ai.cost` (enabled, org-monthly + session caps, per-provider prices).
  - **`@chaste/db` + `@chaste/runtime`**, new `model_usage` table;
    `PostgresUsageLedger` (insert-once, never update/delete) wired as
    `runtime.usage`.
  - **`apps/api`**, `app.modelRouter` built over the traced provider +
    `runtime.usage`; `buildWorkflow` routes planning completions with the
    caller's org/session context; `GET /api/v1/ai/usage` reports org monthly
    spend from the durable ledger.
  - Tests: `model-router.test.ts` (per-class routing, fail-closed routing,
    org/session caps, cost estimation, ledger sums), workflow-builder routed
    path via `buildWorkflow`, `packages/runtime/src/model-usage.e2e.test.ts`
    (host A records → host B enforces the same cap → restarted ledger still
    sees spend → recording happens with no cap configured), and `apps/api`
    `e2e-workflow.test.ts` asserting the usage route.
  - Docs: ADR 0014 tranche-11 update `docs/adr/0014-agent-harness-spine-pivot.md`.

- **Proactive coordinator, the twelfth harness tranche** (build item 13,
  part 2): natural-language schedules parse into exact
  who/what/when/condition/action objects *before* confirmation; watch rules
  (notify < suggest < draft < request_approval) fire durably with trigger
  evidence, proposed action, expected impact, and an explicit
  `requiredApproval` flag; quiet hours, a daily cap, and occurrence
  deduplication manage fatigue; and the coordinator never executes a command,
  it hands the host an authority-safe plan to gate through approval.
  - **`@chaste/ai-core` `proactive/`**, `schedule-parser.ts` (deterministic
    `parseScheduleText` → `ScheduleSpec` + `confirmSchedule`), `watch-rules.ts`
    (`WatchRule` + `WatchRuleStore` + `nextFireTime`, sharing kernel-activity
    recurrence), `coordinator.ts` (`ProactivePreferences` quiet hours / daily
    cap / channels, `ProactiveSuggestion` envelope, pure `deliveryGate` +
    `inQuietHours`, `collect`/`deliver`/`deliverDue`/`buildProactivePlan`),
    and dependency-free `types.ts` for the shared zod contracts.
  - **`@chaste/db` + `@chaste/runtime`**, `watch_rules`,
    `proactive_preferences`, and `proactive_deliveries` (unique
    (org, dedupe_key) → exactly-once firing across hosts); Postgres stores
    wired as `runtime.watchRules` / `runtime.proactivePreferences` /
    `runtime.proactiveDeliveries`.
  - **`apps/api`**, `app.proactive` surface; `/api/v1/proactive/rules` (CRUD
    + pause/resume), `/api/v1/proactive/preferences` (read/edit),
    `/api/v1/proactive/suggestions?now=` (dry-run, records nothing), and
    `/api/v1/proactive/tick` (collect + gate + record).
  - Tests: ai-core `proactive/coordinator.test.ts` (parsing, store scoping,
    next-fire times, gate + quiet hours, collect/advance/duplicate,
    approval-safety, wakes + overdue activities, cap/quiet-hours suppression);
    `packages/runtime/src/proactive.e2e.test.ts` (rule on the API host honored
    by a worker coordinator, durable delivery with unique dedupe key,
    cursor advance, quiet-hours suppression, approval-safe plan handoff);
    `apps/api/src/e2e-proactive.test.ts` (HTTP CRUD, pause/resume, dry-run,
    tick, preferences).
  - Docs: ADR 0014 tranche-12 update `docs/adr/0014-agent-harness-spine-pivot.md`.

- **Evaluation harness, replay/fork, and scenario regression suite, the
  thirteenth harness tranche** (build item 14): the append-only trajectory
  becomes a verification surface. A session log replays into the exact
  model-visible request every time (hard invariant), forks a stream up to a
  boundary into a fresh identity with `session/forked` + `session/resumed`
  markers, and regression scenarios drive a real harness with the replay and
  fork guarantees attached to every verdict.
  - **`@chaste/ai-core` `eval/`**, `replay.ts` (`replaySession`,
    `assertReplayInvariant` fail-closed, `summarizeTrace`), `fork.ts`
    (`forkSession` with boundary validation, copies events under a new
    identity, appends `session/forked` + `session/resumed`), `scenario.ts`
    (`Scenario`, `createScenarioContext`, `runScenario` auto-attaching replay
    + fork, `runScenarioSuite` → `SuiteReport`).
  - **`@chaste/ai-core` `eval/scenarios/`**, golden scenarios over a real
    kernel bus/tools/grants/decision surface with the harness pointed at the
    scenario's own session log: `harness/unauthorized-tool-refusal` (tool
    hidden + direct call denied under `tool-exposeWhen`, nothing dispatched)
    and `harness/external-step-approval` (external step surfaced, approved,
    and executed only under the durable grant minted from that approval).
  - Tests: ai-core `replay-fork.test.ts` (reconstruction, determinism, gap
    reporting, fail-closed invariant, fork copy/markers/isolation/boundaries)
    and `scenario.test.ts` (verdict carries replay + fork, failing checks fail
    the scenario, golden suite passes, incomplete scenario fails);
    `packages/runtime/src/replay-fork.e2e.test.ts`, a trajectory recorded on
    one host replays identically on a second independent host, and a fork
    survives a fresh store instance.
  - Docs: ADR 0014 tranche-13 update `docs/adr/0014-agent-harness-spine-pivot.md`.

- **MCP/integration plane, the fourteenth harness tranche** (build item 15):
  the `mcp-gateway` exposes Chaste capabilities to external harnesses (Codex,
  Claude Code, opencode, DeepSeek Harness, MCP clients) as scoped tools
  mediated by Chaste. External harnesses never touch the database: every
  `tools/call` is revalidated, reauthorized, and audited on the shared session
  log through the same pipeline the native harness uses.
  - **`@chaste/ai-core` `mcp/`**, `protocol.ts` (dependency-free JSON-RPC 2.0:
    `initialize`/`tools/list`/`tools/call`/`ping`, MCP error codes,
    `McpError`), `zod-json-schema.ts` (deterministic Zod → JSON Schema for
    `inputSchema`), `gateway.ts` (`createMcpGateway` + `createSession`:
    actor-scoped tools/list, tools/call through the full execution pipeline,
    explainable `isError` payloads, trajectory recording),
    `stdio.ts` (newline-delimited JSON-RPC stdio transport),
    `server.ts` (`createChasteMCPServer` from the command/query bus).
  - **`apps/api`**, `app.tools` + `app.mcp`; `POST /api/v1/mcp` with a
    per-request session (uuid `x-chaste-session` header for continuity) and
    tools scoped to the authenticated actor.
  - Tests: ai-core `mcp/gateway.test.ts` (initialize, scoping, read-tool call,
    hidden-tool rejection, approval-required vs grant-covered external calls,
    validation errors, trajectory recording, protocol edges); `apps/api/src/e2e-mcp.test.ts`
    over HTTP (initialize, scoped tools/list, bus-mediated tools/call, ping,
    method-not-found, hidden-tool rejection).
  - Docs: ADR 0014 tranche-14 update `docs/adr/0014-agent-harness-spine-pivot.md`.

- **External harness adapters, the fifteenth harness tranche** (build item 16):
  bounded delegation to Codex, Claude Code, opencode, and DeepSeek Harness.
  External harnesses are optional accelerators, never direct business
  authorities: every run is bound to a Chaste actor, its tool calls are
  mediated by the MCP gateway (revalidated, reauthorized, audited), its traces
  attach as artifacts, and the Chaste trajectory on `runId` remains the audit
  spine. Provider/model usage is recorded when the harness exposes it;
  otherwise the run is marked `usageVisibility: "unknown"`.
  - **`@chaste/ai-core` `external-harness/`**, the `HarnessAdapter` contract
    (`start`/`followup`/`cancel`/`collect`/`capabilities`), the four declarative
    definitions (Codex, Claude Code, opencode, DeepSeek Harness), and
    `createHarnessAdapter`: runs record `externalHarness/*` events
    (session-start, turn, tool-call, tool-result, artifact, session-end) on a
    fresh Chaste trajectory, run tool calls through the MCP gateway, refuse
    tools outside the run's `allowedTools`, and collect a result whose
    `traceRef` is the Chaste trajectory id. `harnessRunFromTrajectory` rebuilds
    a handle from the session stream for stateless resume by `runId`.
  - **`apps/api`**, `app.externalHarnesses` (the four adapters over the shared
    gateway + `sessionLog`); `GET /api/v1/harness-adapters`;
    `POST /api/v1/harness-adapters/:kind/runs` (start + optional first turn);
    `POST /api/v1/harness-adapters/:kind/runs/:runId/turns` (resume);
    `GET /api/v1/harness-adapters/:kind/runs/:runId` (collect).
  - Tests: ai-core `external-harness/adapter.test.ts` (13); `apps/api/src/e2e-harness-adapters.test.ts`
    over HTTP (capabilities list, run + mediated tool call on the trajectory,
    usage visibility, resume-by-runId + collect, allowedTools gate).
  - Docs: ADR 0014 tranche-15 update `docs/adr/0014-agent-harness-spine-pivot.md`.

- **Coding-agent reuse (`CHASTE_AI_PROVIDER=auto`)**, Chaste detects coding
  agents already installed on the host (Claude Code, Codex, OpenCode, Gemini,
  Grok, Cline, Antigravity, Pi, and 19 more) and reuses their model + endpoint +
  credential as an `AiProvider`, so operators bring their own subscription
  instead of configuring a second API key. Add an `AnthropicMessagesProvider`,
  a data-driven agent registry in `@chaste/ai-core` (`coding-agents.ts`), and a
  `prefer` override (`CHASTE_AI_PREFER_CODING_AGENT`). Agents are completion
  backends only, no elevated privileges; OAuth-only agents (Cursor, Copilot,
  Devin, …) are reported as installed for the self-dev handoff, not reused.
  Docs: `docs/specs/coding-agent-reuse.md`, ADR 0013.

- **Shared durable runtime (`@chaste/runtime`)**, a single `createRuntime(config, db)`
  factory builds the command/query registries, registers every shipped module once,
  and wires Postgres-backed stores (`pending_approvals`, `ai_wakes`, `ai_skills`).
  Both the API and the worker consume it, eliminating process-local store drift so
  standing rules / wakes / skills minted over HTTP are honored by scheduled
  follow-ups (ARCH-4, SC-4).
- **Per-request bearer-token authentication**, the API resolves the acting user from
  an `Authorization: Bearer` token per request instead of a process-wide session
  singleton (with bootstrap-admin fallback for dev/legacy). Adds `POST /api/v1/auth/login`
  and a token-scoped `GET /api/v1/session`. Request-scoped `runCommandAsAuth` /
  `runQueryAsAuth` execute under the request principal while sharing the per-request
  audit/outbox transaction (ARCH-1).
- **Persisted workflows**, AI-built workflows and their runs now survive restarts,
  stored in `workflow_definitions` / `workflow_runs` and reached exclusively via the
  command/query bus (`core.workflow.create` / `get` / `list`), which humans and AI share
  (ARCH-5).
- **Command-bus transactional outbox**, business writes, outbox enqueues, and audit
  events commit in one DB transaction via `createCommandHelpers`; success audit is
  in-transaction and failure audit is written out-of-transaction (ARCH-2).
- **Org-scoped API keys** (`core.apikey.*`), first-class machine credentials with
  their own permission scopes (subset of the catalog, validated at creation),
  hash-at-rest secrets, and an independent revoke / rotate / expire lifecycle.
  Authenticate with `X-Api-Key: <secret>`; audit attributes command execution to
  the `api_key` actor (`actorKind: "api_key"`).
- **Durable outbox delivery (ARCH-9/REL-2)**, the worker now claims events with
  `FOR UPDATE SKIP LOCKED` (no double-processing across workers), tracks
  `attempts` / `last_error` on `outbox_events`, applies exponential backoff via
  `next_attempt_at`, and copies events that exhaust retries to an append-only
  `dead_letter_events` table. Operators are notified in-app (`kind: "dead_letter"`)
  and can inspect / re-queue via `core.outbox.listDead` (`core.outbox.read`) and
  `core.outbox.replay` (`core.outbox.manage`), both org-scoped and audit-covered.
  Scheduled reminders/follow-ups run through a schedule driver that prefers
  Redis/BullMQ (per-item atomic claims) and falls back to the poll loop when Redis
  is unavailable. The worker now shuts down cleanly on SIGTERM/SIGINT (queue
  workers, Redis and the Postgres client are closed).

### Changed

- **Command/query execution**, the kernel `InboxStore` and ai-core `WakeStore` /
  `SkillStore` became async interfaces with separate in-memory and Postgres
  implementations (ARCH-4, SC-4).
- **Module boot integrity**, removed the dead `core-system` and `demo-crm` modules and
  added a boot-time registry integrity test that fails on duplicate command/query names
  or missing platform queries (ARCH-6).
- **Platform module decomposition (ARCH-3)**, the platform "god module" is being split
  into bounded-context packages: `business-partner master data` (`core.bpartner.*`),
  `scheduling` (`core.reminder.*`, `core.followup.*`, `core.calendar.*`), and `identity`
  (`core.rbac.*`, `core.role.*`, `core.user.*`) now live in
  `@chaste/module-master-data`, `@chaste/module-scheduling`, and
  `@chaste/module-identity`. Command/query names and permissions are unchanged;
  ownership and contract tests moved with the code. `platform` shrinks and will keep
  shedding bounded contexts toward a thin aggregator.
- **Chat confirmation cards**, only the live confirmation renders after a turn; stale
  cards from a previous confirmation are pruned.
- **AI orchestration robustness (natural clarification)**, the R10 recognition guard
  discards an LLM-materialized plan when a deterministic intent is recognized but a
  required field is missing (e.g. `Create customer in Nairobi`), parking a focused
  clarification instead of a confirm with invented values; clarify probes now preserve
  trailing context (city, amount) so the answer merges correctly; the learned-context
  memory block and LLM prompt forbid copying past-execution values into new plans.
- **Postgres e2e self-cleanup**, `apps/api/src/e2e.test.ts` deletes the customers,
  invoices, memories, and chat sessions it creates, so test runs no longer pollute the
  shared dev database.

### Security (2026-08-08 audit remediation)

- **F1, no more anonymous admin bypass in production.** The "no token ⇒
  bootstrap admin" fallback is now a dev-only flag (`CHASTE_ALLOW_ANON_ADMIN`);
  production forces it off at config load (fail closed) and the prod Compose
  sets it explicitly. Bootstrap admin is now authenticatable: first boot mints a
  hashed-at-rest credential (`CHASTE_ADMIN_TOKEN` or a one-time generated token
  printed in dev only).
- **F2, workflow `condition` steps no longer execute code.** `new Function`
  was replaced by a restricted predicate interpreter (`evaluateCondition`,
  tokenizer + recursive-descent parser with no function calls / global access),
  so a stored or LLM-injected condition can at worst evaluate to `false`.
  `lookupPath` also rejects prototype-key traversal (`__proto__`/`constructor`).
- **F3, workflow build/execute and the two remaining list routes run under the
  authenticated caller** (`requestCtxForAuth`), not the bootstrap admin, org
  ownership and audit attribution match the requester.
- **F4, chat sessions are ownership-checked** (`DbSession.userId`); loading or
  continuing another user's session (incl. pending planned actions) is denied.
- **F5, bearer tokens expire.** `users.token_expires_at` is set on
  invite/create (`CHASTE_SESSION_TOKEN_TTL`, default 30 days) and enforced in
  `resolveUserByToken`; the previously-dead TTL config is now live.
- **F7, `core.user.create` stores tokens hashed at rest** (SHA-256), matching
  `core.user.invite`; the legacy plaintext lookup remains only as a migration
  fallback for pre-hash rows.
- **F6, rate limiting at the HTTP edge**, dependency-free fixed-window
  limiters (`apps/api/src/rate-limit.ts`): `/auth/login` 10 req/15s per IP,
  `/ai/chat` 30 req/15s per IP plus 120 req/min per authenticated user;
  throttled responses carry `retry-after` and `429 RATE_LIMITED`.
- **F8, the external risk floor is now live**, `core.email.send` /
  `core.email.enqueue_template` declare `riskClass: "external"` (target-bound
  per `to`), and `core.backup.restore` declares `riskClass: "exec"`; all three
  require `full_autonomous` to auto-run, so standing rules can no longer send
  email or restore backups under `guarded_auto`.
- **F9, CORS allow-list**, the API now accepts only the configured
  `webOrigin` instead of reflecting any `Origin` header; non-browser
  (no-Origin) callers are unaffected.

### Security (2026-08-08, F10–F24 remediation)

- **F10, infra fails closed.** Prod Compose requires `CHASTE_SESSION_SECRET`,
  `POSTGRES_PASSWORD`, and `REDIS_PASSWORD` (`:?`, no shipped defaults);
  `CHASTE_BOOTSTRAP` defaults to `false` (first boot requires
  `CHASTE_ADMIN_TOKEN`); Redis runs with mandatory auth; all runtime images
  (`api`, `web`, `worker`, `migrate`) run as the non-root `node` user.
- **F12, audit log hygiene.** The command bus redacts sensitive free-text
  inputs (`body`, `note`, `goal`, `salary`, credentials, …) before writing
  `input_summary` (`kernel/src/redact.ts`); the worker no longer logs
  follow-up `goal` text.
- **F13, role permissions are catalog-validated.** `core.role.create/update`
  reject any permission not in `PERMISSION_CATALOG`, including `*`, so a role
  can never silently grant more than the platform defines.
- **F14, backup restore is org-bound.** `core.backup.restore` refuses a
  manifest whose `organizationId` differs from the caller's org.
- **F15, client-side token hygiene.** The web client clears the stored bearer
  token on any 401 so an expired/revoked credential drops back to login.
- **F16, audit reads are permissioned.** `/api/v1/audit` now goes through the
  `core.audit.list` query (requires `core.rbac.read`) instead of a direct
  store call available to any authenticated user.
- **F18, Buzz webhook anti-replay.** Signed webhooks carry a unix-seconds `ts`
  covered by the HMAC; payloads older than 5 minutes are rejected.
- **F20, legacy web forms authenticate.** `CreateVendorForm`,
  `CreateProductForm`, and `HrActions` route through `apiFetch` (Bearer
  attached) instead of raw `fetch`, no more "executes as the admin".
- **F21, security headers.** `next.config.mjs` adds CSP (with connect-src for
  the API origin), `nosniff`, `DENY` framing, `Referrer-Policy: no-referrer`,
  HSTS, and a restrictive `Permissions-Policy`.
- **F23, CI least-privilege.** `ci.yml` scopes `GITHUB_TOKEN` to
  `contents: read` and adds a non-blocking `pnpm audit` step.
- **F24, reminders honor their channel.** `channel: email|both` now enqueues
  an outbound email through the email outbox (delivered by the worker), instead
  of being stored and never sent.
- **Private overlay mesh (ADR 0012)**, opt-in `--profile mesh` adds a Headscale
  control plane (`deploy/mesh/config.yaml` + `acl.json`) and Tailscale sidecars
  for `api`/`web`/`worker`; host port publication can be disabled (`API_BIND=` /
  `WEB_BIND=`) so services are reachable only over the tailnet.

### Fixed

- **Web app never hydrated under dev CSP (`apps/web/next.config.mjs`)**, the
  `script-src` policy lacked `'unsafe-eval'`, which blocked Next dev's
  `eval-source-map` chunks from executing, so React never mounted: every click
  (login submit, assistant orb, theme toggle) was inert while SSR HTML rendered
  normally. `'unsafe-eval'` is now added to `script-src` **only** in development;
  the production policy stays strict. Verified by React fiber markers + full
  login/chat flows in the browser.
- **Stale chat confirm cards**, approving/answering one confirmation no longer leaves
  a second duplicate card visible in the composer.

## [0.1.0] - 2026-08-05

First tagged release. Early alpha, not recommended for production workloads.

### Added

- **Messaging module**: internal messaging (`modules/messaging`) with send/read
  commands, unread counts, and a full web UI at `/messaging`.
- **Buzz bridge**: signed outbound webhook delivery from the worker
  (HMAC-SHA256 `X-Chaste-Signature`) plus a validated inbound webhook endpoint
  on the API, external messaging with zero configured cost in a stock install.
- **Email delivery**: transactional email outbox with pluggable adapters,
  Resend (REST) preferred, then SMTP (nodemailer), then console. Provider
  auto-detection, retry + crash-recovery lease, and a `/email` admin page.
- **Encrypted backups**: AES-256-GCM snapshot/restore (`CHASTE_BACKUP_KEY`)
  with S3-compatible or local object stores, worker flush loop, restore CLI
  (`pnpm restore`), and a `/data` management page.
- **Docker deployment**: multi-target `Dockerfile` (`migrate`, `api`, `web`,
  `worker`), production `docker-compose.prod.yml` (Postgres + Redis + one-shot
  migrations), `.dockerignore`, and per-provider guides (AWS, GCP, Azure,
  Fly.io, Render, Railway, Supabase/Neon).
- **Deep CRM module (ADR 0008)**: CRM is now the flagship "deep module" template.
  Backend gains `crm.customer.update`, `crm.customer.setStatus` (guarded lifecycle
  transitions), `crm.customer.delete` (soft-delete/archive), `crm.contact.create` /
  `crm.contact.delete`, `crm.interaction.log`, plus `crm.customer.get`,
  `crm.contact.list`, `crm.interaction.list` queries. Two new namespaced tables
  (`crm_contacts`, `crm_interactions`) with cascading FKs and org-scoped indexes.
  New permissions: `crm.customer.update`, `crm.contact.manage`, `crm.contact.read`,
  `crm.interaction.write`, `crm.interaction.read`.
- **CRM UI depth**: customer detail page (`/crm/customers/[id]`) with header KPIs,
  pipeline status transitions, contacts panel, and an activity timeline; deepened
  customer list with status filter, search, and per-row view/edit/delete actions
  (edit in modal, delete via confirm dialog).
- **Shared UI primitives**: `Modal`, `ConfirmDialog`, `StatusBadge`, `Timeline`
  components in `apps/web/src/components/ui/` for reuse across module workspaces.
- **Typed API client**: `getCustomer`, `updateCustomer`, `setCustomerStatus`,
  `deleteCustomer`, `listContacts`, `createContact`, `deleteContact`,
  `listInteractions`, `logInteraction`, `listCustomersFiltered` methods on
  `@chaste/api-client`; `Contact` and `Interaction` DTO types.
- **Business partner master data (ADR 0009)**: introduces a platform-level
  `business_partners` table with `type: person | organization`, holding the
  shared identity (name, email, phone, city, country, notes) for any party the
  org has a relationship with. Module role tables (`crm_customers`,
  `pur_vendors`, `hr_employees`, `crm_contacts`) gain a nullable
  `businessPartnerId` FK, one identity per party, multiple roles (customer AND
  vendor, employee AND contact). Platform module owns `core.bpartner.create`,
  `.update`, `.delete` (archive), `.list`, `.get` with Zod schemas, outbox
  events, and audit. New permissions: `core.bpartner.manage`, `core.bpartner.read`.
- **Directory UI**: new `/directory` page (nav: "Directory") listing all business
  partners with type filter, search, KPI strip, create/edit modal, and archive
  confirmation, the single place to manage parties across the org.
- **Horizon A platform**: multi-branch (list/create/update/set_active/grant),
  capability gap tickets, in-app notifications foundation.
- **Horizon A platform (cont.)**: capability catalog (search/list) + placement
  recommender (`core.capability.gap.recommend`) mapping gaps to kernel / private
  cloud / local extension / marketplace.
- **Agent harness (C5)**: `runFollowUpTurn` re-entry for deterministic follow-up
  execution, self-contained worker harness with `status: done|failed`, `firedAt`,
  and persisted `sessionId`.
- **Scheduling & comms (C3/C6)**: calendar CRUD with natural-language event
  creation (block/schedule/book), email outbox with console adapter and worker
  flush, templated invite/reminder/digest/gap-ticket emails.
- **Marketplace (S4)**: publish command gated on confirmed/resolved gap tickets,
  rejecting `platform_roadmap` placements.
- **Platform UI**: calendar week view, reminders, notifications (read/unread),
  capability gap filing with catalog search + placement, branches page, and a
  top-bar branch switcher when the org has multiple accessible branches.
- **Chat**: session history API + top-bar continue/new chat, like/dislike
  feedback, auto titles.
- **Safety**: `resource_link` / `gap_ticket` UiParts with server-side href
  allowlist verification.
- **PWA**: installable web manifest + service worker registration.
- **Evals**: expanded real-world scenario seed set for model readiness.
- ADR 0006 (custom AI orchestration), ADR 0007 (harness memory/self-dev).
- Specs: agent harness, semantic memory, self-development, scheduling/comms,
  portable modules, chat sessions/feedback, UI correctness, PWA/Tailscale
  access, model eval suite, messaging/Buzz, backup and deploy.
- Passive memory inject foundation on chat turns.
- Coding agent provider contract including optional Buzz adapter detection.
- Lightweight prompt-injection guardrails in orchestrator.
- **Foundation**: monorepo scaffold (Turborepo, TypeScript strict, Fastify API,
  Next.js web app, PostgreSQL + Drizzle, kernel command/query bus); business
  modules (CRM, Accounting, Inventory, Purchasing, Manufacturing, HR, Platform);
  custom AI orchestrator + workflow engine; multi-turn conversation intelligence;
  transactional outbox worker; persistent memory; optional Langfuse tracing;
  user management, RBAC, settings, marketplace; and the initial web UI.
- **E2E contract**: `apps/api/src/e2e.ts` exercises the full CRM depth flow
  (update → status → contact → interaction → soft-delete → hidden-from-list).
- **AI harness test suite**: easy / medium / complex humanlike chat scenarios
  across CRM, Accounting, Purchasing, Inventory, and HR (plan → confirm →
  execute, cross-step wiring, multi-turn sessions), plus RBAC permission-denial
  and prompt-injection guardrail coverage.
- Expanded VISION / ARCHITECTURE / product-architecture-next for harness, gaps,
  self-dev, multi-branch, proactive agents.

### Changed

- **API version**: health payload now reports the version from `package.json`
  (single source of truth) instead of a hard-coded string.
- **AI stack**: remove Mastra; custom orchestrator + `AiProvider` + workflow
  engine only (see ADR 0006).
- Config: `mastra.*` observability renamed to `observability.*`
  (`CHASTE_OBSERVABILITY_ENABLED`; old env alias still accepted).
- README rewritten with professional styling, badges, and simpler setup docs.
- Replace em dash punctuation in README for clearer, more consistent formatting.
- Enhanced CRM and vendor forms, admin configuration defaults, and dashboard charts.
- Updated UI components, styles, and theme tokens across the web application.

### Removed

- `@mastra/*` dependencies and Mastra agents/tools/storage wrappers
- Mastra agent fallback path in chat orchestrator

### Fixed

- **Inbox once-only (R2/R3)**: confirm/cancel now resolve the canonical approval
  by its `toolCallId` (not the pending `id`), so approving/denying a multi-step or
  single-command plan updates the durable Inbox item and cross-surface
  "first-responder-wins" actually engages, no more dangling `pending` approvals.
- **Autonomy audit gate**: `effectiveAutonomyForPlan` no longer lets a later
  step's `minAutonomyForAuto` mask an earlier `external`/`exec` confirm floor,
  the reported/audited autonomy for a plan is now the strictest step.
- **Channel session re-homing**: rebinding a thread target to a new session now
  removes it from the old session's index, so deleting the old session can't
  clobber the fresh binding.
- **Scheduler/email reliability**: a single `notifyUser` failure marks that
  reminder `failed` instead of dropping the whole batch; email outbox gains a
  crash-recovery lease (rows stuck in `sending` past a lease window are reclaimed
  to `queued` and retried).
- **Single-command approvals mirror to the Inbox**, parity with multi-step plans,
  so a single external/write action is approvable from mobile/Slack and from
  unattended sessions.
- **Deterministic scheduling parsers**: `parseScheduleFireAt` / `parseScheduleRange`
  accept an injected clock, enabling stable, timezone-robust unit tests.
- **DB dependency hygiene**: `@chaste/db` now declares its `zod` dependency.

## [0.0.1] - 2026-07-16

### Added

- Initial repository with project vision, architecture docs, and Apache 2.0 license

[0.1.0]: https://github.com/benaiah-muga/ChasteBusinessOS/releases/tag/v0.1.0
[0.0.1]: https://github.com/benaiah-muga/ChasteBusinessOS/commit/12c275c

</details>
