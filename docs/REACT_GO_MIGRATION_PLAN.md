# React and Go migration plan

Status: implementation underway, production routing remains on the legacy owner until parity passes.
Date: 2026-09-27. Decision: [ADR 0070](adr/0070-react-vite-and-go-migration.md).

## Goal and finish line

Replace the Next.js application with a React application built by Vite. Move every
business API, capability implementation, agent runtime, and background worker to
Go. Preserve the behavior users and integrations see, including existing data,
passwords and sessions, permissions, approvals, audit history, agent trajectories,
HTTP contracts, and the demo proofs. The database stays PostgreSQL with the
existing schema and migration history. Faster development is the primary reason
for the change; runtime throughput must not regress.

This is a migration program, not a framework swap. The cutover is complete only
when the production request and worker paths have no TypeScript business code,
the Next.js server is retired, and every gate below passes against the Go and
Vite deployment. TypeScript remains for the browser and generated API types.

## Current Vite and Go completion evidence

Vite Sales can decline sent quotes through `accounting.declineQuote` after explicit
confirmation. The write retains an actor- and organization-scoped exact retry,
and Sales quote data and notices are invalidated synchronously when either scope
changes. The focused API and page tests pass, and an authenticated browser proof
created and declined a synthetic quote through Go with no browser errors.

Vite Inventory reads open reservations through the governed
`inventory.listReservations` capability, validates the full Go response, and
hides results immediately when the actor or organization changes. The panel
states that it shows only the 100 most recent reservations when the result is
capped. Focused API and page suites cover tenant and actor changes, stale reads,
and the cap notice.

Vite Support lists the 20 newest internal tickets through the governed
`support.listTickets` capability, restricted to `support.read` and scoped to the
active organization. Go validates a limit of 1 to 100, runs the query inside
`dbx.WithOrgTx`, and filters by organization. The Vite panel validates the
response and clears cached descriptions on actor or organization changes. The Go
database integration test covers tenant isolation, permission denial, order, and
limits; an authenticated browser proof loaded a synthetic filed ticket from Go
with no browser errors.

The active Vite CRM customer-create, CRM follow-up-draft, Support reply-draft,
Messaging agent-reply, Accounting payment-reversal, and Purchasing
purchase-request paths are Go-owned by default. CRM mutations and Purchasing
request creation use the session capability executor. Accounting reversals
retain scoped intent across pending or uncertain results. Draft generation
reads only the signed-in user's active organization and never sends a message
on its own. Messaging reply generation locks by organization, conversation,
and trigger message, derives effect intent IDs from that source message, and
returns the stored reply on a retry. Runtime proofs use a local
OpenAI-compatible stub when no provider key is configured; that verifies
routing and persistence, not a production AI provider integration. Go
Messaging advertises authored descriptions and closed input schemas for CRM
read and write capabilities and the Accounting receivables aging report. Other
supported Go capabilities are not exposed to model tool calls until their input
contracts are authored and tested, so broad operational tool-call reliability
remains unverified. The messaging trigger lock is process-local, so this path currently
assumes one Go API instance. Add shared coordination before running multiple
API replicas.

Vite period-end FX revaluation reports the net adjustment in the organization's
base currency and the number of foreign currencies changed after a completed
Go result. The confirmation is discarded when the actor or organization
changes, and a late result cannot update the new scope. The focused Accounting
API and page suites pass 195 tests; an authenticated browser load of the Vite
Accounting reports route had no console or request errors. The live workspace
had no foreign receivables, so the completed-result text is covered by the
page test rather than a persisted browser revaluation.

Vite CRM profile undo stores both the previous profile and the expected current
profile under the signed-in actor and organization. Go locks all target
customers and rejects the whole undo or reapply if any snapshot has changed,
so one client's undo cannot overwrite another client's edit. Nine focused
Go parser and database tests cover immediate undo/reapply, uppercase UUIDs,
and stale multi-customer conflicts; the CRM API and page suites pass 123 tests.
An authenticated browser proof created a synthetic customer, edited its name,
and undid the edit through Go. Both governed writes returned HTTP 200 and the
browser reported no errors.

The user did not supply a delivery date or speed target. Phase 0 measures the
current system and locks targets. Until then, the working targets are at least
2x faster median edit-to-ready time for a representative UI change, no more
than 10% slower p95 latency for representative business endpoints, and no
regression in the existing financial and governance proofs. These are proposed
targets, not measured results.

## Repository baseline, measured from this branch

| Surface | Current state | Migration implication |
|---|---|---|
| UI | 30 `page.tsx` files under `apps/web/src/app`; React 19 on Next.js 16.3 | Port routing, layouts, server-rendered data, redirects, print and public views to Vite React. |
| HTTP | 93 `apps/web/src/app/api/**/route.ts` files; 156 explicitly exported GET/POST/PUT/PATCH/DELETE functions, plus the Better Auth catch-all | Inventory each path, method, status, body, stream, cookie, and permission before switching traffic. |
| Framework actions | One exported server action, `switchOrgAction`, recorded in [`docs/migration/server-actions.json`](migration/server-actions.json) | Replace it with a typed `POST /api/org` call in Vite while preserving membership validation, the active-org cookie, and return-to-home behavior. |
| Governance | 312 live registrations across 21 modules, recorded in [`docs/migration/capabilities.json`](migration/capabilities.json); about 307 source `defineCapability(` occurrences in `modules/` | The live registry manifest is authoritative for ids, schemas, risk, permissions, and inverses. Port every registered id and conformance rule; the source occurrence count is only a size signal. |
| Backend assembly | 72 files in `apps/web/src/server/`; `packages/kernel`, `packages/ai`, `packages/db`, `packages/erp-core`, and `modules/*` | Port the domain and orchestration logic, not just route handlers. |
| Worker | `scripts/worker.ts` calls jobs, outbox, and routines | Preserve claims, leases, fencing, retries, and occurrence receipts. |
| Platform integrations | `packages/plugin-kit`, marketplace install, coding-agent discovery/dispatch, and managed AI connections | Preserve signed manifest verification, install state, agent routing, least-privilege dispatch, and secret references. |
| Tests | 139 test files across packages, modules, web, and scripts; demo commands in `README.md` | Keep old tests as the oracle until equivalent Go and browser tests cover their behavior. The demos currently import the TypeScript registry directly, so they must be adapted to drive Go. |
| Toolchain | Go 1.27.1 pinned in `.go-version` and `apps/api/go.mod`; CI installs the pinned version | Local Go API tests and vet are part of `pnpm go:verify`. |

Phase 1 has started with the Go HTTP service, the existing database-backed
health response, graceful shutdown, a transaction-local PostgreSQL RLS helper,
and a dedicated runtime database role that is checked at startup. The governance
policy read now has a short-lived signed session bridge and a development-only
shadow comparison over loopback HTTP or HTTPS; `GO_POLICY_READ=1` opts the GET
into Go after the signed session bridge, while the default route owner remains
legacy until service routing is wired. The ledger read has its own short-lived
`go.ledger.read` assertion and Go PostgreSQL reader; development shadow mode
still returns the legacy response, and `GO_LEDGER_READ=1` opts into Go without
changing the route-ownership manifest. The active Vite organization list and
switch requests use Go's session-authenticated `/api/org` handler, which
verifies membership and issues the existing HttpOnly active-organization
cookie. `GO_ORG_SWITCH` remains only for the legacy Next.js compatibility
bridge. A parallel React 19 and Vite client now builds as static assets and
proxies the Go health check in development.
API-method, page, server-action, live capability, and exported database-table
manifests remain checked in and CI continues to validate them while their
legacy-owned behavior remains in use. The focused active-stack CI gate is
`pnpm verify:vite-go`: it builds the Vite client, then runs Go tests and vet.
CI requires it alongside the migration-era typecheck, lint, test,
route/action/capability/contract census, database continuity, and live proof
checks. The Next.js production build is no longer required. These broader
legacy checks remain until their Go replacements are implemented. The active
Vite organization list and switch requests route directly to Go; the Go
handler is mounted by default unless
`GO_ORG_ROUTE=0`.
The Vite invoice print page fetches exact `GET /api/sales/{orderId}` requests
from Go unconditionally. Go resolves the Better Auth session, validates the
active organization, and reads the order, lines, and branding within tenant
RLS. `GO_SALES_INVOICE_ROUTE=0` unmounts the handler; POST, trailing-slash, and
suffix paths retain their existing owner. Focused handler, proxy, and runtime
database RLS tests cover the cutover.
Phase 2 has internal Go executors for `crm.createCustomer`,
`crm.deactivateCustomer`, `crm.mergeCustomers`, `crm.restoreCustomerMerge`,
`crm.importCustomers`, `crm.undoCustomerImport`,
`crm.restoreImportedCustomers`, `crm.updateCustomerProfiles`,
`crm.restoreCustomerProfiles`, and `crm.reapplyCustomerProfiles`. They recheck
Better Auth session status, verified email, domain-user binding, organization
membership, current role grants, module state, and policy under tenant RLS.
Each effect, existing global ledger chain event, and receipt commits in one
transaction, and same-intent retries are serialized. A server-side signed BFF
adapter validates the private Go origin and response contract. The public
customer and import routes do not call it and remain legacy-owned. The internal
Go approval decision service verifies the exact stored payload and has no
public HTTP route, so it does not change route ownership. Merge restore keeps
the existing caller-supplied snapshot contract from
[ADR 0074](adr/0074-crm-merge-restore-parity.md).

The customer and import API adapters, approval endpoint, agent-tool dispatch,
and system-actor worker assertions remain on the legacy runtime until their Go
paths pass parity gates. Failure injection must confirm that audit append
failure rolls back a Go effect and preserve the existing route's externally
visible failure behavior before any write ownership change. The internal Go
dashboard reader covers the core calculations under tenant RLS, while the
public route, signal producers, HTTP adapter wiring for the report-permission
projection, and UI remain pending their parity gates.

The first Phase 2 customer-to-invoice-to-approved-payment `demo:slice` now
drives customer creation, invoice posting, threshold-gated payment, verified
human approval, and trial balance through Go. TypeScript onboarding remains
fixture setup; the proof persists a verified Better Auth identity, membership,
and open agent session for signed Go assertions. Go also implements dated FX
rate recording, invoice rate snapshots, paired foreign-currency settlement,
realized gain or loss, and paired payment reversal. These capability proofs do
not move the public customer, accounting, or approval routes. Keep those routes
legacy-owned until audit-failure rollback, approval recovery, the public
adapters, and agent-tool dispatch pass their parity gates.
Go and legacy TypeScript rejection now change approval status and append the
ledger event in one transaction; database failure-injection tests confirm audit
failure rolls the status change back. Both runtimes also execute an approved
capability and finalize its approval in the transaction that writes the effect
and execution audit. Failure-injection tests confirm the effect rolls back and
the approval returns to pending. Finish the public adapter and agent-tool
dispatch gates before moving the approval route.
Policy parity uses golden vectors from the TypeScript `OrgPolicyEngine`. For
the current CRM `write` capability, a matching `requires_approval_for: ['write']`
rule does not gate an otherwise permitted human in the TypeScript runtime; keep
that behavior during the port rather than adding a Go-only approval gate.
The Vite shell now includes the active-organization selector. It reads and
switches through `/api/org`, which is served by Go and validates membership
before setting the HttpOnly cookie. Vite listens on
`localhost` so the browser can send the existing host-scoped session cookie
across the port change. Vite sends all API requests to Go, including paths not
yet owned by a specific route selector; unknown Go routes return 404 instead of
falling back to the compatibility app.
Route selectors can disable a specialized Go handler, but they do not restore
Vite-to-Next routing. When a handler is disabled, its request stays on Go and
returns the Go API's response, typically 404.
The dashboard setup checklist `GET /api/setup` now routes through the Go
session handler by default in both the Vite proxy and Go API. Go resolves the
verified session and active organization and retains the `iam.admin` gate. Set
both `CHASTE_GO_SETUP_ROUTE=0` and `GO_SETUP_ROUTE=0` to disable this Go handler;
Vite still sends the request to Go and does not fall back to Next.
The dashboard `GET /api/dashboard` also routes through the Go session handler
by default. Its report-permission fallbacks, tenant-scoped metrics, operations,
pipeline, trend, activity, and signals response were independently reviewed
against the legacy and Vite contracts; set both dashboard route selectors to
`0` to disable the Go handler. Vite still sends the request to Go.
The dashboard response, organization selector, cache headers, authentication
challenge, and handler error statuses are now documented in the generated
business OpenAPI contract. Vite keeps its strict Zod validation and uses the
generated OpenAPI response type for dashboard data.
The dashboard setup checklist response and authentication behavior are also
documented in the business OpenAPI contract. The Go handler and Vite client use
generated response models, with Vite retaining its runtime check that checklist
links stay on the application origin. Query parameters remain ignored. When
enabled, the exact Go route owns `/api/setup` for every method and rejects
unsupported methods before auth; suffix paths continue to the base router.
The existing Next.js application continues to own production traffic during
the transition. Vite routes use their paired selectors independently.
The Vite `/approvals` preview reads the tenant-scoped inbox through Go and
submits decisions through the session-authenticated Go handler by default.
`GO_APPROVALS_READ_ROUTE` / `CHASTE_GO_APPROVALS_READ_ROUTE` and
`GO_APPROVALS_DECISION_ROUTE` / `CHASTE_GO_APPROVALS_DECISION_ROUTE` control the
Vite routes independently. `GO_APPROVAL_DECISION` and `GO_APPROVALS_READ` are
separate selectors for the legacy Next.js signed Go bridges. Go derives the
approval capability and payload digest from the organization-scoped database
row; authenticated Vite browser proof for approval and rejection is recorded
in item 266. The UI refreshes after organization changes and redacts
credential-shaped fields in previews.

The Vite `/ledger` preview now reads existing audit rows through the current
legacy API contract. It preserves the event filters and exposes the full hash
and previous hash on demand without rendering payload contents. The signed-out
route redirects to the existing login flow; fixture-backed browser checks
cover signed-in shell, search, and hash disclosure. No public route owner moved.
Go also implements the internal `crm.customerTimeline` read with the legacy
event source order, summaries, date precision, per-source caps, stable sort,
permission check, and tenant isolation. The public CRM API remains on its
current owner.

A standalone Go webhook outbox worker now claims only webhook metadata through
a narrowly privileged function owner, then reads payloads, acknowledges
delivery, and reconciles uncertain outcomes inside tenant-scoped transactions.
Its dedicated login cannot bypass RLS or access other tables. Retry delays,
provider outcomes, lease renewal, fencing, and no-blind-resend behavior have
database-backed parity tests. A Go marketing email worker now claims only email
rows with the `marketing:` dedupe prefix. Its own non-login claim owner exposes
lease metadata only; its NOBYPASSRLS login reads campaign payloads and only the
customer email, opt-out, and deactivation fields inside the customer's
organization transaction. SMTP messages use the stable provider operation ID
as Message-ID and leave uncertain results closed for reconciliation.
`pnpm worker` starts the Go jobs, webhook, and marketing email workers. The
TypeScript `processOneOutbox` dispatcher remains in source for remaining Next
compatibility producers; this cutover does not claim the whole TypeScript
worker is retired. A separate Go capability-jobs worker now claims only its
verified capability allowlist and reuses existing job rows, receipts,
approval payloads, audit events, and durable-run transitions under a dedicated
least-privilege role. Go can claim and execute `routines.executeRoutine` jobs
through a dedicated agent runner when `GO_ROUTINE_AGENT_RUNNER=1`. The flag
defaults off, and scheduler opt-in does not enable routine execution. It
resolves the stored workspace AI provider or the environment fallback only
when the organization has no stored AI config, decrypts the shared AES-GCM
credential format, creates routine sessions and events, runs a six-step
OpenAI-compatible tool loop, and dispatches schema-described CRM customer,
saved customer views, employee roster, leave balance,
invoice, receivables aging, quotes, customer statement, income statement, trial balance,
balance sheet, cash flow, budget scenarios,
inventory stock report, stock movement history, lots, reservations, supplier statement,
AP aging, purchase-order receipts,
production-run history, work-order lists, BOM trees and reports, production cost
previews, lot traceability, and production feasibility,
and support read tools through the Go system capability executor.
These tools use the existing read-mostly routine permission bundle, so a
routine cannot reach a capability whose permission the legacy bundle withholds
(for example `sales.read` or `pos.read`). A
database-backed integration test covers scheduled and manual runs through a
governed CRM read and inventory report, verifies stock-history tenant isolation,
shared-view-only access for a system actor, refusal rather than an empty answer
for a cross-tenant employee leave balance,
receivables-aging, customer-statement, AP-aging, budget-scenario, lot,
reservation, and purchase-order receipt totals, income-statement,
trial-balance, balance-sheet, and cash-flow totals and tenant isolation,
and session-linked audit history.
Broader routine tool parity remains
open because legacy read capabilities in other modules still do not have Go model
input schemas. The seven legacy manufacturing read capabilities now have explicit
Go schemas and permission mappings; the Go-only manufacturing overview report is
not advertised to routines.
Due routine discovery can move to Go behind
`GO_ROUTINE_SCHEDULER=1`, which defaults off; the TypeScript worker skips only
routine scheduling when this flag is enabled. Go gets a globally ordered,
bounded candidate set through a function-only jobs-worker grant, then claims
each organization's due rows inside `dbx.WithOrgTx` using ordered
`FOR UPDATE SKIP LOCKED`, unique occurrence insertion, linked job creation,
and next-run/status advancement. The Go agent runner stays separately
default-off until its tool and messaging parity gates pass. During staged use,
set `GO_ROUTINE_SCHEDULER=1` on both workers; if
`GO_ROUTINE_AGENT_RUNNER` remains off, keep the legacy worker running to
consume the scheduled routine jobs. Email delivery and broader worker cutover
also remain pending.

The Vite client now includes `/sessions`, `/projects`, and `/analytics`
previews. Analytics preserves permission-filtered dataset discovery, governed
previews, table and chart choices, report output, and HTML download. Its report
composer posts to the existing `/api/analytics` handler through a same-origin
development proxy. The Vite preview also proxies `/api/team` for project
assignee lookup. Analytics component and API tests pass. An authenticated
`agent-browser` proof on 2026-10-11 loaded the Go-backed dataset catalog and
preview, then generated a report with the expected table and chart. The Go
dataset, preview, and report requests all returned 200.

Sessions
preserve the existing selection, event sequence, replay, durable-run, and
metrics response contracts. Projects preserve module availability, board and
task ordering, governed writes, archive confirmation, and `202` approval
notices. Vite Projects reads use Go's `/api/projects` and `/api/team` routes;
mutations use Go capabilities. Proof 389 confirms the authenticated browser
flow for project and task writes, assignment, movement, and reload recovery.

Go implements all five Projects write capabilities through the governed
executor. DB-backed proofs cover module and grant checks, verified-session and
tenant scope, approval payload replay, audit rollback, and durable receipts.
Vite sends project collection reads to Go's `/api/projects` route, board reads
through Go capabilities, and project mutations through session-authenticated
capabilities. The route manifest marks both `/api/projects` methods Go-owned
and verified; proof 389 verifies the Vite flow.

The React Projects page can independently send project creation, archival, task
creation, movement, and assignment straight to Go's session capability endpoint
with `CHASTE_GO_PROJECTS_WRITES=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`.
Project and board reads use Go APIs, and these mutations use Go capabilities.
The browser stores exact actor and organization scoped action intents for reload
recovery and blocks legacy writes while a Go action has an unresolved result.

Go CRM read parity covers the timeline and task query modes through an
explicit signed opt-in. Vite saved-customer-view writes use Go capabilities;
other unported CRM writes and read modes retain their existing route owners.
The Go metrics reader matches the newest-200-session aggregate,
null-rate, rounding, and organization-scope behavior. Its short-lived signed
HTTP adapter is opt-in through `GO_METRICS_READ=1`; the public route remains
legacy-owned by default. The current route manifest has 163 API methods: 92 methods are
Go-owned and verified, 69 are legacy-owned, and two Better Auth methods are
assigned to Go auth with endpoint compatibility parity still open. Vite owns all 30 page entries as
verified.

The key seams are `apps/web/src/lib/api.ts` (HTTP and 202 approval semantics),
`apps/web/src/server/auth.ts` and `session.ts` (identity and active org),
`apps/web/src/server/kernel.ts` and `unit-of-work.ts` (registry, audit, and
transaction), `packages/db/src/client.ts` (tenant RLS context), and
`apps/web/src/server/jobs.ts` (durable worker claims). The current
`packages/db/src/migrate.ts` owns the migration advisory lock and pre-change
backup behavior. Phase 0 records exact manifests from these sources.

`docs/migration/route-ownership.json` is generated from the route source.
Method-level owner and parity changes belong in
`route-ownership-overrides.json`; the generator rejects duplicate or stale
keys and prevents a route from moving to Go or Vite before parity is verified.
The current manifest records 89 verified Go-owned business API methods, 71
legacy-owned methods, and two auth methods assigned to Go with
compatibility parity pending. All 30 page entries are Vite-owned and verified.
Owner changes are recorded after their implementation and runtime evidence is
reviewed.

Local verification on 2026-10-04 passed `pnpm typecheck`, `pnpm lint`,
`pnpm test`, and `pnpm go:verify` with `GO_DATABASE_URL` set to the
least-privilege runtime role. The verified local demo set includes the Go
slice, M2-M13, M4b, and support. At that time, the Dashboard, Projects, and
Analytics browser gates remained open. Subsequent Dashboard and Analytics
proofs passed with `agent-browser`; the Projects browser gate later passed in
proof 389.
Remaining routes retain their recorded owners until their parity and runtime
gates pass.

The Phase 0 behavior census is recorded in
[`continuity-inventory.md`](migration/continuity-inventory.md) for data,
identity, approvals, audit, agent history, and demo continuity;
[`workers-events.md`](migration/workers-events.md) for worker and event
semantics; and [`integrations.md`](migration/integrations.md) for provider,
plugin, coding-agent, webhook, notification, and SSO/SCIM boundaries. The
exported Drizzle table roster is [`data-tables.json`](migration/data-tables.json).
These inventories are source-cited migration inputs, not proof that the Go
implementation has parity.

The census leaves several explicit decisions before the related routes or
workers move: marketplace reads return unverified statuses and installer-org
IDs, and plugin verification lacks the capability permission check; creating a
webhook routine exposes its bearer token in the model tool result; the SCIM
item-route expiry and throttling behavior needs a direct proof; no general
production durable-run dispatcher or outbox reconciliation endpoint was found.
The earlier async OCR gap is now covered by the database-backed Go uploaded-file
worker proof in `apps/api/internal/jobs/document_ocr_worker_integration_test.go`,
which uses a deterministic parser and makes no provider request. The other
open items remain recorded in the integration and worker inventories. Preserve
current behavior only after the owner accepts a documented risk or defines a
versioned correction, then add the resulting decision to the applicable parity
gate.

The CRM merge review found that `crm.restoreCustomerMerge` accepts
caller-provided snapshots and checks only that the referenced customer rows
exist in the same organization. It can overwrite later profile edits or
reactivate records that were not produced by the referenced merge. The user
requirement to preserve current behavior settles this migration decision:
Go keeps the same snapshot contract, and hardening remains a separate,
versioned behavior change for both runtimes. The risk stays visible in the
merge parity gates.

## Target runtime

```text
Browser: React + Vite + typed HTTP client
                 |
           one public origin
                 |
      Go HTTP router and static assets
        |                 |
        | business API     | auth endpoints
        v                 v
   Go capability       Go auth (local default)
   kernel, modules      (compatibility parity pending)
        |                 |
        +--------+--------+
                 |
           PostgreSQL + pgvector

Go worker: jobs + outbox + routines + durable agent runs -> same Go kernel
```

Use one origin for browser requests so cookie scope and relative `/api/*` calls
stay stable. The route ownership manifest records the intended local route
owners; Vite and Go use paired environment selectors, while production ingress
is configured separately. While migration is underway, it assigns each UI path
to either the legacy app or Vite, each business API path to either its legacy
handler or Go, and `/api/auth/*` to the auth owner:

```text
/api/auth/*                 -> Go auth locally; legacy compatibility parity pending
/api/* owner=go             -> Go business API
/api/* owner=legacy         -> legacy API handler until its Go port passes
UI path owner=vite           -> Vite-built React app served as static assets
UI path owner=legacy         -> legacy app until that page is ported
```

Vite's method and path selectors mirror the manifest in development. In
production, the ingress serves Vite assets and forwards only configured
legacy-owned paths to the old app. Every
route and capability has exactly one owner at a time. Legacy handlers may
continue to serve unported work, but they never shadow a Go write or create a
second audit path. Once no business API or UI path remains legacy-owned, the
old app can be removed after auth compatibility and production ingress gates
pass.

The local Vite proxy and Go API now assign the whole `/api/auth` namespace to
Go by default. The route ownership manifest records `owner: auth` while
Better Auth endpoint compatibility remains `pending`: Go implements the
Vite client's sign-in, signup, verification, recovery, session, and sign-out
flows, and unsupported paths fail closed instead of reaching the legacy
catch-all. This ownership entry does not claim parity for unsupported
Better Auth endpoints. Production reverse-proxy ownership is configured
separately and must be checked in each deployment. The final Go auth
compatibility gate requires evidence that existing password hashes,
active sessions, and browser cookies remain usable without a password reset
or forced sign-in. If compatibility fails, keep the auth bridge and leave
the Node-free retirement gate open until a compatible port is proven.

## Non-negotiable contracts

1. **Single governed action path.** Human, agent, webhook, and worker actions
   enter the same Go capability executor. Validation, module enablement,
   permission, policy, exact-payload approval verification, action receipt,
   effect, and audit keep their existing order and fail-closed behavior.
2. **Transactional truth.** A business effect, receipt, and audit entry commit
   or roll back together. Posted financial documents remain immutable;
   corrections are reversals. Money stays in integer minor units.
3. **Tenant isolation.** Every Go transaction sets `app.org_id` locally for
   PostgreSQL RLS. Unverified mailboxes inherit no pre-provisioned org role.
   The active-org cookie is a hint checked against memberships on every use.
4. **Audit continuity.** Go appends to the existing hash chain using byte-for-
   byte compatible canonicalization and locking. Old and new entries verify as
   one chain; historical rows are not rewritten.
5. **Wire compatibility.** Keep URLs, methods, JSON shapes, meaningful error
   messages, status codes, the 202 pending-approval response, `intentId`
   idempotency, file transfers, and chat streaming until a separately approved
   API version changes them.
6. **Agent continuity.** Preserve registry ids, tool schemas, model-provider
   routing, memory retrieval, session and trajectory records, unknown-tool
   ticket behavior, approval pauses, durable checkpoints, and replay. Preserve
   coding-agent discovery and dispatch, provider connections, and secret
   references without exposing secret values to models.
7. **Worker continuity.** Preserve `FOR UPDATE SKIP LOCKED` claims, fencing
   tokens, lease renewal, retries, outbox idempotency, routine occurrence
   receipts, and graceful shutdown. The Go worker uses the same database rows.
8. **Plugin integrity.** Preserve canonical manifest signing and verification,
   install state, and the permission boundary around community capabilities.
   Unsigned or tampered manifests remain rejected. Do not expand plugin
   execution behavior as part of the language migration.
9. **Type safety.** Publish one versioned API contract with generated Go
   bindings and TypeScript client types. Validate requests and responses at
   boundaries and reject contract drift in CI. Keep pure domain logic and
   property tests in Go.

## Delivery sequence and exit gates

The phases are dependency gates, not date promises. The first phase produces
an effort estimate from a complete manifest. Work on the UI shell and API
contract can overlap, but a business action changes owner only after its Go
capability and parity tests are green.

| Phase | Deliverable | Exit gate |
|---|---|---|
| 0. Baseline and census | Pin toolchain; export runtime capability ids; enumerate routes, methods, server actions, pages, jobs, events, and data tables. Include plugin signing/verification, marketplace installs, coding-agent detection and connections. Capture current HTTP, browser, database, and demo fixtures. | Every live endpoint, registered capability, plugin flow, and coding-agent flow has a named owner and parity fixture. Current development and request timings are recorded on fixed hardware. |
| 1. Parallel foundation | Add Go module, HTTP server, DB pool, transaction/RLS helper, config, structured logging, health/readiness, Vite app shell, route-ownership manifest and dev/production proxy, generated contract workflow, and CI jobs. Keep legacy routing available. | Go and Vite start locally, an existing session reaches a read-only Go endpoint, each test route resolves to one owner, and no production write is redirected. |
| 2. Trust spine | Port registry, schemas, executor, policy, approvals, receipts, ledger, module gates, transaction boundary, and conformance. Start with the existing customer to invoice to gated payment slice. | Old/Go golden fixtures agree, including audit failure and unknown-outcome behavior; `demo:slice` runs through Go; concurrent approvals and retries produce one effect and one valid audit chain. |
| 3. Business modules | Port pure domain rules then repositories and capabilities by bounded module group: CRM and reads; accounting/sales/purchasing; inventory/POS/manufacturing; HR/projects/expenses; documents/messaging/support/marketing/analytics; IAM, signals, creator, skills, module settings, signed plugin verification, and marketplace install. | Every runtime registry id has a Go implementation and inverse declaration; plugin signature/install flows and each affected demo pass through Go; financial property and DB integrity tests pass. |
| 4. APIs and agent runtime | Port all business routes, uploads/downloads, streaming, AI provider adapters, memory, session trajectory, durable runs, webhooks, external integrations, coding-agent detection/dispatch, and coding-agent connection management. | All business API paths and methods have contract tests; agent golden trajectories, coding-agent adapter proofs, and `demo:support` pass under Go; no TypeScript business route receives traffic. |
| 5. Workers | Port queue, outbox, routines, scheduled agent runs, and document processing to a Go worker. | Crash/reclaim, fencing, at-most-once receipt, retry, and shutdown tests pass; one queue owner is active per job class; all worker demos pass. |
| 6. Vite UI and auth | Port all pages and shared components, including login, onboarding, app shell, public portal, widget, editor, print, accessibility, and error states. Replace framework navigation and server actions with typed calls. Keep sign-in on the Better Auth bridge while Go validates sessions and resolves permissions. | Browser journeys pass for every module; existing sessions remain valid through the bridge; every UI path has Vite ownership; no business route remains on the legacy app. |
| 7. Cutover and retirement | Prove Go handles existing Better Auth password hashes, session rows, verification rules, cookies, sign-in, recovery, and active-organization behavior. Switch auth ownership to Go, route 100% of traffic to Vite/Go, retain reversible deployment and schema compatibility through the observation window, then remove the legacy app and unused TS backend code. Update architecture, setup, ops, and changelog. | Full CI gate, every demo proof, auth continuity tests, RLS and ledger probes, load tests, and restore drill pass. Rollback to the last compatible release is exercised before removing the bridge. |

### Phase 0 benchmark protocol

Use the same machine, dataset, DB state, dependency cache, and process limits
for old and new runtimes. Record ten runs each and publish median and p95 for:

`pnpm benchmark:migration:builds` records ten sequential production builds for
the current Next app, Vite app, and Go services, including wall time and peak
resident memory. Its raw samples and toolchain metadata are written to
`docs/migration/benchmarks/phase-0-builds.json`. This is a build baseline only;
it does not establish UI, request, or end-to-end parity. The 2026-09-29 warm
medians are 24.46s for Next, 11.91s for Vite including TypeScript, and 2.46s
for the three Go binaries. The first cold sample is included in p95, so the
reported p95 is not representative of warm runs. The Vite app is still a
migration shell, so these timings do not compare equivalent feature coverage
or prove a faster development loop.

- cold dev startup until the login and dashboard are usable;
- warm edit-to-ready for one UI component, one business API, and one pure
  domain function, including browser refresh where relevant;
- production build wall time and peak memory;
- p50/p95 latency and throughput for representative read, write, gated
  money action, and chat stream start, with model network time isolated;
- browser navigation readiness for the main dashboard and a dense grid.

The proposed speed targets above become fixed acceptance thresholds after
these baselines. Do not claim faster compile times from language choice alone.
Report frontend HMR and Go rebuild separately so one cannot hide the other.

## Parity and data method

Build golden fixtures from the current TypeScript runtime before porting each
unit. Run old and new implementations against separate copies of the same
sanitized PostgreSQL snapshot. Compare response status and shape, domain rows,
ledger postings, approval records, effect receipts, audit chain, jobs, and
trajectory events. Inject clock and ID sources where a field must match
exactly. Normalize only documented nondeterminism. For read-only routes, a
shadow comparison may run against a snapshot; production writes are never
dual-run. The existing demos call `buildExecutor` and `buildRegistry` directly,
so retain their command names and assertions while replacing that harness
with a Go-facing capability or HTTP test driver. This makes each proof
exercise the migrated runtime rather than certify the old one.

Existing Drizzle SQL migrations remain the historical schema source. No data
copy is needed for the runtime migration. New migrations must keep old and Go
releases able to read and write during the rollback window. Preserve the
existing advisory migration lock, backup, and journal behavior; a Go migration
runner replaces the TypeScript runner only after running both against cloned
databases and proving identical results. Run restore drills before any schema
change that cannot be reversed by code rollback.

The highest-risk comparison fixtures are approval races, cross-org RLS denial,
hash-chain continuation, closed-period and balanced posting guards, stock and
GL reconciliation, job lease expiry/fencing, verified-email identity binding,
agent tool schema and trajectory replay, coding-agent dispatch and secret
references, plugin signature tampering and install state, streamed chat, and
file downloads.

## Cutover and rollback rules

Route ownership is recorded in a versioned manifest with exactly one owner
per path and capability. Switch a capability only after its Go tests, HTTP
contract, database effects, and applicable demo proof pass. A failed canary
returns that unit to the TypeScript owner while both versions share a backward
compatible schema. Do not reverse posted data or delete audit rows as part of
rollback. Roll back code and routing, then investigate the already committed
effects through their receipts and audit records.

At full cutover, compare old and new error rate, latency, queue age, approval
backlog, ledger verification, and database connection usage by organization.
Keep the legacy release deployable until the restore drill and observation
window pass. Retire it only after all business routes, workers, and auth have
new owners and the manifest shows zero legacy runtime paths.

## Program controls

- **Branch:** `react-go-migration` holds this work. Implementation
  should use small reviewable branches from an agreed base; each cutover is a
  separate change with its own gate evidence.
- **Decision record:** ADR 0070 records the target and the single-writer
  migration rule. Further material choices, especially auth protocol and API
  contract generation, receive separate ADRs when their compatibility tests
  settle the details.
- **Verification on every slice:** `pnpm typecheck && pnpm lint && pnpm test`,
  Go build/test/vet, generated-contract drift check, affected demo proof,
  and a browser flow. The complete demo set and DB integrity probes gate
  full cutover. Preserve existing demos until equivalent executable specs
  exercise Go directly.
- **Sizing:** Phase 0 turns the 93 route files, 30 pages, and runtime registry
  into a dependency map and an estimate. The module and UI phases dominate
  effort. A calendar promise made before that inventory would hide the cost
  of the financial and agent parity work.

## Immediate implementation backlog

1. (Done) Pin Go in local setup and CI; add the Go HTTP service, database
   tenant-transaction helper, least-privilege runtime role provisioning and
   startup checks, a parallel Vite React shell, plus build/test commands
   without changing production routing.
2. (Done) Check in the API-method, page, server-action, live runtime
   capability, and database table manifests with CI drift detection; source-cite
   the worker, event, integration, auth/session, data, demo, and action
   continuity inventories.
3. (In progress) Capture old-runtime fixtures and benchmark scripts on a migrated database. Repeatable frontend and Go build timings are recorded by `pnpm benchmark:migration:builds`. The three-run comparison on 2026-10-01 at `9bcce00` recorded median command times of 34.90s for Next, 25.77s for Vite including TypeScript, and 4.41s for the three Go binaries. Vite used 739,596 kB median peak RSS compared with 886,408 kB for Next. The Next p95 was 340.19s because the first cold build took 340.19s; warm samples were 34.02s and 34.90s. Vite took 27.20s, 24.30s, and 25.77s; Go took 3.18s, 4.41s, and 4.59s. Full machine, toolchain, and RSS data are saved in `docs/migration/benchmarks/phase-4-previews.json`. A refreshed three-run development-server comparison on revision `cedea09` recorded median process-spawn to TCP-listener times of 3.491s for Next and 2.767s for Vite, about 21% lower for Vite in that sample. The previous sample measured 4.341s for Next and 4.459s for Vite, showing run-to-run variation. This measurement uses the first TCP listener connection and does not measure route readiness; full samples are in `docs/migration/benchmarks/phase-4-startup.json`. The Vite app does not yet have equivalent feature coverage, and the first cold Next build sample remains in p95. Edit-to-ready, browser navigation, and demo fixtures remain to be measured before claiming faster end-to-end development.
4. (In progress) Define versioned internal and public HTTP contracts and the
  auth bridge contract, then prove each Go endpoint under existing session,
  permission, and RLS policies. OpenAPI 3.1 covers `GET /__go/policy`,
  `GET /__go/ledger`, Support channel GET/POST, module switchboard GET/POST,
  approval inbox GET/decision POST, and the generic
  `POST /api/capabilities/execute` envelope. The module
  switchboard handlers and Vite Settings client use generated Go and
  TypeScript types with runtime validation. The generic capability input and
  output remain open-ended; capability-specific shapes are checked by runtime
  validators. Generated Go and TypeScript models are checked for drift, and
  Vite Support consumes generated request and success-envelope types alongside
  runtime validation. Vite Approvals uses generated request and response
  models while retaining strict runtime validation. Business API contract
  coverage remains incomplete and must expand across Go-owned routes before
  migration completion.
5. Port the kernel trust spine and the customer-to-payment slice; do not
   switch any write before its parity and rollback gates pass.
6. (Done) Bridge only `POST /api/accounting` invoice creation to the existing Go
   capability executor behind `GO_ACCOUNTING_CREATE_INVOICE=1`. Preserve the
   legacy owner by default, the approval response contract, and fail-closed
   behavior for unknown write outcomes.
7. (Done) Add Go parity for CRM deal creation, stage changes, and lead
   conversion, including the capability jobs worker path. Bridge only those
   public POST actions behind `GO_CRM_DEAL_WRITES=1`; keep reads, unrelated CRM
   actions, and route ownership on the existing defaults until parity passes.
8. (Done) Add Go parity for CRM task creation, completion, and detail
   updates, including the capability jobs worker path and inverse restore. Bridge
   only those POST actions behind `GO_CRM_TASK_WRITES=1`; keep reads, follow-up
   drafting, and route ownership on their existing defaults until parity passes.
9. (Done) Add Go parity for sales order creation, confirmation, delivery, and
   cancellation, including stock reservations, credit guards, invoice posting,
   and the capability jobs worker path. Bridge those POST actions behind
   `GO_SALES_WRITE=1`; order listing and unrelated sales actions stay legacy.
10. (Done) Add Go parity for accounting quote creation, acceptance, decline,
    and expiry sweeps, reusing the shared invoice posting path, plus the
    capability jobs worker path. Bridge the dedicated quotes route actions
    behind `GO_ACCOUNTING_QUOTES_WRITE=1`.
11. (Done) Add Go parity for recurring invoice template creation, pausing, and
    resumption, plus the capability jobs worker path. Bridge the dedicated
    recurring route actions behind `GO_ACCOUNTING_RECURRING_WRITE=1`.
12. (Done) Add Go parity for HR employee hiring, deactivation, listing, and
    structure updates, plus the capability jobs worker path. Bridge those POST
    actions behind `GO_HR_EMPLOYEE_WRITES=1`; leave, payroll, and time tracking
    keep their existing handlers.
13. (Done) Add Go parity for expense claims, vendor bills, inventory stock and
    transfers, and POS sessions, sales, returns, and summaries. Register their
    capability schemas, parsers, governed executor paths, approval payload
    verification, and narrow worker permissions. Bridge covered public actions
    behind the independent default-off flags `GO_ACCOUNTING_EXPENSE_WRITES`,
    `GO_PURCHASING_BILL_WRITES`, `GO_INVENTORY_STOCK_WRITES`, and `GO_POS_WRITES`.
    Other actions remain on their existing handlers.
14. (Done) Add Go parity for purchase order creation, including line defaults, SKU links,
    tenant scoping, approval verification, receipt replay, and the capability jobs
    worker path. Bridge only `createPurchaseOrder` behind the independent,
    default-off `GO_PURCHASING_PO_WRITES` flag.
15. (Done) Add Go parity for inventory cycle-count creation, count recording,
    posting, and cancellation through the governed executor and jobs worker.
    Preserve item-wide movement watermarks, location-scoped snapshots and
    adjustments, tenant isolation, approvals, audit, replay, and response shapes.
    Bridge only those four actions behind default-off
    `GO_INVENTORY_CYCLE_COUNTS`.
16. (Done) Add Go parity for purchase order receiving through the governed
    executor and jobs worker. Preserve duplicate-line aggregation, accepted and
    rejected quantities, authority-gated over-receipt, stock and service-line
    behavior, three-way matching, tenant isolation, approvals, audit, replay,
    and response shapes. Bridge only `receiveGoods` behind default-off
    `GO_PURCHASING_RECEIPT_WRITES`.
17. (Done) Add Go parity for credit notes and journal entry reversals, bank
    reconciliation writes, the purchase request and RFQ workflow, and the
    inventory item and location master through the governed executor and jobs
    worker. Preserve posting, approval gating, audit, replay, and response
    shapes. Bridge `creditNote` and `reverseEntry` behind default-off
    `GO_ACCOUNTING_INVOICE_OPS_WRITE`, the banking writes behind
    `GO_BANKING_WRITES`, the request workflow behind
    `GO_PURCHASING_REQUEST_WRITES`, and the item master behind
    `GO_INVENTORY_ITEM_WRITES`.
18. (Done) Add Go parity for budget scenarios, period-close workflows, inventory
    imports and reservations, supplier payment runs, and purchase returns.
    Preserve tenant isolation, approvals, audit/replay receipts, worker
    permissions, legacy HTTP responses, and fail-closed default-off bridges.
19. (Done) Add Go parity for expense policy updates through the governed
    executor and jobs worker. Preserve organization-scoped upserts, approvals,
    audit, receipt replay, and response shapes. Bridge `setPolicy` behind the
    existing default-off `GO_ACCOUNTING_EXPENSE_WRITES` flag.
20. (Done) Add the separately governed Go expense policy read and bridge the combined
    claims and policy response behind default-off `GO_ACCOUNTING_EXPENSE_READS`.
    Keep `accounting.listExpenseClaims` output and agent behavior unchanged.
21. (Done) Port the team and role management screen into the Vite React app with
    validated API contracts and the existing `/api/team` behavior, including
    approval-pending notices, invitations, role assignment, and permission
    editing. Its opt-in Go IAM API bridge is recorded in item 24; the production
    page and API owners remain legacy until staged routing is verified.
22. (Done) Bridge customer import and undo through the existing governed Go CRM
    capabilities behind default-off `GO_CRM_IMPORT_WRITES`. Preserve row
    normalization, duplicate decisions, partial-row errors, approval responses,
    and uncertain-outcome handling. The route owner remains legacy.
23. (Done) Bridge customer creation, deactivation, merge, merge undo, and
    profile updates through existing governed Go CRM capabilities behind
    default-off `GO_CRM_CUSTOMER_WRITES`. Preserve response and approval
    behavior, with fail-closed handling for uncertain outcomes.
24. (Done) Add Go parity for the Team & Roles API capabilities and bridge
    `GET|POST /api/team` behind default-off `GO_IAM_TEAM`. Preserve the full
    registry-derived permission catalog, identity approval behavior, owner
    protections, and invitation acceptance compatibility. Focused parser,
    executor, bridge, and route tests pass, including database-backed RLS and
    concurrent last-owner proofs. The route remains legacy-owned by default.
25. (In progress) Port the CRM workspace to Vite using the same-origin CRM,
    customer, deal, task, team, and import APIs. The `/crm` app route and nav
    run inside the existing authenticated shell; a focused test confirms direct
    unauthenticated access reaches Better Auth before CRM APIs load. Preserve
    pipeline actions, lead conversion, AI follow-up drafting, customer profiles
    and merges, saved views, imports and undo, tasks, approvals, deal
    board/table/search, customer timelines, bulk customer owner/tag updates,
    selected-customer CSV export with the legacy columns and spreadsheet
    formula protection, and task views for due today, overdue, unassigned, and
    all tasks with an option to include completed work. Opening a task source
    from an AI draft reveals completed tasks so the linked record receives focus.
     Focused API and component tests pass. Item 185 routes the Vite list reads
     directly to Go. CRM mutations and other legacy routes remain to be cut
     over; authenticated browser proof remains open.
     Vite AI follow-up drafting now posts to the session-authenticated Go
     `/api/crm/follow-up-draft` route with no legacy fallback. Go verifies the
     active organization and `crm.read`, rejects do-not-contact customers,
     obtains source records through `crm.customerTimeline`, enforces the
     existing eight-drafts-per-minute limit, and uses the configured workspace
     provider or connected personal coding plan. Focused Go/Vite tests cover
     route ownership, authorization, source filtering, and response validation.
26. (Done) Add an opt-in Go read for the approvals inbox and recent history
    behind `GO_APPROVALS_READ`. Bind the complete TypeScript capability
    permission map to the signed request, and recheck the verified session,
    organization membership, and live grants in Go. Preserve status filters,
    ordering, limits, attribution, ISO timestamps, and org-scoped document
    titles. The legacy GET remains the default and decision writes are
    unchanged. Focused route and database parity tests pass.
27. (Done) Add the governed `crm.listDeals` capability and an opt-in signed Go
    read for `GET /api/deals` behind `GO_CRM_DEAL_READS=1`. Preserve the
    org-scoped left join, 200-row limit, response fields, and ISO timestamps.
    Keep the legacy route owner and default behavior; fail closed after Go
    dispatch if the service or response is invalid.

28. (Done) Add Go parity for tax profile and tax code masters, the sales
    tax return lifecycle (create, cancel, restore, submission, amendment,
    acknowledgment, filing), HR leave requests and time tracking, and HR
    payroll runs with the applicant pipeline through the governed executor and
    jobs worker. Preserve posting, approval gating, audit, replay, and response
    shapes. Bridge `fileSalesTaxReturn` behind default-off
    `GO_ACCOUNTING_TAX_RETURNS_WRITE`, the leave and time writes behind
    `GO_HR_LEAVE_TIME_WRITES`, and the payroll and applicant writes behind
    `GO_HR_PAYROLL_APPLICANT_WRITES`.

29. (Done) Add the governed `crm.listCustomerViews` capability and an
    opt-in signed Go read for `GET /api/crm/views` behind
    `GO_CRM_VIEW_READS=1`. Preserve organization scope, shared and current-user
    private view visibility, pinned/update ordering, response fields, and ISO
    timestamps. Keep legacy route ownership and defaults; fail closed after Go
    dispatch when the service or response is invalid. Focused Go DB, signed
    handler, and BFF response tests pass.

30. (In progress) Add governed Go parity for accounting reports and FX
    revaluation, inventory valuation and read models, and purchasing bill
    credits, purchase order closure, and receipt listing. Capability parsers,
    organization-scoped executor paths, approval verification, and worker
    support are in place. System money jobs use configured amount thresholds
    and require an executing human approval for unknown or above-threshold
    amounts. Accounting report reads and FX revaluation have governed executor
    proofs. A concurrent payment proof confirms two simultaneous partial
    payments cannot exceed the invoice balance. A governed Purchasing executor
    proof confirms concurrent bill payments cannot exceed the outstanding
    balance or duplicate payment postings. Inventory valuation posting
    and reversal, stock adjustment approval, the stock report, item history,
    and lot listing have governed executor proofs. The stock-adjustment proof
    verifies pending-state immutability, audit attribution, and same-SKU
    cross-organization isolation. Purchasing bill credit, purchase order
    closure, and receipt listing also have executor proofs. The receipt-history
    DB proof includes legacy stock movements in order-line accepted and
    remaining totals without synthesizing receipt records.
    Accounting report currency metadata now has a dedicated signed Go read.
    Its Go input parser now has a regression proof for Zod-compatible unknown
    key stripping. Broader inventory and purchasing parity proofs and route
    ownership changes remain open; route defaults stay on the existing owners
    until those gates pass.

31. (Done) Add Go parity for `crm.saveCustomerView` and its inverse,
    `crm.restoreCustomerView`, behind default-off `GO_CRM_VIEW_WRITES=1` on the
    existing `POST /api/crm/views` route. Preserve signed human session and
    `crm.write` checks, organization scope, private-view ownership, approval
    handling, audit and replay receipts, previous-state snapshots, and the
    legacy response contract. Keep route ownership on the legacy handler and
    fail closed after Go dispatch. Focused Go DB and BFF route tests pass.

32. (Done) Add default-off signed Go reads for the report capabilities and
    dedicated `accounting.reportCurrencyMetadata` capability consumed by
    `GET /api/reports`. Preserve the report response shape, base currency,
    sorted distinct unsupported-currency metadata, and optional null behavior.
    Keep TypeScript report ownership and metadata reads as the default; Go
    metadata queries use the governed accounting permission and organization
    transaction. Focused route and Go organization-scope tests pass.

33. (Done) Add a default-off signed Go read bridge for `receiptDetail`
    on `POST /api/purchasing`. Preserve the receipt and order-line response,
    millisecond timestamps, and the TypeScript default. Keep Go dispatch scoped
    to this read action, separate from the existing receiving write flag.

34. (Done) Add a default-off signed Go bridge for `closePurchaseOrder` on
    `POST /api/purchasing` behind `GO_PURCHASING_PO_CLOSE_WRITES=1`. Preserve
    the legacy validation, approval and error response behavior, shortfall
    calculation, and response shape. Keep the flag independent from purchase
    order creation, retain the legacy route default, and fail closed after Go
    dispatch without a TypeScript retry. Focused route and Go capability tests
    pass.

35. (Done) Add a default-off signed Go read bridge for item movement
    history on `GET /api/inventory?sku=...`. Preserve the legacy `{ movements }`
    response and missing-item behavior; malformed or unavailable Go results
    fail closed without a TypeScript retry.

36. (Done) Add a default-off signed Go read bridge for `GET /api/quotes`
    using `accounting.listQuotes`. Preserve status filtering, response fields,
    legacy missing-quote behavior, and fail closed on unavailable or malformed
    Go results.

37. (Done) Add a default-off signed Go read bridge for CRM customer
    timelines using `GO_CRM_TIMELINE_READS=1`. Preserve timeline fields and
    task-read isolation, validate timeline kinds, UUID references, timestamps,
    summaries, and object shape, and fail closed when Go is unavailable or
    returns invalid data. Focused route tests cover malformed entries.

38. (Done) Add a default-off signed Go bridge for supplier bill credit
    notes using `GO_PURCHASING_BILL_CREDIT_WRITES=1`. Preserve input mapping,
    approval and validation responses, and fail closed after Go dispatch
    without retrying through TypeScript. Focused route tests and the full Go,
    typecheck, lint, and test gates pass.

39. (Done) Add a default-off signed Go bridge for invoice payment
    recording using `GO_ACCOUNTING_RECORD_PAYMENT_WRITE=1`. Preserve method
    and FX input mapping, approval and validation responses, and fail closed
    after Go dispatch without retrying through TypeScript. Focused route tests
    and the full Go, typecheck, lint, and test gates pass.

40. (Done) Add a default-off signed Go bridge for recording FX rates
    using `GO_ACCOUNTING_FX_RATE_WRITE=1`. Preserve effective-date
    normalization, approval and validation responses, and fail closed after Go
    dispatch without retrying through TypeScript. Focused route tests and the
    full Go, typecheck, lint, and test gates pass.

41. (Done) Add a default-off signed Go bridge for supplier payment
    reversals using `GO_PURCHASING_REVERSE_VENDOR_PAYMENT_WRITE=1`. Preserve
    response mapping and approvals, and fail closed after Go dispatch without
    retrying through TypeScript. Focused route tests and the full Go,
    typecheck, lint, and test gates pass.

42. (Done) Add a default-off signed Go bridge for `accounting.reversePayment`
    using `GO_ACCOUNTING_REVERSE_PAYMENT_WRITE=1`. Preserve the legacy output
    and approval/error responses, validate reversal identifiers and amounts,
    and fail closed after Go dispatch without a TypeScript retry. Focused route
    tests and the full Go, typecheck, lint, and test gates pass.

43. (Done) Add a default-off signed Go read bridge for `sales.listOrders`
    using `GO_SALES_LIST_ORDERS_READS=1`. Preserve status filtering and the
    `{ orders }` response; fail closed on unavailable or malformed Go results.
    Focused route tests and the full Go, typecheck, lint, and test gates pass.

44. (Done) Add a default-off signed Go read bridge for the main inventory
    stock report and reorder alerts using `GO_INVENTORY_STOCK_REPORT_READS=1`.
    Preserve report fields and alert calculations, keep other reads on their
    existing handlers, and fail closed when either Go result is unavailable or
    malformed. Preserve authorization response statuses. The 43 focused route
    tests and the full TypeScript, Go, vet, and contract gates pass.

45. (Done) Add a default-off signed Go read bridge for the authored-document
    list using `GO_DOCUMENTS_LIST_READS=1`. Preserve organization scope,
    version counts, metadata, ordering, ISO timestamps, and the combined
    `{ documents, templates }` response. Keep template reads on the legacy
    executor and fail closed when Go is unavailable or returns malformed data.
    The focused Go database and seven BFF route tests pass, as do the full
    TypeScript, Go, vet, and contract gates.

46. (Done) Add a default-off signed Go bridge for the governed
    `accounting.listInvoices` read in `GET /api/accounting`. Validate every
    invoice row, preserve the existing response and permission behavior, and
    fail closed after Go dispatch without a TypeScript retry. Focused route
    tests pass (66 tests), as do web typecheck and targeted ESLint.

47. (Done) Add a default-off signed Go read bridge for purchase requests and
    RFQs in `GET /api/purchasing` using `GO_PURCHASING_WORKFLOW_READS=1`.
    Preserve decision reasons, vendor names, quote notes, organization scope,
    request ordering, timestamps, and the aggregate route response. The Go
    read model and TypeScript capability contract include every field the
    route exposes; unavailable or malformed Go responses fail closed without
    a TypeScript retry. BFF route tests pass, and the Go database query parity
    test passes with the repository database configured.

48. (Done) Add a read-only Sales orders preview to the Vite app using the
    same-origin order and customer APIs. Preserve module enablement, customer
    names, user display currency and core minor-unit rules; provide search,
    status labels, backorder, loading, empty, and error states. Keep all existing
    quote and order actions available in the full Sales workspace. Vite API
    and component tests pass.

49. (Done) Add a default-off signed Go read bridge for `purchasing.listPaymentRuns`
    on `GET /api/purchasing/payment-runs` using
    `GO_PURCHASING_PAYMENT_RUN_READS=1`. Preserve organization scope, run state,
    timestamps, journal references, and bill-level remittance details. Validate
    the complete response and fail closed after Go dispatch without a TypeScript
    retry. Focused route tests pass, and the Go database test verifies run
    ordering, remittance lines, and organization isolation.

50. (Done) Add a default-off signed Go read bridge for the POS
    `shiftSummary` action using `GO_POS_SHIFT_SUMMARY_READS=1`. Preserve the
    existing authenticated, organization-scoped capability execution and
    response shape, validate summary fields, and fail closed after Go dispatch
    without a TypeScript retry. Focused route tests cover the default-off path,
    enabled Go dispatch, and malformed Go responses.

51. (Done) Add a default-off signed Go read bridge for the inventory transfer
    list in `GET /api/inventory` using `GO_INVENTORY_TRANSFER_READS=1`. Preserve
    the legacy 50-row limit, source and destination codes, notes, SKU lines,
    quantities, confirmation quantities, and organization scope. Malformed or
    unavailable Go results fail closed without retrying the transfer query in
    TypeScript. Focused route and Go database parity tests pass.

52. (Done) Add read-only Vite previews for inventory stock levels and POS shift
    summaries. Validate same-origin API responses, respect inventory module
    enablement, preserve currency minor-unit formatting, provide loading, empty,
    and error states, and link to the full workspaces for existing actions.
    Focused Vite component and authenticated-shell tests pass.

53. (Done) Add read-only Vite previews for accounting invoices and supplier
    payment runs using the existing authenticated API routes. Validate response
    shapes, preserve each invoice or run currency's minor-unit formatting,
    provide recoverable loading, empty, and error states, show a disabled state
    when either module is off, and link to the full workspaces for existing
    actions. Focused API, component, and authenticated-shell tests pass.

54. (Done) Add a read-only Vite purchase receipt history preview using the
    existing same-origin Purchasing APIs. Let the user select a purchase order,
    preserve receipt dates and accepted, rejected, returned, and outstanding
    thousandth-unit quantities, including pre-receipt stock movement rollups,
    validate consumed API fields, and keep the currency-aware purchase-order
    total. Respect Purchasing module enablement, provide accessible loading,
    empty, and recoverable error states, and keep receipt writes in the full
    receiving workspace. The full Vite package suite, typecheck, and lint pass.

55. (Done) Add a default-off signed Go bridge for month-end foreign
    receivables revaluation on `POST /api/accounting/close` using
    `GO_ACCOUNTING_FX_REVALUATION_WRITE=1`. Preserve `accounting.post`
    permission checks, the year/month input, approval responses, and all
    revaluation fields. Validate successful Go results and fail closed after
    dispatch without retrying the TypeScript executor. Focused route and Go FX
    database parity tests pass.

56. (Done) Add a default-off signed Go bridge for the existing
    `postValuationSummary` action on `POST /api/inventory` using
    `GO_INVENTORY_VALUATION_SUMMARY_WRITE=1`. Preserve memo defaults,
    `inventory.write` and module checks, approval and error responses, and the
    full posted and no-op result. Validate all successful output fields and
    fail closed after Go dispatch without retrying the TypeScript executor.
    The Go reverse capability remains internal because no reverse action is
    exposed by the existing route. Focused route and Go valuation DB parity
    tests pass.

57. (Done) Add a read-only Vite Accounting period-close readiness preview
    using `GET /api/accounting/close`. Validate the complete consumed response,
    preserve the selected month, task statuses, blocker list, bank reconciliation
    count, and foreign currency exposure, and respect Accounting module enablement
    and existing authentication. Provide accessible loading, empty, disabled, and
    error states. Keep checklist edits, FX revaluation, close, and reopen in the
    full `/accounting/close` workspace. Focused API and component tests, Vite
    typecheck, and lint pass.

58. (Done) Extend the read-only Vite inventory preview with lot SKU,
    lot code, expiry date, and current balance when present in the existing
    inventory response. Keep lot mutations in the full workspace and provide
    accessible loading, empty, and error states. Focused Vite component/API
    tests, typecheck, lint, and production build pass.

59. (Done) Add a default-off signed Go bridge for the existing lot list in
    `GET /api/inventory` using `GO_INVENTORY_LOTS_READS=1`. Preserve the 200-row
    newest-first order, lot id, lot code, SKU, nullable expiration timestamp,
    and exact route fields while keeping inventory read authorization and
    module checks. Extend the registered `inventory.listLots` contract and Go
    output in parity. Unavailable or malformed Go output fails closed without
    retrying the TypeScript lot query. Focused route and Go database parity
    tests pass, as does capability manifest validation.

60. (Done) Extend the read-only Vite Inventory preview with stock location
    codes and names from the existing same-origin API. Validate the consumed
    location fields and provide an accessible empty state. Keep location
    changes in the full workspace. Focused component/API tests, typecheck,
    lint, and production build pass.

61. (Done) Add a default-off signed Go bridge for inventory reservations on
    `GET /api/inventory` using `GO_INVENTORY_RESERVATIONS_READS=1`. Preserve all
    statuses, the 100-row newest-first order, and the full legacy response
    projection while keeping inventory authorization and module checks. Extend
    the registered `inventory.listReservations` TypeScript and Go contracts in
    parity. Unavailable or malformed Go output fails closed without retrying
    the TypeScript reservation query. Focused route and Go organization-scope
    parity tests pass, as does capability manifest validation.

62. (Done) Add a default-off signed Go bridge for inventory cycle-count reads on
    `GET /api/inventory` using `GO_INVENTORY_CYCLE_COUNTS_READS=1`. Preserve the
    20-row newest-first order, location, status, note, timestamps, and complete
    line projection including nullable counted quantities and variances. Keep
    authorization and module checks, validate the Go response, and fail closed
    without retrying the TypeScript query. Route and Go organization-scope tests
    cover the projection and limit.

63. (Done) Extend the read-only Vite Inventory preview with cycle-count headers,
    progress, and expected, counted, and signed variance quantities from the
    existing same-origin API. Validate the response, handle empty and uncounted
    lines, and keep count creation and posting in the full workspace. Focused
    component/API tests, typecheck, lint, and production build pass.

64. (Done) Add a default-off signed Go bridge for accounts payable aging in
    `GET /api/purchasing` using `GO_PURCHASING_AP_AGING_READS=1`. Preserve the
    existing balance filters, workspace currency, response shape, and floor-day
    boundaries at 30, 60, and 90 days. Keep the purchasing.read permission,
    module gate, and organization scope; malformed or unavailable Go output
    fails closed. Go DB parity and route tests cover date edges and tenant scope.

65. (Done) Add an authenticated read-only Vite Purchasing page for accounts
    payable aging. Validate the existing same-origin response, display total and
    age-band balances in the workspace currency, and keep bill actions in the
    full workspace. Component tests cover success, zero balances, disabled
    module, malformed response, retry, and authenticated route navigation.

66. (Done) Extend the read-only Vite Inventory preview with transfer history
    from the existing same-origin API. Preserve the API order, null notes,
    signed requested quantities, and nullable confirmed quantities. Show
    transfer routes and line details in accessible tables, keep transfer
    actions in the full workspace, and cover normal, empty, and signed-quantity
    cases with focused component tests.

67. (Done) Add the Go read for the supplier AP aging report and bridge it
    behind default-off `GO_PURCHASING_AP_AGING_READS`. Preserve aging buckets,
    tenant isolation, and response shapes; other purchasing reads keep their
    existing handlers.
68. (Done) Add Go parity for the manufacturing BOM and work-order surface
    (definition, explosion, costing, feasibility, release, completion,
    cancellation, instant production, reversal, lot traceability, production
    history) and the marketing campaign surface (segments, campaigns,
    opt-out-honoring sends, delivery analytics) through the governed executor
    and jobs worker. Manufacturing and marketing are reachable through
    governed agent and worker dispatch; no public route serves them today.
69. (Done) Add Go parity for HR job opening creation and closure and for
    payment reminder building through the governed executor and jobs worker.
    Bridge opening writes behind default-off `GO_HR_OPENINGS_WRITE` and
    reminder building behind default-off `GO_ACCOUNTING_REMINDERS_READS`.
70. (Done) Add Go parity for the IAM org settings family - module
    switchboard with restore, per-module configuration, the blanket autonomy
    policy, and print branding - through the governed executor and jobs worker
    under `iam.admin`, preserving the protected spine union and previous-state
    snapshot semantics. Settings routes keep their TypeScript handlers.
71. (Done) Add Go parity for the purchasing supplier analytics reads -
    supplier performance (lead time, on-time rate, fill rate, backorders),
    price history, and the running-balance supplier statement - through the
    governed executor and jobs worker under `purchasing.read`.
72. (Done) Add Go parity for authored document version history and single-version
    reads through the governed executor and jobs worker. Bridge the existing
    `GET /api/docs/:id` reads behind default-off `GO_DOCUMENTS_VERSION_READS`,
    preserving tenant scope, author labels, millisecond timestamps, and the
    current response projection.

73. (Done) Validate and bridge the existing period-close readiness read on
    `GET /api/accounting/close` through the signed Go
    `accounting.periodCloseWorkbench` capability when
    `GO_ACCOUNTING_PERIOD_CLOSE_WRITES=1`. Keep TypeScript as the default,
    preserve period, checklist, blocker, and FX exposure fields, and fail
    closed on unavailable, malformed, wrong-period, or wrong UTC window Go
    output. Focused route tests cover default ownership, Go dispatch, and
    response validation.

74. (Done) Add a default-off signed Go bridge for the stock location list in
    `GET /api/inventory` using `GO_INVENTORY_LOCATIONS_READS=1`. Preserve the
    legacy location row fields and code ordering through Go's
    `inventory.listLocationRecords` capability, and fail closed on unavailable
    or malformed output. Route tests cover default TypeScript ownership, Go
    dispatch, response parity, and fail-closed behavior.

75. (Done) Add a default-off signed Go bridge for the
    `accounting.customerStatement` read action on `POST /api/accounting` using
    `GO_ACCOUNTING_CUSTOMER_STATEMENT_READS=1`. Validate currency balances,
    dated rows, and integer minor-unit amounts; preserve the legacy response
    envelope and capability errors; fail closed on unavailable or malformed
    Go responses without a TypeScript retry. Focused route tests cover default
    ownership, dispatch, errors, and response validation.

76. (Done) Add a default-off signed Go bridge for `lookupByBarcode` on
    `POST /api/inventory` using `GO_INVENTORY_BARCODE_LOOKUP_READS=1`. Preserve
    required-input validation, the legacy response envelope, and explicit
    `item: null` misses; validate the full item shape and fail closed on
    unavailable, malformed, or uncertain Go results without TypeScript retry.
    Focused route tests cover default ownership, hits and misses, errors, and
    fail-closed behavior.

77. (Done) Expose Go `crm.listTasks` to routines as the `crm_listTasks` tool
    with `crm.read` and an optional boolean `openOnly` filter. Execute through
    the existing system capability executor and verify the session-linked
    system audit event in the database-backed routine proof. Broader routine
    tool parity remains open.

78. (Done) Expose Go `documents.listDocs` to routines as the
    `documents_listDocs` tool under `documents.read`, with the same input-free
    object contract available to the legacy routine actor. Verify organization
    scope, document metadata and version counts in the provider-visible tool
    result, plus the session-linked system audit event in the database-backed
    routine proof.

79. (Done) Expose Go `documents.listDocVersions` to routines as the
    `documents_listDocVersions` tool under `documents.read`, with a required
    UUID `documentId` matching the legacy capability input. Verify ascending
    version order, nullable notes and authors, `workmate` agent labels,
    millisecond timestamps, tenant-scoped empty reads for a foreign document,
    and session-linked system capability audit events in the database-backed
    routine proof.

80. (Done) Expose Go `documents.getDocVersion` to routines as the
    `documents_getDocVersion` tool under `documents.read`, with required UUID
    `documentId` and positive integer `version` inputs matching the legacy
    capability. Verify the full content object, HTML, nullable note, and
    millisecond timestamp for a local version, deny a foreign-tenant version,
    and assert session-linked system capability audit events in the
    database-backed routine proof.

81. (Done) Add a default-off signed Go bridge for the customer-bound inbox
    list on `GET /api/support` using `GO_SUPPORT_CONVERSATION_READS=1`.
    Preserve legacy response projection and ensure customer filtering happens
    before the 100-row limit, while leaving detail and library reads on their
    existing handlers. Verify the visitor-heavy pagination edge case, invalid
    Go output fail-closed behavior, and default TypeScript ownership.

82. (Done) Expose Go `inventory.listLocations` to routines as the
    `inventory_listLocations` tool under `inventory.read`. Verify code ordering,
    organization scope, and the session-linked system capability audit event
    in the database-backed routine proof.

83. (Done) Expose Go `accounting.listQuotes` to routines as the
    `accounting_listQuotes` tool under `accounting.read`, with the optional
    legacy quote-status filter. Verify status filtering, newest-first order,
    quote totals, nullable expiry and invoice fields, tenant isolation, and
    session-linked system capability audit events in database-backed proofs.

84. (Done) Add a default-off signed Go bridge for recurring-template reads on
    `GET /api/recurring` using `GO_ACCOUNTING_RECURRING_READS=1`. Preserve the
    response shape and authorization/error mapping, strictly validate Go
    output, and fail closed when Go is unavailable or malformed without
    retrying through TypeScript. Focused route tests cover default ownership,
    dispatch, errors, and fail-closed behavior; Go database proof covers
    tenant scope and ordering.

85. (Done) Add a default-off signed Go bridge for the `cashForecast` action on
    `POST /api/accounting` using `GO_ACCOUNTING_CASH_FORECAST_READS=1`. Validate
    the 13-week forecast and integer minor-unit values, preserve the legacy
    response, reject explicit null assumptions while defaulting missing fields
    like TypeScript, and fail closed on unavailable or malformed Go output.
    Focused route tests cover default ownership, dispatch, and fail-closed
    behavior; database proof covers null and defaulted saved assumptions.

86. (Done) Add a default-off signed Go bridge for purchasing price history on
    `GET /api/purchasing` using `GO_PURCHASING_PRICE_HISTORY_READS=1`. Preserve
    the existing summary response shape, validate each history row, and fail
    closed on unavailable or malformed Go results. Focused route tests cover
    TypeScript default ownership, Go dispatch, and failure handling.

87. (Done) Expose Go `crm.customerTimeline` to routines as the
    `crm_customerTimeline` tool under `crm.read`, with a required customer ID
    and optional per-activity result limit. Verify reverse-chronological
    timeline entries, organization scope, and the session-linked system
    capability audit event in the database-backed routine proof.

88. (Done) Add a default-off signed Go bridge for CRM task-list reads on
    `GET /api/crm` using `GO_CRM_TASK_READS=1`. Preserve open-only filtering and
    the existing task response shape, strictly validate rows, and fail closed
    on unavailable or malformed Go results. Verify default TypeScript behavior,
    independent flag dispatch, and fail-closed handling in route tests.

89. (Done) Harden the existing support inbox Go bridge so missing actor context
    and malformed customer IDs or statuses fail closed without TypeScript
    fallback. Verify the strict response schema and no-store 503 behavior in
    focused route tests; document all opt-in route flags in the README.

90. (Done) Add a default-off signed Go bridge for support conversation detail
    reads on `GET /api/support?id=<id>` using
    `GO_SUPPORT_CONVERSATION_DETAIL_READS=1`. Preserve all legacy detail
    fields and the oldest-first 200-message route limit, return 404 for missing
    or unbound conversations, and fail closed on unavailable or malformed
    output. Keep the routine's default 20-message output unchanged when no
    limit is given. Verify with tenant-scoped database parity and route tests.

91. (Done) Close support detail review findings: accept valid uppercase UUID
    query values when matching canonical Go IDs, and fail closed when message
    row iteration returns a database error. Verify the uppercase route case
    and Go support capability tests.

92. (Done) Add a default-off signed Go bridge for the `supplierStatement`
    action on `POST /api/purchasing` using
    `GO_PURCHASING_SUPPLIER_STATEMENT_READS=1`. Preserve the governed
    `purchasing.read` capability, the legacy statement response, no-store
    behavior, and fail-closed handling without a TypeScript retry.

93. (Done) Expose `purchasing.supplierStatement` to Go routines as
    `purchasing_supplierStatement` with a required UUID `vendorId`, the
    `purchasing.read` permission, tenant-scoped result coverage, and a
    session-linked system audit event.

94. (Done) Make supplier statement reads fail closed on bill, credit, or
    payment row-iteration errors, and use stable date/kind ordering to match
    TypeScript behavior for tied rows.

95. (Done) Add explicit `Cache-Control: no-store` headers to the Go-backed
    invoice-list responses from `GET /api/accounting`, including error paths.

96. (Done) Close the inventory location bridge review finding by adding a
    separate tenant-scoped `inventory.listLocationRecords` capability with the
    full legacy row fields. Remove the follow-up TypeScript location query from
    the Go route while keeping `inventory.listLocations` routine output
    unchanged. Verify organization filtering, timestamp and response parity,
    default TypeScript behavior, and fail-closed Go handling.

97. (Done) Close the latest support and accounting read review findings:
    serialize empty Go support transcripts as `[]` for default and full-detail
    responses, and apply no-store headers to early unauthorized and permission
    denials when Go invoice reads are enabled.

98. (Done) Add a default-off signed Go bridge for the Support library list on
    `GET /api/support?library=1` using `GO_SUPPORT_LIBRARY_READS=1`. Preserve
    the legacy organization-scoped canned response and article projections,
    keep no-store headers, and fail closed without a TypeScript retry. Verify
    response parity and tenant scope with route and database-backed tests.

99. (Done) Add a default-off signed Go bridge for Inventory item metadata on
    `GET /api/inventory` using `GO_INVENTORY_ITEM_METADATA_READS=1`. Preserve
    item IDs and catalog fields merged into stock report rows, organization
    scope, and default TypeScript behavior. Validate Go output strictly and
    fail closed without retrying the TypeScript metadata query.

100. (Done) Add a default-off signed Go bridge for supplier performance in
     `GET /api/purchasing` using `GO_PURCHASING_SUPPLIER_PERFORMANCE_READS=1`.
     Preserve nullable metrics and response fields, and fail
     closed without a TypeScript retry. Check database row-stream errors so
     partial Go metrics cannot be returned as successful results.

101. (Done) Add a default-off signed Go bridge for per-opening applicant lists
     in `GET /api/hr` using `GO_HR_APPLICANT_READS=1`. Preserve the
     `hr.listApplicants` output and default TypeScript path; strictly validate
     results and fail closed without a TypeScript retry when Go is unavailable
     or returns invalid output.

102. (Done) Add a governed Executor-path integration proof for FX revaluation
     and reversal. Verify permission denial prevents writes, revaluation replay
     is idempotent, reversal mirrors journal lines, and both operations create
     audit events.

103. (Done) Match Go stock report average unit cost to TypeScript by dividing
     ledger valuation by the report's projected on-hand level. Add a database
     proof where projected stock differs from movement replay.

104. (Done) Prove `accounting.trialBalance` through the governed Go Executor
     with multiple currency groups, sorted wire output, permission denial,
     organization isolation, and a human audit event.

105. (Done) Prove `inventory.listLots` includes archived-item lot history
     within the owning organization and excludes another organization's lot.

106. (Done) Add focused Vite CRM component coverage for customer merge and
     undo, verifying the chosen survivor and duplicate IDs in the merge request
     and the full returned snapshot in the restore request.

107. (Done) Add focused Vite CRM component coverage for customer import undo,
     verifying only created customer IDs are sent and the undo result is shown.

108. (Done) Add Vite CRM component proofs that profile updates persist contact
     preferences and do-not-contact state, and that an opted-out customer
     cannot request an AI follow-up draft.

109. (Done) Add a Vite CRM component proof that applying a pinned saved customer
     view restores its saved filters and displays the matching customer set.

110. (Done) Add a governed Go Executor proof for the cash flow report, including
     statement parity, sorted unsupported currencies, permission denial,
     organization isolation, and audit recording.

111. (Done) Extend the governed Go FX revaluation proof to cover JPY's zero
     decimal minor-unit conversion and select the rate effective at the final
     millisecond of the accounting period, persisting that rate snapshot and
     posting the matching balanced adjustment.

112. (Done) Prove the Go inventory stock report through the governed Executor
     with ledger-replayed purchase, sale, and transfer movements, exact value
     and availability, organization isolation, and an execution audit event.

113. (Done) Prove governed Go supplier bill-credit execution through approval,
     including permission denial, tenant isolation, bill balance updates,
     mirrored ledger posting, and approval/execution audit events.

114. (Done) Prove the Go balance sheet report through the governed Executor,
     including permission denial, exact ledger-derived totals, organization
     isolation, and an execution audit event.

115. (Done) Preserve CRM task assignment in Vite by loading team members when
     either Customers or Tasks needs them, provide a retry after lookup errors,
     and prove owner selection and task creation from a fresh Tasks tab.

116. (Done) Prove the Go customer statement through the governed Executor with
     exact wire output, customer and organization isolation, permission denial,
     and successful audit recording.

117. (Done) Prove Go purchase-order closure through the governed Executor with
     permission denial, pending approval without mutation, shortfall handling,
     tenant isolation, approval-requested audit, and execution audit.

118. (Done) Prove Go AR aging through the governed Executor with exact legacy
     buckets and invoice ages, status filtering, organization isolation,
     permission denial, and audit coverage.

119. (Done) Prove Vite CRM customer deactivation confirmation, cancellation,
     inactive-directory discovery, profile and invoice-history access, and
     prevention of repeat deactivation.

120. (Done) Prove Go inventory item history and lot listing through the
     governed Executor, including permission denial, exact movement and lot
     values, organization isolation, and human execution audit.

121. (Done) Prove Go inventory valuation posting, permission denial,
     receipt replay, balanced journal lines, reversal, restored GL balance, and
     human execution audit and foreign-organization isolation through the
     governed Executor.

122. (Done) Prove Go purchase receipt history through the governed Executor,
     including permission denial, exact receipt and order-line quantities,
     same-number cross-organization isolation, and human execution audit.

123. (Done) Bridge inventory valuation reversal through the default-off Go BFF
     flag while preserving TypeScript behavior, approval and error responses,
     strict response validation, and fail-closed handling without a retry.

124. (Done) Migrate all 13 Creator proposal, scaffold, plugin marketplace, and
     controlled release capabilities through the governed Go executor, with
     tenant scoping, approval payload verification, audit events, receipts,
     replay behavior, and TypeScript-compatible manifest signatures.

125. (In progress) Add default-off Go BFF bridges for Creator evolution
     mutations and marketplace verification, reads, and writes, and expose
     the Marketplace page in Vite. The Go listing capability preserves all
     listing statuses, all legacy fields, order, and the 100-row limit. The
     HTTP read bridge is opt-in through `GO_CREATOR_MARKETPLACE_READS=1` and
     fails closed on malformed or uncertain results. Human reads require the
     signed, verified session and active-organization membership, then preserve
     the legacy organization-only read contract without requiring
     `platform.browse` or the optional Creator module. Human verification also
     preserves the legacy signed-session and organization-membership access
     without requiring `platform.creator` or the optional Creator module.
     Agent reads and verification continue to require capability permission
     and module enablement; system execution retains its module gate. The Go
     verification bridge preserves structured denial messages. Keep all
     marketplace bridges default-off for controlled rollout.
     Verify route contracts and the Vite app before considering the
     Marketplace flow migrated.

126. (Done) Extend Vite inventory beyond reporting with governed item
     creation and adjustments, locations, reservations and release, cycle
     counts, transfer drafting, full and partial confirmation, and movement
     history. Keep writes on the same-origin inventory contract with intent
     IDs, approval handling, and cautious timeout recovery. Transfer line IDs
     now pass through both legacy and Go read projections for partial
     confirmation. History costs display in the organization base currency and
     respect its minor-unit exponent.
     Focused component, API, and route tests cover the new paths.
     Browser verification remains deferred at the user's request, and the
     legacy inventory route remains available for advanced controls.

127. (Done) Add the Vite People workspace for employee records, hiring,
     leave, time, and payroll draft creation/history through the current
     same-origin HR and time APIs. Preserve `202` approval responses and module
     availability. Payroll execution and voiding, plus Expense controls,
     continue to use the existing workspace; no API ownership moved.

128. (Done) Add an authenticated Vite Documents library and detail preview
     with runtime-validated same-origin reads, search, processing status,
     extracted text, and upload links. Check Documents module availability in
     the client and both read endpoints, project detail columns to omit stored
     base64 and raw text, and serve active or unknown file types as downloads
     with sandbox CSP. The document APIs and production route ownership remain
     legacy-owned; browser verification remains deferred at the user's request.

129. (Done) Add the Vite Products & Services catalog at `/products`, preserving
     inventory module gating, overview and reorder summaries, catalog search
     and filters, product and service creation, metadata edits, archive, and
     opening stock through governed inventory actions. CSV import preserves
     field mapping, validation and preview, duplicate/error reporting, governed
     batch import, and undo. The existing inventory and import APIs remain the
     same-origin authority; browser verification remains deferred at the user's
     request.

130. (Done) Match Go Marketplace verification authorization to the legacy
     route: authenticated humans retain verified-session and active-organization
     membership checks without requiring the optional Creator module or
     `platform.creator`, while agent permission/module gates and system module
     gates remain enforced. Database-backed tests cover human, agent, and system
     paths. Browser verification remains deferred by user direction.

131. (Done) Widen Go routine tool parity with `hr_listEmployees`,
     `hr_leaveBalance`, `crm_listCustomerViews`, `accounting_listBudgetScenarios`,
     `inventory_listLots`, `inventory_listReservations`, and
     `purchasing_listReceipts`. Every new tool declares a model input schema and
     stays inside the legacy read-mostly routine permission bundle, so no
     capability whose permission that bundle withholds becomes reachable from a
     routine. The database-backed routine proof covers each tool's tenant
     isolation, the system actor's shared-view-only customer-view projection,
     refusal rather than an empty result for a cross-tenant leave balance, and
     accepted and remaining purchase-order line totals that exclude foreign
     receipts.
132. (Done) Close the capability coverage gap against the live registry. All
     315 registry ids now have a Go implementation: the 22 `documents`
     capabilities, the 22 `messaging` capabilities, `settings.configureAiProvider`,
     `settings.restoreAiProvider`, and `harness.approveComposition`. Each keeps
     its manifest schema, Zod parser behavior, organization scoping, approval
     payload, audit and receipt contract, and fails closed on malformed input.
     Database-backed proofs cover document tenant isolation, folder ancestors,
     version restore, conversation membership, and attachment handling. Two
     pre-existing Go divergences surfaced and were fixed: `isModuleEnabled` now
     honors the always-enabled `settings` and protected `iam`, `signals`, and
     `routines` modules, and the shared `requiredSafeInteger` parser now rejects
     quoted integers that `z.number()` refuses. Route ownership is unchanged;
     these capabilities are registered in the executor but no path moved owner.
133. (Done) Make the opt-in Go organization route work under the production
     `chaste_app` RLS role. A narrowly granted security-definer function
     validates the Better Auth session token before mapping it to the domain
     identity and membership ids. Go loads permissions and organization fields
     through `dbx.WithOrgTx`, and the organization repository rechecks each
     membership inside its organization transaction. A runtime-role integration
     proof exercises session resolution, organization listing, and the agent
     persona read/write path.
134. (Done) Add a bounded Go inventory slice to the Vite page. With
     `CHASTE_GO_INVENTORY_ITEM_SLICE=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`, the stock table uses
     `inventory.stockReport` and item creation/opening stock/adjustments use
     `inventory.createItem` and `inventory.adjustStock` through the existing
     authenticated Go capability endpoint. The Go executor rechecks identity,
     active organization, module state, and permissions under tenant RLS, then
     records writes through the governed pipeline. Other inventory operations
     and `/api/inventory` route ownership remain unchanged.
135. (Implemented; PostgreSQL and authenticated Vite browser proofs pass) With
     `GO_SESSION_CAPABILITY_ROUTE=1`,
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`, and
     `CHASTE_GO_PURCHASING_VENDOR_SLICE=1`, call `purchasing.createVendor`
     through the existing session-authenticated `/api/capabilities/execute`
     Go route. Go
     derives identity, active organization, email verification, and permissions
     from the authenticated session and executes the write through the governed
     capability pipeline. Vite preserves pending approvals and falls back to
     the existing Purchasing POST only when the Go route is absent. The other
     Purchasing actions still share that legacy POST endpoint, so route-level
     ownership remains legacy. Focused Vite API tests cover Go success, pending
     approval, absent-route fallback, and no retry after an uncertain result.
     The database-backed capability integration test passes. In the local
     authenticated Vite browser, vendor creation returned HTTP 200 from
     `/api/capabilities/execute` and the refreshed Vite vendor list showed the
     new record with no browser page errors.
136. (Complete; focused Vite and Go database tests plus authenticated browser proof passed) Add one
     Sales action to the Vite page: confirm draft orders through the existing
     session-authenticated `sales.confirmOrder` capability. The API validates
     the order id and response, preserves pending approval, and reuses an intent
     id after uncertain transport outcomes. Other Sales actions and route
     ownership remain unchanged. Focused Vite API and page tests cover the
     capability request, approval response, and visible confirmed state. The
     authenticated browser proof is recorded in item 315.
(Implemented; focused Vite and configured PostgreSQL proofs pass) Make Go approval requests idempotent by organization and action intent.
     Persist the intent and canonical input digest on approval rows; serialize
     requests with the executor's existing tenant+intent lock, replay a matching
     pending approval, and reject reuse with a different capability or payload.
     Approved execution reuses the original intent and records its action receipt.
     Vite Sales retains that intent while approval is pending and lets the user
     check the same request until it resolves. Focused client coverage and
     database-backed proofs pass with the configured Go integration database.
138. (Implemented; route ownership remains legacy) Replace the Vite 8.3.1 Go
     API proxy selectors with a middleware plugin. The installed Vite proxy
     path does not invoke the `router` callback previously used by the selectors,
     so Go-enabled requests silently continued to the legacy API. The middleware
     now selects exact method/path pairs before the legacy catch-all, streams
     the original request and response, and preserves legacy fallback for
     unsupported methods and paths. Real Vite middleware tests cover the
     selected routes, body/cookie/query forwarding, response streaming, and
     fallback behavior. Every selector remains paired and default-off. Runtime
     proofs and route-owner changes remain separate gates.
139. (Implemented; Go owns the route by default) Add Go parity for the
     Dashboard work queue read on `GET /api/my-work`. The verified Go session
     determines the active user and organization; work queue reads use
     `dbx.WithOrgTx`, capability permissions filter approvals, and unsupported
     capability IDs are hidden even for wildcard users. The Go API and paired
     Vite selector enable this exact GET route by default, with `=0` opt-outs;
     other methods and paths retain legacy fallback. Focused handler, reader,
     and proxy tests cover the behavior and organization scope.
140. (Complete; GET and POST Go-owned) Go serves session-authenticated
     analytics dataset discovery, previews, and report generation through
     exact `GET` and `POST /api/analytics`. The paired Vite selectors and Go
     mounts are enabled by default and accept `=0` opt-outs; unsupported
     methods and paths continue to legacy. Focused handler and real Vite
     middleware tests pass, and both methods are recorded as Go-owned in the
     route manifest. Authenticated Vite browser proof with Next stopped loaded
     dataset discovery, previewed `analytics.pipelineByStage`, and generated
     the report through Go. The discovery, preview, and generation requests
     returned HTTP 200 while the legacy Next process remained stopped, and
     browser errors were empty.
141. (Implemented; route ownership remains legacy) Add separate default-off
     Vite selectors for Go SCIM reads and writes. Reads cover the user
     collection and UUID items; writes cover collection provisioning and UUID
     item deactivation. Unsupported methods, invalid IDs, and unmatched paths
     continue to the legacy API. Focused real Vite middleware tests verify the
     selectors and fallbacks. SCIM provider-backed proof and route ownership
     remain open.
142. (Implemented; route ownership verified) Add Go `POST
     /api/my-work/summarize` with verified-session and organization checks,
     bounded work-card input, server-side workspace credential decryption, and
     the legacy fast-model to primary-model fallback. Workspace provider URLs
     require public HTTPS endpoints resolved and pinned by the Go transport;
     loopback HTTP is allowed only in explicit development mode. The
     authenticated user's own default OpenCode connection is loaded under that
     session's organization and user, its credential is decrypted on the Go
     server, and OpenCode tools are disabled. Codex uses only that user's
     hashed, persisted `CODEX_HOME`, an isolated temporary working directory,
     and read-only CLI mode with no MCP tools. Unsupported providers and missing
     Codex runtime resources fail closed. The API and paired Vite selectors
     default on at `GO_MY_WORK_SUMMARY_ROUTE=1` and
     `CHASTE_GO_MY_WORK_SUMMARY_ROUTE=1`; Vite selects only exact POST path
     matches. Provider, handler, CLI, route-mount, and selector tests pass. The
     Go runtime must share the configured persistent Codex home and CLI binary
     with the connection setup runtime. Runtime proof remains open.
143. (Implemented; route ownership remains legacy) Add Go `GET /api/signals`
     behind `GO_SIGNALS_ROUTE=1` and paired `CHASTE_GO_SIGNALS_ROUTE=1`.
     Verified session identity and active organization feed the governed
     `signals.list` capability. Severity and module filters, the `{signals}`
     response envelope, and no-store headers match the legacy route. The Vite
     selector is limited to GET `/api/signals`; unmatched methods and paths
     continue to the legacy API. Handler, capability, and middleware selector
     tests pass. Authenticated `agent-browser` direct load of
     `http://localhost:3002/api/signals` returned the Go `{"signals":[]}`
     envelope with HTTP 200; the Vite selector sent `GET /api/signals` to Go,
     and the browser error log was empty. Production route-manifest ownership
     remains open.
144. (Implemented; Go owns the routes in the manifest) Add Go session-admin
     `GET`, `POST`, and `DELETE /api/scim/tokens` behind
     `GO_SCIM_TOKENS_ROUTE=1` and paired `CHASTE_GO_SCIM_TOKENS_ROUTE=1`.
     Listing requires verified organization membership; mint and revoke use
     governed IAM capabilities, verified session identity, and org-scoped transactions.
     Writes require a UUID `Idempotency-Key`; replayed mint never returns raw
     token material, and revocation preserves the standard 202 approval
     response. Only a token hash reaches the capability, receipt, or ledger;
     the raw token is returned once after a non-replayed successful mint.
     Revoke is destructive and has no inverse because the stored hash cannot
     recover the bearer. DB-backed tests cover organization isolation, token
     secrecy, idempotency, and rollback for both writes. Listing preserves the
     legacy organization-member guard and timestamp precision. Provider-backed
     runtime proof remains open.
145. (Implemented; Go route ownership verified) Add Go session list,
     detail, replay, durable-run list/detail, and session metrics reads behind
     `GO_SESSIONS_ROUTE=1`, `GO_DURABLE_RUNS_ROUTE=1`, and
     `GO_METRICS_ROUTE=1`, paired with the matching Vite selectors, which
     default on unless explicitly set to `0`.
     Each Go mount and paired Vite selector can be rolled back by setting
     their flags to `0`. Session and run reads use verified
     identity, active-organization transactions, and initiator/session-owner
     visibility with admin access. Legacy timestamp and response shapes are
     preserved. Both runtimes return 413 for details exceeding the shared
     event, step, or encoded-response limits, and both check owner/admin
     visibility before reporting an oversized durable run. Event and durable
     JSONB logical sizes are checked before their payloads are loaded. Go's
     router dispatches only exact GET collection paths and UUID detail/replay
     paths; invalid IDs, HEAD, other methods, and suffixes retain legacy
     fallback.
     The metrics selector and Go mount dispatch only exact GET `/api/metrics`;
     HEAD, other methods, and suffixes retain legacy fallback. Handler, router,
     and selector tests pass. Runtime proof remains open.
146. (Implemented; Go owns the routes in the manifest) Add the Go notification feed
     at `GET /api/notifications` behind `GO_NOTIFICATIONS_ROUTE=1` and its
     paired Vite selector. Preserve organization and user visibility,
     per-user read receipts, unread totals, and legacy timestamp formatting.
     The React authenticated shell includes the notifications bell. Governed
     per-user read receipts are served through `POST /api/notifications` at
     `GO_NOTIFICATIONS_WRITE_ROUTE=1`, paired with its Vite selector. Handler,
     selector, component, and database coverage are in place. Browser proof
     passed on 2026-10-11 with the installed `agent-browser`: the authenticated
     Vite shell loaded the feed and rendered the unread notification, then
     opening it submitted a read receipt. Both Go-backed requests returned 200,
     the unread badge cleared, and the browser reported no console errors.
147. (Complete) Promote eligible conversation
     sends through the existing session-authenticated `/api/capabilities/execute`
     route to `messaging.sendMessage`. Go rechecks conversation membership and
     attachment ownership under organization RLS, records mentions in the same
     transaction, and returns the message ID used by the declared
     `messaging.deleteMessage` inverse. Stable retry intents and pending
     approvals remain supported. Agent-enabled conversations and @agent
     messages stay on legacy until Go workmate replies are supported. The
     Vite flag is enabled by default and remains paired with the Go session
     capability route. Focused Vite API and Messages page tests plus Go
     capability tests pass. On 2026-10-12, authenticated Vite `/messages`
     sent a user message in a non-agent synthetic channel through Go's
     `messaging.sendMessage` capability with HTTP 200, then rendered the
     refreshed thread; no legacy send request occurred and the browser error
     log was empty. See proof 320.
148. (Complete) Enable the Vite `/team` page's
     session-authenticated `GET` and governed `POST /api/team` routes by
     default in both runtimes. Roll back either method independently by
     setting its Go and Vite selector flags to `0`. Direct Go routing dispatches
     only exact GET and POST requests; HEAD, unsupported methods, and suffix
     paths retain legacy fallback. Go also owns Vite invitation preview and
     acceptance under `/api/auth/invitations/{token}`. Acceptance requires a
     verified session whose email matches the invitation, and commits the
     membership, role, and invitation status in one organization-scoped
     transaction. Handler, selector, and database RLS tests pass. Proof 335
     covers invite creation; proof 337 covers authenticated acceptance.
149. (Implemented; Go route ownership verified) Enable Vite's authenticated
     `GET /api/modules` switchboard reads and the Projects page's
     `GET`/`POST /api/projects` requests through Go by default. Each route can
     be rolled back with its paired Go and Vite flags. Projects dispatch only
     exact GET and POST requests; module requests dispatch only exact GET, with optional POST
     still controlled separately. HEAD, unsupported methods, and suffix paths
     retain legacy fallback. Handler, selector, and full Go verification pass.
     Browser proof remains open.
150. (Implemented; Go route ownership verified) Route only the Vite Sales
     orders collection `GET /api/sales` through Go's verified-session
     `sales.listOrders` capability by default. Preserve the legacy `{ orders }`
     response and known status filters. The direct Go mount and Vite selector
     dispatch only the exact collection GET; POST, HEAD, and suffix paths keep
     their legacy fallback. Pair `GO_SALES_ORDERS_ROUTE` with
     `CHASTE_GO_SALES_ORDERS_ROUTE` for rollback. Handler, router, and selector
     tests pass; browser proof remains open.
151. (Implemented; Go route ownership verified) Route exact Vite `GET` and
     `POST /api/support/channels` requests to Go unconditionally and mount the
     handler by default. Set `GO_SUPPORT_CHANNELS_ROUTE=0` to unmount Go; Vite
     then fails closed for these requests. Other methods and extra paths retain
     their current owner. The handler requires verified organization
     membership, Support module availability, and `iam.admin` for writes, with
     same-origin checks and organization-scoped database access. Focused Go
     handler and Vite proxy tests pass. The Go handler tests use a fake store;
     no runtime-role database upsert proof exists yet. Authenticated browser
     proof remains open.
152. (Implemented; verified) Route only the Vite POS collection
     `GET /api/pos` through Go's verified-session, organization-scoped reader
     and preserve the legacy `{ sessions, sales }` response.
     `GO_POS_READ_ROUTE` and `CHASTE_GO_POS_READ_ROUTE` default on. Set
     `CHASTE_GO_POS_READ_ROUTE=0` to send Vite traffic to legacy; also set
     `GO_POS_READ_ROUTE=0` to unmount the Go endpoint. Unsupported methods
     and suffix paths remain on legacy. Focused handler, router, and selector
     tests plus runtime database integration pass. The `/pos` page remains
     legacy-owned; this milestone moved the Vite API read only. Browser proof
     remains open.
153. (Implemented) Route exact Vite `POST /api/pos/shift-summary`
     through Go's session-authenticated `pos.shiftSummary` capability and
     preserve the legacy response envelope. `GO_POS_SHIFT_SUMMARY_ROUTE` and
     `CHASTE_GO_POS_SHIFT_SUMMARY_ROUTE` default on. Set
     `CHASTE_GO_POS_SHIFT_SUMMARY_ROUTE=0` to send Vite traffic to legacy
     `POST /api/pos`; also set `GO_POS_SHIFT_SUMMARY_ROUTE=0` to unmount the
     Go route. Other POS POST actions remain on legacy. The `/pos` page remains
     legacy-owned. Focused tests, full workspace tests, Go verification,
     typecheck, lint, route ownership checks, and contract checks pass.
     Authenticated browser proof is recorded in item 401.
154. (Implemented) Route Vite POS register opening through the existing Go
     `pos.openSession` capability by default whenever
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set
     `CHASTE_GO_POS_OPEN_SESSION_SLICE=0` to roll back this individual action;
     only a missing Go route falls back to legacy, reusing the same intent.
     Other POS actions and `/pos` page ownership remain unchanged. Focused
     selector and client tests pass. Authenticated browser open/close proof is
     recorded in item 399.
155. (Implemented) Route Vite POS register closing through the existing Go
     `pos.closeSession` capability by default whenever
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set
     `CHASTE_GO_POS_CLOSE_SESSION_SLICE=0` to roll back this individual action;
     only a missing Go route falls back to legacy, reusing the same intent.
     Other POS actions and `/pos` page ownership remain unchanged. Focused
     selector and client tests pass. Authenticated browser open/close proof is
     recorded in item 399.
156. (Implemented) Route only Vite POS customer lookup through a direct Go session-authenticated
     `GET /api/pos/customers` reader, independently of the generic session-
     capability route. Preserve the legacy POS authorization rule:
     verified organization members with either `crm.read` or `pos.sell` may
     read active canonical customer options, with no CRM module requirement.
     Keep name ordering, the 500-row limit, purchase counts, and lifetime net
     spend. Vite always sends this lookup to Go; the legacy request path and
     rollback selector have been removed. `GO_POS_CUSTOMERS_ROUTE=0` disables
     the Go endpoint, causing lookup to fail closed. CRM and Support callers
     remain unchanged. The generated route ownership manifest records the
     Go-only GET as `owner: go, parity: verified`. Focused Go/Vite and manifest
     checks pass; browser proof remains open.
157. (Implemented) Route Vite POS quick product creation and opening stock adjustment through
     the existing Go `inventory.createItem` and `inventory.adjustStock`
     capabilities when `CHASTE_GO_INVENTORY_ITEM_SLICE=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set the inventory item selector to
     `0` to restore both actions to `/api/inventory`. Keep their POS output
     payloads, approval reasons, and separate fresh intent IDs unchanged.
     Other POS actions and page ownership remain unchanged. Focused Vite API
     tests pass. Authenticated quick product and opening-stock browser proof is
     recorded in item 400.
158. (Implemented) Route Vite inventory transfer creation and confirmation through the Go
     `inventory.createTransfer` and `inventory.confirmTransfer` capabilities
     when `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set
     `CHASTE_GO_INVENTORY_TRANSFER_WRITES=0` to restore both actions to
     `/api/inventory`. Preserve transfer inputs and pending approval reasons;
     scope persistent retry identities to the active actor and organization,
     retain them through pending or uncertain outcomes, and clear them on
     success or definitive 4xx; 408, 429, and 5xx retain the attempt. Corrupt
     markers fail closed. Missing Go capability routes retain the marker and
     fail closed without legacy fallback; the marker records the selected route
     so retries continue on Go even if the selector is later disabled. Earlier
     route-less markers remain preserved and fail closed because their original
     destination is ambiguous; the transfer panel allows clearing one only
     after the user explicitly confirms review of the visible history. Reject duplicate partial-confirmation
     line IDs at the Go boundary. Other inventory actions and page ownership
     remain unchanged. Focused Vite and Go parser checks pass; browser proof
     remains open.
159. (Implemented) Route Vite stock location creation and reservation/release through Go's
     `inventory.createLocation`, `inventory.reserveStock`, and
     `inventory.releaseReservation` capabilities when
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set
     `CHASTE_GO_INVENTORY_LOCATION_RESERVATION_WRITES=0` to restore these
     actions to `/api/inventory`. Preserve the response and pending envelope,
     scope persisted retry intents to the active actor and organization, retain
     an intent after approval-pending responses, and fail closed if Go scope is
     absent or incomplete. Selector rollback checks action and scope markers,
     including when scope is temporarily unavailable; corrupt markers fail
     closed. Go writes require WebCrypto and durable browser storage for both
     the action and scope markers; unavailable hashing or storage fails before
     the request. Normalize location codes by trimming and uppercasing before
     Go validates their length. Other inventory actions and page ownership
     remain unchanged. Focused Vite and Go tests pass; browser proof remains
     open.
160. (Complete; authenticated browser proof recorded in item 339) Route Vite cycle-count barcode
     lookup through Go's session-authenticated `inventory.lookupByBarcode`
     capability whenever `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. The selector
     defaults on and setting `CHASTE_GO_INVENTORY_BARCODE_LOOKUP=0` disables
     the lookup with a clear error; disabled or unavailable Go never falls
     back to `/api/inventory`. Preserve the `{ sku, name } | null` result.
     Focused Go and Vite tests pass. Authenticated Vite browser proof used a
     synthetic stocked item and found it by scanning its barcode through Go;
     see item 339.
161. (Implemented) Route only Vite CRM deal stage changes through Go's session-authenticated
     `crm.moveDealStage` capability when `CHASTE_GO_CRM_DEAL_STAGE_MOVE=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set the selector to `0` to restore
     `/api/deals`; all other CRM mutations stay on their existing routes. Keep
     the lost-reason requirement and 500-character limit, per-deal optimistic
     rollback, and the reason draft after pending or failed responses. Scope
     persisted retry intents to the active actor and organization, retain the
     intent across pending and uncertain retries, and clear it on success or a
     definitive 4xx. 408 and 429 responses retain the exact retry intent. A missing Go capability route falls back with the same
     actor/org-scoped intent; other Go failures do not fall back. Focused Go
     parser/dispatch and Vite API/UI tests pass; authenticated browser proof
     remains open.
162. (Complete) Route Vite purchase order creation through Go's
     session-authenticated `purchasing.createPurchaseOrder` capability with no
     legacy fallback or selector. Scope retry identity to the active actor and
     organization, serialize marker creation and clearing across tabs with Web
     Locks, and fail closed if Web Locks are unavailable. Preserve exact-draft
     intent across pending or uncertain outcomes, validate positive safe
     integer quantities, non-negative prices, and the positive safe-integer
     Go result. Focused Vite tests cover concurrent retries and fail-closed
     behavior; authenticated browser proof is recorded in item 342.
163. (Implemented; local Go/Vite default-on) Route Vite receiving-desk
     submissions through Go's session-authenticated `purchasing.receiveGoods` capability when
     `CHASTE_GO_PURCHASING_RECEIVE_GOODS=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set the selector to `0` to restore
     `/api/purchasing`; a missing Go capability route falls back with the same
     intent. Scope persistent retry identity to the active actor and
     organization, retain it for approval-pending or uncertain submissions,
     and clear it on success or terminal 4xx. Preserve receipt drafts on
     pending and error responses, and validate quantities, aggregate limits,
     rejection reasons, and overreceipt authority against Go's contract.
     Focused Vite checks pass; browser proof remains open.
164. (Implemented) Route Vite work order create, release, completion, and cancellation through
     Go's session-authenticated `manufacturing.createWorkOrder`,
     `manufacturing.releaseWorkOrder`, `manufacturing.completeWorkOrder`, and
     `manufacturing.cancelWorkOrder` capabilities when
     `CHASTE_GO_MANUFACTURING_WORK_ORDER_WRITES=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. A missing capability route fails
     closed and retries only through Go; other manufacturing writes remain
     unchanged. Persist exact-action retry identity by actor and
     organization through pending and uncertain results, require scope before
     Go requests, and validate UUIDs, quantities, yield, work center, note, and
     lot code against the capability contract. Selector rollback blocks while
     a Go action is unresolved. The page resets old-scope inputs and ignores
     stale reads and writes after an actor or organization change. Focused Vite
     checks pass; browser proof remains open.
165. (Implemented) Route Vite BOM production and production-run reversal through Go's
     `manufacturing.produceFromBom` and `manufacturing.reverseProductionRun`
     capabilities when `CHASTE_GO_MANUFACTURING_PRODUCTION_WRITES=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Selected Go 404s fail closed and
     retain exact-action retries by actor and organization through pending or
     uncertain outcomes; capability output schemas are validated. Go reversals
     lock affected stock before checking prior reversals or available finished
     stock. Selector
     rollback blocks unresolved Go writes; stale reads and writes are ignored
     after scope changes. Focused Vite checks pass; browser proof remains open.
166. (Implemented) Add Vite Sales order creation, deliver-all, and cancellation through Go's
     session-authenticated `sales.createOrder`, `sales.deliverOrder`, and
     `sales.cancelOrder` capabilities when `CHASTE_GO_SALES_ORDER_WRITES=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Keep confirmation on its existing
     Go path and fall back to the legacy `/api/sales` action only when the Go
     capability route is absent, reusing the same intent. Persist exact action
     retries by actor and organization through pending or uncertain results;
     retain form drafts and action targets until success. Create lines preserve
     optional SKU inventory linking. Delivery omits explicit lines to deliver
     all remaining reserved quantities, including service lines, matching the
     existing Next flow. `sales.listOrders` includes each order line's
     deliverable reserved balance, and Vite supports an exact partial quantity
     selection that sends line IDs and thousandth quantities through the same
     retry-safe capability. Catalog quick-create remains outside this Vite form.
     Go rejects duplicate delivery line IDs and the
     internal deliver-all sentinel as explicit quantities. Confirmation and
     delivery/cancellation results are ignored after a scope change; stale
     targets are cleared. Focused checks pass. Authenticated `agent-browser`
     proof on 2026-10-14 created and confirmed synthetic order #1 with two
     units, delivered 1.25 units, then reloaded the page. Go reported 0.750
     units still available. Capability requests returned HTTP 200, no legacy
     Sales write occurred, and the browser reported no errors.
166a. (Implemented) Route Vite Sales order list and refresh reads through Go's
     session-authenticated `sales.listOrders` capability when
     `CHASTE_GO_SALES_ORDER_READS=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Keep list ordering, fields, and
     page behavior stable; Go derives organization scope from the authenticated
     session. Selected Go reads fail closed on missing capabilities, pending
     responses, or malformed output. Focused checks pass; browser proof remains
     open.
166b. (Implemented) Make selected-Go Vite Sales create, deliver, and cancel
     writes fail closed on 404 and pin unresolved actor- and organization-
     scoped intents to their original Go or legacy route. Reject selector
     changes until the original route is restored; route-less pre-upgrade
     markers require review of Sales order history and explicit confirmation
     before the scoped marker can be cleared. Recovery does not send a Sales
     write, and valid or malformed markers cannot use this cleanup action. Use
     legacy `/api/sales` only when `CHASTE_GO_SALES_ORDER_WRITES` is off.
     Focused API and page tests cover all three actions, route changes, and
     reviewed route-less recovery; browser proof remains open.
167. (Implemented; local Go/Vite default-on) Route Vite vendor returns and
     purchase order closing through Go's session-authenticated `purchasing.returnGoods` and
     `purchasing.closePurchaseOrder` capabilities when
     `CHASTE_GO_PURCHASING_RETURN_CLOSE=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Preserve `/api/purchasing` as the
     missing-route fallback with the same intent, strict Go response parsing,
     actor and organization scoped retry IDs through pending or uncertain
     results, and open dialogs on pending or failure. Match Go's positive
     int32 quantity and reference bounds and return-reason limits. Receipt
     returns allocate oldest receipt numbers first, and explicit receipt scope
     cannot fall through to purchase-order history. Focused Go and Vite checks
     pass; browser proof remains open.
168. (Implemented; local Go/Vite default-on) Route Vite vendor creation, bill
     recording, bill payments, and bill credits through Go's session-authenticated
     `purchasing.createVendor`,
     `purchasing.createBill`, `purchasing.payBill`, and
     `purchasing.billCreditNote` capabilities when
     `CHASTE_GO_PURCHASING_FINANCE_WRITES=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Keep `/api/purchasing` as the
     missing-route fallback with the same intent, strict capability output
     parsing, and exact payload retry identities scoped by actor and
     organization through pending or uncertain outcomes. Fail closed until
     scope is available. Capability-side validation mirrors Go bill and
     payment and credit constraints; existing bill form fields and tax
     behavior remain aligned with the Vite workspace. Focused Go and Vite checks
     pass; browser proof remains open.
169. (Implemented; local Go/Vite default-on) Route Vite purchase requests,
     request decisions, RFQ creation, quote recording, and quote awards through
     Go's session-authenticated
     `purchasing.createPurchaseRequest`, `purchasing.decidePurchaseRequest`,
     `purchasing.createRfq`, `purchasing.recordQuote`, and
     `purchasing.selectWinningQuote` capabilities when
     `CHASTE_GO_PURCHASING_SOURCING_WRITES=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Preserve `/api/purchasing` as the
     same-intent fallback when the capability route is missing. Persist exact
     action intents by actor and organization across pending and uncertain
     outcomes, validate each Go output shape, and restore scope-hashed form
     drafts and request targets after reload until an action completes. Go serializes decisions and
     quote actions on the parent request and rejects duplicate vendor IDs in
     RFQ creation. Focused Go and Vite checks pass; browser proof remains open.
170. (Implemented; default-on in `.env.example`) Route only Vite Marketing campaign creation and sends through Go's
     session-authenticated `marketing.createCampaign` and `marketing.sendCampaign`
     capabilities when `CHASTE_GO_MARKETING_CAMPAIGN_WRITES=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Preserve the legacy route as the
     explicit rollback path when the campaign selector is set to `0`. Persist
     exact actor and organization scoped intent IDs through pending or uncertain
     outcomes, lock and restore the exact create draft after reload, require the
     resolved current scope and durable browser storage before Go writes, and
     validate the strict campaign and send output shapes. Retain attempts after
     network, 408, 429, and 5xx uncertainty; block changed payloads until the
     original create is resolved. Campaign analytics uses the same paired
     selector and is default-on; set the campaign selector to `0` to roll
     campaign writes and analytics back to the legacy route. Segment creation
     keeps its separate selector, and snapshot reads remain on their existing
     route.
     Disable send after the campaign snapshot reports queued. Selector rollback
     blocks unresolved Go attempts, and scoped campaign, send-log, analytics,
     draft, and action state is cleared or hidden while a new scope loads.
     Focused Vite checks pass; browser proof remains open.
171. (Implemented; local Go/Vite default-on) Route Vite CRM task creation and
     completion through Go's session-authenticated `crm.createTask` and
     `crm.completeTask` capabilities. The local template enables both
     `GO_CRM_TASK_WRITES=1` and `CHASTE_GO_CRM_TASK_WRITES=1` with
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`; set both task flags to `0` to
     restore legacy `/api/crm` handling. A Go 404 fails closed without retrying
     through the legacy writer; retain the exact draft and intent so a retry
     after restoring the Go route cannot create a duplicate across runtimes.
     Persist exact actor and organization scoped intents across pending and
     uncertain results, restore unresolved create drafts after reload, validate
     strict output shapes, and fail closed when account or organization scope
     or browser storage is unavailable. Authenticated browser proof remains
     open because the in-app browser is unavailable in this environment.
172. (Complete; local Go/Vite implementation and authenticated browser proof passed) Route only Vite CRM customer
     creation through Go's session-authenticated `crm.createCustomer` capability
     under the paired `CHASTE_GO_CRM_CUSTOMER_CREATE=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` flags. Set the customer-create
     selector to `0` to route fresh creates to `/api/customers`; unresolved Go
     creates remain locked and block legacy writes until Go routing is restored
     and the exact action is retried. All other CRM actions keep their current
     routes. Both Go and legacy create requests require resolved actor and
     organization scope; no customer-create request is sent before scope
     resolves. Persist the exact actor and organization scoped attempt and form
     draft across pending and uncertain results, restore it on reload, and fail
     closed on Go 404 without calling the legacy writer while retaining the
     scoped retry identity. Validate the customer ID and duplicate warning, and
     include the warning in the success notice. The Go parser enforces the legacy
     120-character name limit. The authenticated Vite proof is recorded in
     item 317.
173. (Implemented; local Go/Vite default-on) Route only Vite CRM deal creation
     through Go's session-authenticated `crm.createDeal` capability under the
     paired `CHASTE_GO_CRM_DEAL_CREATE=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` flags. Set the deal-create selector
     to `0` to route fresh creates to `/api/deals`; unresolved Go creates remain
     locked and block legacy writes until Go routing is restored and the exact
     action is retried. Keep stage changes, conversion, and all other CRM writes
     on their current routes. Both Go and legacy create requests require
     resolved actor and organization scope; no deal-create request is sent
     before scope resolves. Persist the exact actor and organization scoped
     attempt and form draft across pending and uncertain results, restore it on
     reload, and fail closed on Go 404 without calling the legacy writer while
     retaining the scoped retry identity. Validate the returned deal ID. Go
     enforces the legacy title limit, same-organization customer association,
     and same-organization owner membership. Authenticated browser proof
     remains open because the in-app browser is unavailable in this environment.
174. (Implemented; local Go/Vite default-on) Route only Vite CRM customer
     profile saves and bulk profile updates through Go's session-authenticated
     `crm.updateCustomerProfiles` capability under the paired
     `CHASTE_GO_CRM_CUSTOMER_PROFILE_UPDATE=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` flags. Set the profile selector to
     `0` to roll back to `/api/customers`; other customer writes keep their
     current routes. Persist the exact actor and organization scoped action and
     intent through pending and uncertain results, restore the pending profile
     or bulk target after reload, and fail closed on Go 404 without calling the
     legacy writer while retaining the scoped retry identity. Strictly validate
     the updated count and complete previous snapshots. Lock customer and
     membership rows while capturing and applying snapshots so undo cannot
     overwrite an intervening profile edit. Authenticated browser proof remains
     open because the in-app browser is unavailable in this environment.
175. (Complete; focused route tests and authenticated browser proof passed) When the Vite Go auth proxy is enabled, route every method
     and path under `/api/auth`, including the exact root, to Go. Unsupported
     Better Auth compatibility paths fail closed in Go instead of falling
     through to the legacy service; the explicit
     `CHASTE_GO_AUTH_ROUTE=0` compatibility opt-out is retained. Other API
     namespaces and their route selectors are unchanged. Authenticated signup,
     email verification, sign-in, and Vite workspace access are recorded in
     item 316.
176. (Implemented) Persist the exact Vite Sales create action alongside its
     actor/org scoped intent. Restore and lock unresolved drafts after remount,
     retry with the original payload and intent, and unlock on definitive 4xx
     so a corrected request starts with a fresh identity. The API and UI tests
     cover payload restoration, retry identity, corrected requests, scope
     changes, and corrupt retry markers. Create writes wait until the active
     actor/org marker check completes, and damaged markers fail closed.
     Authenticated browser proof remains open because the in-app browser is
     unavailable in this environment.
177. (Implemented) Persist manual Vite inventory adjustment payloads and stable
     actor/org scoped intents through pending and uncertain outcomes. Restore
     and lock the exact adjustment after reload, ignore responses from a prior
     scope, retain retry identities for 408/429, and reuse the intent on
     missing-route fallback. Corrupt markers fail closed, and selector rollback
     checks for unresolved Go actions before allowing a fresh legacy write.
     Focused API and UI tests cover recovery, retries, fallback, selector
     rollback, and scope changes. Authenticated browser proof remains open
     because the in-app browser is unavailable in this environment.
178. (Implemented) Persist Vite POS register open/close actions under resolved
     actor/org scope before sending them. Restore and freeze exact attempts
     through pending or uncertain outcomes, reject stale scope responses,
     retain 408/429 identity, and fail closed on unavailable storage or corrupt
     markers. API and UI tests cover both action types, including close retry
     identity after 408/429 and corrupt close markers. Authenticated browser
     proof remains open because the in-app browser is unavailable in this
     environment.
179. (Implemented; local Go/Vite default-on with item 171) Route Vite CRM task
     due date and assignee updates through the Go `crm.updateTaskDetails`
     capability under the paired task-write flags described in item 171. A Go
     404 fails closed without sending the update through the legacy writer and
     retains the exact retry record. Scan actor/org scoped retry records on
     load, keep affected tasks locked from completion across editor switches,
     and require the Go task ID to match before clearing a saved attempt.
     Authenticated browser proof remains open because the in-app browser is
     unavailable in this environment.
180. (Implemented; default-on when session capability routing is enabled)
     Route Vite message edits through Go's `messaging.editMessage` capability
     unless `CHASTE_GO_MESSAGING_EDIT_SLICE=0`. Restore the exact actor/org
     scoped edit and intent after pending or uncertain results, validate Go
     output, fail closed on Go 404s and while scope is unresolved or stale,
     and keep unresolved edits locked across selector rollback. Go emits a
     receipt-backed restore inverse guarded by body and monotonic edit time.
     Focused API/UI/proxy tests pass; authenticated browser proof remains
     open.
181. (Implemented; default-on when session capability routing is enabled)
     Route Vite message deletions through Go's `messaging.deleteMessage`
     unless `CHASTE_GO_MESSAGING_DELETE_SLICE=0`. Restore the actor/org scoped
     confirmation and intent after pending or uncertain results, strictly
     validate the deleted flag, message ID, and receipt timestamp, fail closed
     on 404, require actor and organization scope for Go and legacy deletion,
     block stale confirmation state across organization or session changes,
     and keep unresolved Go deletions locked across selector rollback.
     Focused API/UI/proxy tests pass; authenticated browser proof remains open.
182. (Implemented) Add the internal pre-organization database bootstrap
     primitive for Go. Derive the owner from a live verified Better Auth
     session, serialize attempts by that user, and create the organization,
     seeded records, and intent receipt atomically under a dedicated
     `chaste_bootstrap_owner` role with `NOBYPASSRLS`, a pinned search path,
     and execution granted only to `chaste_app`. The database boundary test
     checks the grants, role attributes, session-derived ownership, replay and
     concurrency behavior, and transaction rollback. Local DB integration
     execution remains open until a Go integration database is configured.
183. (Implemented) Add the verified pre-organization
     `iam.bootstrapOrganization` executor entrypoint. Keep the capability out
     of ordinary org-scoped dispatch and agent tool lists; verify the live
     session and its resolved identity, execute bootstrap and append its
     first-create ledger event in one transaction, then upgrade embeddings
     best-effort after commit. The HTTP mount remains off unless
     `GO_ONBOARDING_ROUTE=1`; its single-writer routing is covered in item 184.
     Database handler tests cover identity mismatch, revoked sessions, one
     creation event on replay, audit-failure rollback, and best-effort
     embedding. Browser proof remains open.
184. (Implemented) Make Go the only public organization-creation writer. The
     Next POST forwards the original body, Cookie or Bearer token, Origin, and
     Host to Go, preserves Go's exact same-origin check, validates the bounded
     request and response, and fails closed on upstream errors or timeouts
     without calling the TypeScript bootstrap. Keep Next GET/PATCH on the
     legacy handlers for now. The default-off Vite
     `CHASTE_GO_ONBOARDING_ROUTE` selector routes only POST and is paired with
     `GO_ONBOARDING_ROUTE=1` on the API. When HTTPS terminates before Go, only
     the exact Next proxy peer CIDRs in `GO_API_TRUSTED_PROXY_CIDRS` can supply
     the forwarded scheme; an unset list trusts no proxy. Proxy, selector,
     response-contract, and trusted-peer tests pass. Browser proof remains
     open.
185. (Implemented) Route Vite CRM reads for deals, customers, tasks, saved
     views, and customer timelines to Go's direct session-authenticated API.
     Go resolves the Better Auth cookie or bearer token, validates the optional
     organization selector, and executes the corresponding CRM read capability
     with claims built inside Go. The full CRM customer collection uses a
     human-only `crm.listCustomerCollection` capability; the summary
     `crm.listCustomers` agent tool remains unchanged. SalesPage uses the
     POS-scoped customer endpoint so `pos.sell` access remains available.
     Pair `CHASTE_GO_CRM_READS=1` with `GO_CRM_READ_ROUTE=1`; both are enabled
     in the local template and can be set to `0` to restore legacy reads. Keep
     the signed assertion route for legacy Next callers; Vite must not depend
     on Next to mint CRM read assertions. CRM writes and AI follow-up drafting
     remain on their existing routes. On 2026-10-11, an authenticated
     agent-browser session opened `/crm` in the Vite app. Deals, customers,
     tasks, saved views, and customer timeline reads each returned 200 through
     the Go selector, with no browser console errors.
186. (Implemented) Route only Vite CRM customer deactivation through Go's
     session-authenticated `crm.deactivateCustomer` capability under the
     paired `CHASTE_GO_CRM_CUSTOMER_DEACTIVATE=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` flags. The local template enables
     the selector; set it to `0` to use `/api/customers`. Persist the exact
     customer action and scoped intent across pending approvals and uncertain
     results, and fail closed on Go 404 without calling the legacy writer.
     Selector rollback is blocked while a Go attempt remains unresolved.
     Customer merge and import routes remain unchanged. Go's existing
     capability enforces CRM write permission, organization scope, and approval
     policy. Authenticated browser proof remains open.
187. (Implemented) Route Vite CRM customer merge and undo through Go's existing
     `crm.mergeCustomers` and `crm.restoreCustomerMerge` capabilities under the
     paired `CHASTE_GO_CRM_CUSTOMER_MERGE=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` flags. Set the merge selector to
     `0` to use `/api/customers`. Persist exact scoped merge and undo intents
     across approval and uncertain results, fail closed on Go 404, and block
     legacy rollback while either Go operation is unresolved. Persist the
     returned merge snapshot so undo remains available after reload. The Go
     restore resolves the original successful merge receipt server-side, ignores
     caller-supplied snapshots, and rejects undo when any restored field changed
     after the merge. All other CRM mutations keep their existing routes.
     Browser proof remains open.
188. (Complete; CRM page browser proof recorded in item 313) Route Vite CRM customer CSV import and undo through Go's existing
     `crm.importCustomers` and `crm.undoCustomerImport` capabilities under the
     paired `CHASTE_GO_CRM_CUSTOMER_IMPORT=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` flags. Set the import selector to
     `0` to use `/api/import`. Persist exact scoped import and undo attempts
     through approval and uncertain results, fail closed on Go 404, and block
     legacy rollback while either Go operation is unresolved or a saved Go
     import receipt is still available for Undo. Persist the created customer
     IDs and import receipt reference so Undo remains available after reload
     and stays on Go. Require durable UUID intents for import, undo, and restore.
     Go binds undo to the successful organization- and actor-scoped import
     receipt, consumes it atomically, rejects edits after import, and binds its
     restore inverse to the successful undo receipt while rejecting later edits.
     Keep CSV mapping and review behavior unchanged. Focused API, proxy, UI, and
     DB-backed Go tests pass; CRM page browser proof is recorded in item 313.
189. (Implemented) Route only Vite HR Expenses reads and writes through Go's
     session-authenticated `accounting.listExpenseClaims`,
     `accounting.listExpensePolicies`, `accounting.submitExpenseClaim`,
     `accounting.decideExpenseClaim`, `accounting.payExpenseClaim`, and
     `accounting.setExpensePolicy` capabilities. Enable the paired
     `CHASTE_GO_HR_EXPENSES=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`
     selectors in local setups; set the HR selector to `0` for explicit legacy
     rollback. Vite scopes durable exact-action retries by authenticated actor
     and organization, serializes retry marker reservations across tabs, only
     clears the matching intent and fingerprint, exposes retries for pending
     approvals after reload, and
     blocks legacy writes while a Go attempt remains unresolved. A Go 404 never
     falls back to `/api/expenses`. Preserve the existing claim and policy UI.
     Focused API, proxy selector, and HrPage tests pass; existing DB-backed Go
     expense capability tests remain the contract proof. When the Go expense
     selector is enabled, bootstrap the HR Expenses page with Go `hr.report` so
     the page never needs the legacy `/api/hr` route. Authenticated browser
     proof passed: report, claim and policy reads, and claim submission returned
     HTTP 200 through Go, with no legacy HR or Expenses API request or browser
     errors.
190. (Implemented and verified: DB-backed Go test and authenticated browser proof pass) Route only the Vite HR Leave tab through Go's session-authenticated
     `hr.report`, `hr.requestLeave`, `hr.decideLeave`, and `hr.cancelLeave`
     capabilities directly, without an HR-specific selector or legacy
     rollback. Scope durable exact-action retries by
     the authenticated actor and organization, recover pending approvals after
     reload, block other leave mutations while unresolved, and fail closed on
     Go 404 without falling back to `/api/hr`. Keep all other HR tabs on their
     existing routes. Focused API, proxy selector, and HrPage coverage pass,
     including malformed success-output retry retention. The DB-backed Go
     leave executor test and `go vet` pass. Authenticated browser proof
     submitted and approved a two-day synthetic request through the Go
     capability route, then confirmed the Approved state after reload. Both
     writes returned HTTP 200; no legacy `/api/hr` request or browser error
     occurred.
191. (Vite/Go implementation verified: DB-backed Go test and authenticated browser proof pass) Route only Vite invoice `recordPayment` writes through Go's
     session-authenticated `accounting.recordPayment` capability behind paired
     `CHASTE_GO_ACCOUNTING_RECORD_PAYMENT=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Set the payment selector
     to `0` for explicit legacy rollback. Scope durable exact payment intents
     by actor and organization, recover 202 approvals and uncertain writes after
     reload, block legacy fallback while unresolved, and fail closed on Go 404.
     Keep all other accounting operations on their current route. Add focused
     API, proxy selector, and AccountingPage tests; the existing Go payment
     executor integration test remains the contract proof. Atomic browser-wide
     reservations prevent cross-tab intent races, and browsers without Web
     Locks fail closed. Vite API/page/proxy tests, typecheck, lint, and the Go
     payment executor integration test pass. Authenticated Vite browser proof
     recorded a synthetic UGX 10,000 invoice payment through Go and confirmed
     the invoice remained paid with a zero balance after reload. The payment
     write returned HTTP 200 from `/api/capabilities/execute`; no legacy
     accounting request or browser error occurred.
192. (Vite/Go implementation verified: DB-backed Go test and authenticated browser proof pass) Route only Vite `createInvoice` writes through Go's session-authenticated
     `accounting.createInvoice` capability behind paired
     `CHASTE_GO_ACCOUNTING_CREATE_INVOICE=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Set the invoice selector
     to `0` for explicit legacy rollback. Scope durable exact intents by actor
     and organization, recover pending approvals and uncertain writes after
     reload, block legacy fallback while unresolved, and fail closed on Go 404.
     Keep other Accounting operations on their current route. Add focused API,
     proxy selector, and AccountingPage tests; the existing Go invoice creation
     executor integration test remains the contract proof. Atomic browser-wide
     reservations prevent cross-tab intent races, and browsers without Web
     Locks fail closed. Vite API/page/proxy tests, typecheck, lint, and the Go
     invoice creation integration test pass. Authenticated Vite browser proof
     posted a synthetic UGX 10,000 invoice through `accounting.createInvoice`
     and showed invoice #1 with the full outstanding balance. Go returned
     HTTP 200; no legacy accounting request or browser error occurred.
193. (Vite/Go implementation verified: DB-backed Go test and authenticated browser proof pass) Route only Vite `creditNote` writes through Go's session-authenticated
     `accounting.creditNote` capability behind paired
     `CHASTE_GO_ACCOUNTING_CREDIT_NOTE=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Set the credit-note
     selector to `0` for explicit legacy rollback. Scope durable exact intents
     by actor and organization, recover pending approvals and uncertain writes
     after reload, block legacy fallback while unresolved, and fail closed on
     Go 404. Keep other Accounting operations on their current route. The Go
     executor remains authoritative for the locked invoice's current balance.
     Add focused API, proxy selector, and AccountingPage tests; the existing Go
     credit-note integration test remains the contract proof. Atomic
     browser-wide reservations prevent cross-tab intent races, and browsers
     without Web Locks fail closed. Vite API/page/proxy tests, typecheck, lint,
     and the Go credit-note contract test pass. Authenticated Vite browser
     proof applied a synthetic UGX 5,000 credit to invoice #2 through Go and
     confirmed zero outstanding balance after reload. The write returned
     HTTP 200; no legacy accounting request or browser error occurred.
194. (Vite/Go implementation and authenticated browser proof complete) Route only Vite manual/general `reverse` writes through Go's
     session-authenticated `accounting.reverseEntry` capability behind paired
     `CHASTE_GO_ACCOUNTING_REVERSE_ENTRY=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Set the reversal selector
     to `0` for explicit legacy rollback. Scope durable exact intents by actor
     and organization, recover pending approvals and uncertain writes after
     reload, block legacy fallback while unresolved, and fail closed on Go 404.
     Keep other Accounting actions on their current routes. Go remains
     authoritative for reversal eligibility and routes invoice, payment, and
     year-end entries to their domain workflows. Add focused API, proxy, and
     AccountingPage tests; existing Go reverse-entry parser, domain, and
     governed-executor tests remain the contract proof. Atomic browser-wide
     reservations prevent cross-tab intent races, and browsers without Web
     Locks fail closed. Vite API/page/proxy tests, typecheck, lint, and the Go
     reverse-entry contract test pass. Authenticated Vite browser proof
     submitted a reversal for a synthetic invoice credit note and confirmed Go
     returned HTTP 422 with workflow guidance, Vite displayed the refusal
     without an exact-retry action, and the journal stayed unchanged after
     reload. The action used the Go session capability endpoint; no legacy
     accounting write request or browser error occurred. A separate Go
     database-backed test confirms permitted manual reversal still mirrors
     the original entry.
195. (Vite/Go implementation and authenticated browser proof complete) Route only Vite bank reconciliation match/unmatch writes through Go's
     session-authenticated `accounting.matchBankTransaction` and
     `accounting.unmatchBankTransaction` capabilities behind paired
     `CHASTE_GO_BANK_RECONCILIATION_WRITES=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Set the banking write
     selector to `0` for explicit legacy rollback. Scope durable exact intents
     by actor and organization, recover pending approvals and uncertain writes
     after reload, block legacy fallback while unresolved, and fail closed on
     Go 404. Keep other Banking operations and reads on their current routes.
     Go remains authoritative for allocation and matched-state rules. Add
     focused API, proxy, and AccountingPage tests plus governed Go executor
     coverage. Atomic browser-wide reservations prevent cross-tab intent races,
     and browsers without Web Locks fail closed. Vite API/page/proxy tests,
     typecheck, lint, and Go banking reconciliation contract tests pass.
     Authenticated Vite browser proof imported a synthetic UGX 10,000 statement
     line, matched it to invoice payment #1, unmatched it, then matched it
     again through the Go session capability endpoint. Both write types
     returned HTTP 200, the final matched state persisted after reload, and no
     legacy banking write request or browser error occurred.
196. (Vite/Go implementation and authenticated browser proof complete) Route Accounting Payables `payBill` actions through the existing Vite Go
     `payPurchasingBill` flow and `purchasing.payBill` capability under the
     existing `CHASTE_GO_PURCHASING_FINANCE_WRITES=1` selector. Preserve the
     exact amount and optional payment method, including the Go
     `bank_transfer` default when omitted. Reuse the Purchasing finance retry
     intent store, add persisted action details only for bill payment so the
     Accounting page can recover an exact 202 or uncertain action after
     reload, and test the same stable intent through API and UI. Finance intent
     reservations are atomic across tabs, and browsers without Web Locks fail
     closed. Purchasing API tests, AccountingPage recovery, Vite typecheck/lint,
     and the Go payBill contract test pass. Keep other Accounting actions
     unchanged. Authenticated Vite browser proof created a synthetic UGX 100
     bill through the Go-backed Purchasing flow, then paid it from Accounting
     Payables. The Go request preserved the full outstanding amount, omitted
     the optional payment method to exercise Go's `bank_transfer` default,
     returned HTTP 200, and left the bill paid with zero outstanding after
     reload. No legacy Accounting write request or browser error occurred.
197. (Vite/Go implementation and authenticated browser proof complete) Route Vite HR
     Time report and pending-entry reads, time logging, and submitted-entry
     decisions through Go's session-authenticated
     `hr.timeReport`, `hr.pendingTimeEntries`, `hr.logTime`, and
     `hr.decideTimeEntry` capabilities directly. Keep other HR tabs on
     their current routes. Pending time reads require a dedicated `hr.read`
     capability because the aggregate report lacks decision IDs and employee
     display details; preserve the legacy queue's 100-row date-descending
     behavior. Scope durable exact write attempts by actor and organization,
     recover approvals and uncertain results after reload, block legacy rollback
     while unresolved, and fail closed on Go 404. Add focused Go parser,
     executor, org-scope, Vite API, proxy selector, and HR page tests. Atomic
     browser-wide reservations prevent cross-tab intent races, and browsers
     without Web Locks fail closed. Vite API/page/proxy tests, typecheck, lint,
     and Go HR time contract tests pass. Authenticated Vite browser proof
     logged 90 minutes for the synthetic Leave Flow Test Employee, showed the
     entry in the submitted queue, then approved it through Go. The report
     showed 1h 30m approved and zero pending after reload. All three write/read
     capability responses returned HTTP 200; no legacy HR POST or browser
     error occurred.
198. (Vite/Go implementation and authenticated browser proof complete) Route Vite
     supplier payment run reads and lifecycle actions through Go's
     `purchasing.listPaymentRuns`, `purchasing.listPaymentRunBills`,
     `purchasing.createPaymentRun`, `purchasing.cancelPaymentRunDraft`,
     `purchasing.restorePaymentRunDraft`, `purchasing.instructPaymentRun`, and
     `purchasing.reversePaymentRun` capabilities behind paired
     `CHASTE_GO_PURCHASING_PAYMENT_RUNS=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Keep bill eligibility,
     balance, and currency checks authoritative in Go. Scope durable exact
     write attempts by actor and organization, recover approvals and uncertain
     outcomes after reload, and fail closed on Go 404. Preserve the existing
     payment run schedule, remittance, cancel, restore, approval, and reversal
     workflows in Vite. Add focused Go executor, Vite API, proxy, and page
     coverage. Atomic browser-wide reservations prevent cross-tab intent
     races, stale responses cannot clear a newer action, and browsers without
     Web Locks fail closed. Vite API/page/proxy tests, typecheck, lint, and Go
     payment run contract tests pass. Authenticated Vite browser proof created
     PR-000001 for a synthetic UGX 250 bill, cancelled and restored its draft,
     instructed it through Go, then reversed the unconfirmed run. Every write
     returned HTTP 200; the reversed status and restored bill balance persisted
     after reload. No legacy payment-run POST or browser error occurred.
199. (Vite/Go implementation and authenticated browser proof complete) Route only the
     Vite Payroll tab's run report and draft creation through
     Go's `hr.report` and `hr.createPayrollRun` capabilities behind paired
     `CHASTE_GO_HR_PAYROLL=1` and `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`
     selectors. Keep other HR tab transports and payroll execution, void, and
     reversal controls unchanged. Scope durable exact draft attempts by actor
     and organization, recover pending or uncertain writes after reload, block
     legacy fallback while unresolved, and fail closed on Go 404. Add focused
     Vite API, page, and proxy tests; existing Go parser and governed executor
     tests remain the capability contract proof. Atomic browser-wide
     reservations prevent cross-tab intent races, stale responses cannot clear
     a newer draft, and browsers without Web Locks fail closed. Vite API/page/
     proxy tests, typecheck, lint, and Go payroll contract tests pass.
     Authenticated Vite browser proof created an October 2026 payroll draft
     through `hr.createPayrollRun`, with one employee, UGX 1,000 gross, UGX 100
     tax, and UGX 900 net. The draft remained visible after reload. The Go
     report and draft requests returned HTTP 200; no legacy HR POST or browser
     error occurred.
200. (Vite/Go implementation and authenticated browser proof complete) Route only the
     Vite Hiring tab's report, opening creation, applicant creation, and
     applicant stage changes through Go's `hr.report`,
     `hr.createOpening`, `hr.addApplicant`, and `hr.moveApplicant` capabilities
     behind paired `CHASTE_GO_HR_HIRING=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Keep other HR tab
     transports unchanged and do not add applicant conversion controls. Scope
     durable exact write attempts by actor and organization, recover pending
     and uncertain actions after reload, block legacy fallback while
     unresolved, and fail closed on Go 404. Add focused Go contract and Vite
     API, page, and proxy tests. Atomic browser-wide reservations prevent
     cross-tab intent races, stale responses cannot clear a newer action, and
     browsers without Web Locks fail closed. Vite API/page/proxy tests,
     typecheck, lint, and Go Hiring contract tests pass. Authenticated browser
     proof created the Migration QA Analyst opening, added a synthetic
     applicant, and moved the candidate to screening through Go. The opening,
     applicant, and stage remained visible after reload. All selected Go
     capability requests returned HTTP 200; no legacy HR write or browser
     error occurred.
201. (Done) Route only Vite
     period-close readiness reads through Go's session-authenticated
     `accounting.periodCloseWorkbench` capability behind paired
     `CHASTE_GO_ACCOUNTING_PERIOD_CLOSE_READS=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Keep the current period
     picker, module switchboard behavior, and other Accounting routes unchanged.
     Go derives organization access from the session and enforces
     `accounting.read`; a Go error must not fall back to the legacy readiness
     route. Add focused Vite API, page, proxy selector, and Go contract checks.
     API tests (5), page tests (7), proxy tests (152), typecheck, lint, and Go
     period-close parser/workbench tests pass. Authenticated browser proof
     loaded September 2026 readiness from Go: four blocking checks and two
     complete checks persisted on reload. The capability request returned
     HTTP 200, with no browser errors or legacy accounting-read request.
202. (Done) Route the existing Vite supplier statement read through the
     session-authenticated `purchasing.supplierStatement` capability behind
     paired `CHASTE_GO_PURCHASING_SUPPLIER_STATEMENT_READS=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Require UUID vendor IDs
     at the Vite boundary, preserve `purchasing.read` authorization and
     session-derived organization scope, and surface pending, malformed, and
     unavailable responses as errors rather than empty statements. Keep other
     Purchasing flows unchanged. Add focused Vite API, page, proxy selector,
     and Go parser/executor contract tests. The focused Vite API/page/proxy
     suite passes (267 tests), as do Go parser, supplier statement reader and
     executor tests, Vite typecheck, and Vite lint. Independent review found no
     authorization or tenant-scope issues. Authenticated browser proof loaded
     the synthetic vendor statement through Go with HTTP 200; its bill and
     payment rows and UGX 0 closing balance remained available after reload.
     No browser errors occurred.
203. (Done) Route only existing Vite People employee creation through Go's
     session-authenticated `hr.hireEmployee` capability behind paired
     `CHASTE_GO_HR_EMPLOYEE_WRITES=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Preserve salary in
     integer minor units and Go's employee field limits/defaults. Scope durable
     exact attempts by actor and organization, recover approvals and uncertain
     outcomes after reload, block legacy fallback while unresolved, and fail
     closed on Go 404. Reset the form after recovered success. Keep other HR
     actions unchanged; add focused Vite API, page, proxy selector, and Go
     parser/executor contract tests. Employee hire reservations now serialize
     across tabs and stale responses cannot remove a newer marker. The focused
     Vite API/page/proxy suite passed (206 tests); Go parser, persistence, and
     governed executor tests passed; Vite typecheck and lint passed. Independent
     review found no actionable issues. Authenticated browser proof created
     Migration Hire Proof 20261012 at UGX 1,250 monthly through
     `hr.hireEmployee` (HTTP 200). The employee remained in the directory
     after reload; no legacy HR write or browser error occurred.
204. (Done) Route only the existing Vite Purchasing Intel price-history and supplier-
     performance reads through `purchasing.priceHistory` and
     `purchasing.supplierPerformance` behind paired
     `CHASTE_GO_PURCHASING_INTEL_READS=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Go derives organization
     scope from the session and enforces `purchasing.read`. Validate exact Go
     output contracts and render pending, malformed, or unavailable results as
     errors rather than empty analytics. Keep other Purchasing flows unchanged;
     add focused Vite API, page, proxy selector, and Go executor contract tests.
     Eleven focused Vite tests passed; Go parser, reader, and governed executor
     tests passed; Vite typecheck and lint passed. Independent review found no
     permission or tenant-scope gaps. Authenticated browser proof loaded the
     Purchasing Intel tab with both `purchasing.priceHistory` and
     `purchasing.supplierPerformance` returning HTTP 200 through Go. The empty
     price-history state and synthetic vendor metrics rendered without browser
     errors after reload.
205. (Done) Route only the Vite Accounting Reports aggregate read through Go's
     `accounting.incomeStatement`, `accounting.balanceSheet`,
     `accounting.cashFlow`, `accounting.unrealizedFxExposure`, and
     `accounting.reportCurrencyMetadata` capabilities behind paired
     `CHASTE_GO_ACCOUNTING_REPORTS=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Preserve required versus
     optional report semantics, validate all result schemas and currency
     metadata, and use no-store reads. Fail closed without `/api/reports`
     fallback. Keep Accounting writes and other report reads unchanged; add
     focused Vite API, page, proxy selector, and Go executor contract tests.
     (Runtime verified) The focused
     Vite API/page/proxy suite passed all 310 tests; the six Go report,
     metadata, FX, permission, and organization-scope tests passed with runtime
     integration required; Vite typecheck and lint passed. Independent review
     found no actionable issues. Authenticated browser proof loaded Profit and
     Loss, Balance Sheet, Cash Flow, and FX exposure after reload. All five
     required Go capabilities returned HTTP 200; the legacy `/api/reports`
     route was not requested, and no browser errors occurred.
206. (Runtime verified; enabled by default in `.env.example`) Route only Vite
     Manufacturing production cost previews,
     feasibility checks, and BOM reports through `manufacturing.costPreview`,
     `manufacturing.checkProductionFeasibility`, and `manufacturing.bomReport`
     behind paired `CHASTE_GO_MANUFACTURING_PLANNING_READS=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Keep other Manufacturing
     routes unchanged, validate request and response schemas, and surface
     pending, malformed, and unavailable results without falling back to
     `/api/manufacturing` when Go is selected. Setting the selector to `0`
     bypasses specialized routing, while the Vite catch-all still sends the
     request to Go. Add focused Vite API,
     page, proxy selector, and Go parser/executor contract tests. (Vite/Go
     implementation complete; runtime verified) The focused Vite API/page/proxy suite passed all 222 tests;
     four DB-backed Go parser, feasibility, governed execution, and permission
     tests passed with runtime integration required, including permission
     denial and foreign-SKU isolation for all three reads; Vite typecheck and
     lint passed. Expired Go sessions now show sign-in guidance. Authenticated
     browser proof created a synthetic component and assembly through Go,
     defined their BOM through `manufacturing.defineBom`, and confirmed after
     reload that feasibility, BOM report, and cost preview each returned HTTP
     200 through Go. The page showed available component stock and the cost
     preview, with no browser errors. Independent review found no remaining
     issues.
207. (Done) Route the existing Vite customer statement read through Go's
     session-authenticated `accounting.customerStatement` capability behind
     paired `CHASTE_GO_ACCOUNTING_CUSTOMER_STATEMENT_READS=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Validate customer UUIDs
     and the complete statement output, preserve the current rendering, and
     surface pending, malformed, and unavailable responses without falling
     back to `/api/accounting`. Keep other Accounting routes unchanged; add
     focused Vite API, page, proxy selector, and Go contract checks.
     (Runtime verified) The focused Vite
     API/page/proxy suite passed all 312 tests; the Go statement executor test
     passed with runtime integration required, covering permission denial,
     customer/org isolation, and audit behavior. Vite typecheck and lint passed.
     Statement dates now require offset-aware timestamps, and changing the
     selected customer clears old data and ignores late responses. Independent
     review found no remaining issues. Authenticated browser proof created a
     synthetic customer through Go, then loaded the customer's empty statement
     through `accounting.customerStatement` with HTTP 200 after reload. The
     legacy `/api/accounting` write route was not requested and no browser
     errors occurred.
208. (Done; default-on for Vite direct capability actions) Route the
     existing Vite Projects create, archive, task create, move, and assignment
     actions through Go's session-authenticated capabilities when
     `CHASTE_GO_PROJECTS_WRITES=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. With the write selector set to
     `0`, Vite uses `POST /api/projects`, which remains Go-backed while
     `CHASTE_GO_PROJECTS_ROUTE=1`. Keep Projects list and board reads on their
     current path. Persist exact actor- and organization-scoped action intents
     through pending approvals and uncertain results; while Go is selected, do
     not fall back on a missing route or unresolved outcome.
     Provide reciprocal archive/restore and task create/delete/restore
     capability receipts. Task deletion requires an unchanged full snapshot
     and no children; placement and assignment restores require the expected
     current value. Fail closed while actor or organization scope is loading.
     The Go capability pipeline enforces authenticated active organization
     membership and `projects.write`. Existing focused API, proxy, page, parser,
     receipt replay, guard, and tenant tests cover the behavior. The focused
     Projects API/page/proxy suite passed all 182
     tests; Go capability contract, parser, lifecycle, reciprocal inverse,
     permission, identity, organization isolation, approval, and rollback tests
     passed with runtime integration required. Vite typecheck and lint passed.
     Retry marker lookup, reservation, and cleanup now share a per-scope Web
     Lock; tests prove concurrent identical submissions reuse an intent and
     missing Web Locks prevent dispatch. Independent review found no remaining
     issues. Authenticated browser proof created a project and task, moved the
     task to Doing, assigned it to the owner, archived the project, and restored
     it through `projects.restoreProject`. Each Go capability returned HTTP
     200; the active project, task status, and assignment remained after reload.
     No legacy project POST or browser errors occurred.
209. (Done) Route Vite cycle-count create, record, post, and cancel
     through Go's session-authenticated `inventory.createCycleCount`,
     `inventory.recordCycleCounts`, `inventory.postCycleCount`, and
     `inventory.cancelCycleCount` capabilities behind paired
     `CHASTE_GO_INVENTORY_CYCLE_COUNT_WRITES=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Persist retry markers
     per actor and organization for the exact action; keep them across approval
     pending and uncertain outcomes, and block legacy rollback while unresolved.
     Do not retry a missing Go route through `/api/inventory`. Keep the legacy
     selector for rollback when no Go action is unresolved, and pass the active
     workspace scope from InventoryPage. Focused Vite API/UI and Go capability
     tests pass. Authenticated `agent-browser` proof created a count, recorded
     both item quantities, posted it, then created and cancelled a second count.
     The Go capability requests returned HTTP 200; both final states persisted
     after reload. No browser errors occurred.
210. (Done) Route Vite Product Catalog CSV import, undo, and restore
     through Go's session-authenticated `inventory.importItems`,
     `inventory.undoItemImport`, and `inventory.restoreItemImport` capabilities
     behind paired `CHASTE_GO_INVENTORY_IMPORT_SLICE=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Scope exact pending
     request payloads and imported IDs by actor and organization, recover them
     after reload, and expose retry controls through pending and uncertain
     results. Go-selected requests never fall back to `/api/import`; reject
     unsupported rows and payloads above the Vite 64 KiB capability limit
     before dispatch. The authenticated Go route validates import, undo, and
     restore inputs and applies the inventory write permission and per-org
     import rate limit. Focused Vite API/UI and Go route/capability tests pass.
     Authenticated `agent-browser` proof imported a CSV product through Go,
     undid the import, restored it, then reloaded and confirmed the product and
     active recovery receipt remained. Go capability requests returned HTTP
     200; no legacy `/api/import` requests or browser errors occurred.
211. (Done; default-on in `.env.example`) Route Vite Marketing campaign analytics through the
     session-authenticated `marketing.campaignAnalytics` capability when
     `CHASTE_GO_MARKETING_CAMPAIGN_WRITES=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set the campaign selector to `0`
     for explicit legacy rollback. When Go is selected, segment
     creation, campaign creation, send, and analytics fail closed on a missing
     Go route rather than retrying through `/api/marketing`. Preserve campaign
     actor/org scoped intent receipts across pending approvals, 404s, malformed
     responses, and uncertain send results. Keep the Marketing snapshot read
     separate on its existing path. Focused Vite contract/retry and Go parser
     tests pass. Browser proof created a segment with a 999,999,999,999 UGX
     threshold, drafted and queued a campaign for its empty audience, and read
     analytics through Go after reload. This exposed `min_spend_minor` as an
     `int4` despite accepting safe integer inputs; it now uses PostgreSQL
     `bigint`, and the threshold persisted. All final capability requests
     returned HTTP 200; the empty audience queued no recipient email, and the
     browser had no errors.
212. (Done) Route Vite CRM saved-view create, pin, and share writes
     through `crm.saveCustomerView` behind paired
     `CHASTE_GO_CRM_VIEW_WRITES=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Persist exact retry
     details per actor and organization, recover pending or uncertain writes
     after reload, and block duplicate saves and legacy fallback while a Go
     result is unresolved. Preserve the current saved-view read path. Focused
     Vite API/page/proxy tests pass; existing Go parser and integration coverage
     covers the capability contract. The authenticated Vite browser proof
     created, pinned, and shared a customer view through the Go capability
     executor with HTTP 200 for each mutation. Reload preserved the starred,
     shared view, Go CRM reads returned HTTP 200, and browser errors were empty.
213. (Done) Route the Vite Purchasing A/P aging report through Go's
     session-authenticated `purchasing.apAging` capability behind paired
     `CHASTE_GO_PURCHASING_AP_AGING_READS=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors and server-side
     `GO_PURCHASING_AP_AGING_READS=1` gate. Validate the capability envelope
     and strict bucket output, use the workspace currency because Go does not
     return currency, and fail closed without retrying the legacy
     `/api/purchasing` read. Focused Vite and Go route tests pass. The
     authenticated browser loaded the UGX aging buckets and zero outstanding
     total through Go; the capability returned HTTP 200, no legacy purchasing
     read request occurred, and browser errors were empty.
214. (Done; default-on) Route Vite analytics discovery, previews, and
     report generation through the existing Go Analytics session handler.
     Exact GET and POST method selectors default to Go and can be set to `0`
     for explicit legacy rollback. Preserve report JSON input/output, dataset
     read and `analytics.report` permissions, and HTML download behavior.
     Exact method and route tests cover enabled and disabled paths. The
     authenticated browser loaded discovery data, previewed Revenue by month,
     generated the report through Go, and downloaded the HTML output. The GET
     discovery, preview, and POST report requests returned HTTP 200; no legacy
     reports request or browser errors occurred.
215. (Done; Go route ownership verified) Route exact Vite `GET
     /api/inventory` requests, including `?sku=...` history queries, to Go
     unconditionally. The Go reader preserves the catalog and `{ movements }`
     contracts, strict movement validation, error behavior, and currency
     display. `GO_INVENTORY_READ_ROUTE=0` unmounts Go and Vite requests fail
     closed. POST and nested paths retain their current owner. Existing runtime
     role executor proofs verify stock report valuation and item-history tenant
     isolation. Focused Vite API/proxy and Go handler tests pass. Authenticated
     browser reads loaded the inventory catalog and timber movement history
     through Go with HTTP 200, preserved the UGX display, and had no browser
     errors.
216. (Done, default-on) Route the Vite Documents library list and preview detail
     through `documents.listIngestedDocuments` using inputs `{}` and
     `{id, preview:true}`. Gate the Vite selector on the session capability
     route and enforce default-on `GO_DOCUMENT_INGESTED_READS=1` in Go for
     every caller. For legacy rollback, set both the Vite and API document
     selectors to `0`.
     Strictly validate the success envelope and list/detail outputs, preserving
     organization-scoped permission checks, order, preview redaction, and the
     existing content link and editor routes. Selected-Go errors fail closed.
     Focused Vite tests pass. Authenticated browser proof loaded the empty
     library and a synthetic document with its preview through Go. Both read
     capability requests returned HTTP 200, no legacy `/api/documents` request
     or browser errors occurred. The empty response omits zero-length arrays;
     Vite now defaults those validated fields to empty lists.
217. (Done; default-on in `.env.example`) Route only Vite Purchasing requests and RFQs through the
     direct session-authenticated `purchasing.listPurchaseWorkflow` capability
     behind paired `CHASTE_GO_PURCHASING_WORKFLOW_READS=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors, with the API's
     `GO_PURCHASING_WORKFLOW_READS=1` capability gate enabled. Preserve the
     aggregate workspace for vendors, orders, bills, currency, aging, and
     analytics, replacing only `workspace.requests`. Set both workflow flags
     to `0` for explicit legacy rollback. Validate the full Go
     request/RFQ output and strip its additional RFQ `vendorId` field for the
     existing Vite contract. Selected-Go errors do not retry through the
     aggregate request. Focused Vite and Go route tests pass. Authenticated
     browser proof loaded the Requests & RFQs tab with the Go workflow selector
     enabled; list capability requests returned HTTP 200, no legacy
     `/api/purchasing` request or browser errors occurred.
218. (Complete) Route Vite authored-document version history and archived
     compare previews through `documents.listDocVersions` and
     `documents.getDocVersion` behind paired
     `CHASTE_GO_DOCUMENTS_VERSION_READS=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Enforce
     `GO_DOCUMENTS_VERSION_READS=1` on the Go session capability route for all
     callers, validate the full Go output, and project archived previews to the
     existing sanitized shape. Keep document content, collaboration, writes,
     and the Vite library read path unchanged. Selected Go errors fail closed.
     Authenticated Vite browser proof loaded the editor detail through Go,
     opened version history, and compared archived v1 and v2 content through
     the Go capability route. The comparison showed the expected archived
     contents, workspace POST and DELETE returned HTTP 200, and browser errors
     were empty with Next stopped.
219. (Complete) Route Vite mention-people and add-member lookups through
     `messaging.listPeople` unconditionally; the Vite people selector and
     legacy `GET /api/conversations/people` dependency are removed. The Go API
     enables the capability by default and `GO_MESSAGING_PEOPLE_READS=0`
     disables it for all callers. The capability requires organization-scoped
     `messaging.read`; Vite fails closed on Go errors. Preserve the initial
     limit of 100, searched limit of 30, trimmed 80-character query bound, and
     the Vite person/agent alias shape. Keep conversation, thread, presence,
     and message-search reads and all writes unchanged. On 2026-10-12,
     authenticated Vite `/messages` loaded mention people with
     `messaging.listPeople` at limit 100 and searched the add-member picker
     with query `Proof` at limit 30; both returned HTTP 200. The displayed
     `SMTP Proof User` alias appeared in the mention and add-member
     suggestions, and the browser error log was empty. See proof 328.
220. (Complete, default-on) Route Vite authored-document editor detail
     through `documents.getDoc` when `CHASTE_GO_DOCUMENTS_EDITOR_READS=1` and
     `CHASTE_GO_DOCUMENTS_VERSION_READS=1` are paired with the session route.
     The API independently gates `documents.getDoc` and
     `documents.listDocVersions` with default-on `GO_DOCUMENTS_EDITOR_READS=1`
     and `GO_DOCUMENTS_VERSION_READS=1`. Selected Go mode reads both document
     detail and version rows from Go with strict output validation; failed Go
     detail never retries through legacy. For full legacy rollback, set all
     four Vite and API editor/version selectors to `0`. Keep workspace,
     presence, autosave, collaboration, content writes, archive reads,
     compare-owned routes, and the Documents library unchanged. Authenticated
     browser proof loaded the editor detail and version rows from Go with Next
     stopped, and no browser errors occurred.
221. (Complete) Route the Vite HR Overview report
     through the existing Go `hr.report` capability unconditionally and remove
     the Overview selector and compile global. Keep other HR tabs on their
     current route selections. A Go error must fail closed without retrying
     legacy `/api/hr`. Authenticated Vite browser proof loaded `/hr` with Next
     stopped, received HTTP 200 for Go capability requests, and reported no
     browser errors or `/api/hr` request.
222. (Implemented) Remove the selected-Go 404 retry to legacy for Vite Manufacturing writes:
     BOM definition, work-order create/release/complete/cancel, BOM production,
     and production reversal. Preserve actor/org-scoped exact action and intent
     on a Go 404, allow retry only through Go, and block selector rollback until
     resolution. Keep legacy requests when their corresponding Go selector is
     off. Focused Vite API tests cover all listed action families.
223. (Complete; authenticated browser proof recorded in item 392) Remove selected-Go 404 fallback for Vite POS sale submission through
     `pos.completeSale`. Persist the route alongside its exact sale intent,
     preserve the marker on 404, and block retry through legacy after selector
     rollback. Retry the same payload and intent through Go only; explicit
     selector-off sales continue to use `/api/pos`. Treat pre-upgrade
     route-less sale markers as Go-pinned, matching their historical writer.
     Fail closed on present malformed retry markers, with a visible recovery
     message and no Go or legacy request.
224. (Complete) Route Vite `/purchasing/receiving`
     through Go for module status, order listing, receipt history, and receipt
     submission. Use the Go `/api/modules` route plus the session-authenticated
     `purchasing.listWorkspace`, `purchasing.listReceipts`, and
     `purchasing.receiveGoods` capabilities. Remove selector-based legacy
     fallbacks; validate capability envelopes and outputs, preserve the
     existing receiving page data shape, and require actor and organization
     scope with exact intent reuse for uncertain writes. Vite API tests verify
     all three Go capability calls and reject legacy-shaped responses. Existing
     Go receipt executor tests cover permission, tenant scope, governed writes,
     and receipt results. Authenticated browser proof is recorded in item 338.
225. (Complete; authenticated browser proof recorded in item 343) Route Vite
     BOM definition and deletion through Go's
     authenticated `manufacturing.defineBom` capability when
     `CHASTE_GO_MANUFACTURING_DEFINE_BOM_SLICE=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`, with
     `GO_MANUFACTURING_DEFINE_BOM_SLICE=1` enforced server-side for all
     capability callers. Set both BOM selector flags to `0` for legacy
     rollback. Compare exact current BOM components under an assembly row lock,
     return prior and resulting snapshots for inverse execution, and preserve
     `manufacturing.write` authorization, tenant scope, and actor/org-scoped
     exact retry behavior. Selected Go failures do not retry through legacy.
     Authenticated browser proof 343 verified a BOM replacement through Go and
     confirmed the updated component quantity on the Vite page. Other
     Manufacturing routes remain unchanged.
226. (Complete) Route the Vite Messaging conversation
     list and refresh through the session-authenticated
     `messaging.listConversations` capability when
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Enable the Vite selector by default
     and set `CHASTE_GO_MESSAGING_CONVERSATION_LIST=0` for explicit legacy
     rollback. Validate the strict Go envelope and preserve the page's list
     fields, including up to 100 conversations, unread counts, last-message previews, and the current
     user ID. Selected Go failures fail closed; thread reads and message search
     remain outside this slice. Authenticated `agent-browser` verification on
     2026-10-12 loaded the conversation list and refreshed it after creating a
     synthetic channel through Go; each `/api/capabilities/execute` request
     returned HTTP 200, the channel remained visible after page reload, no
     legacy conversation-list request occurred, and the browser error log was
     empty. See proof 318.
227. (Complete) Route initial and
     refreshed Vite Messaging threads through the session-authenticated
     `messaging.readMessages` capability. Return the latest 60-message window
     in display order with the current full thread contract, reader and pin
     state, and older-page cursor. Search-jump and older-page requests stay on
     their current routes; file downloads use the direct Go route in item 228.
     Proof 320 confirmed that the selected thread loaded through Go after send
     and after a full page reload, and rendered the message without browser
     errors.
228. (Complete) Serve Vite
     Messaging attachment downloads directly from Go while preserving the
     existing href. Go checks verified session, `messaging.read`, same-org
     conversation, membership, visible-message state, and pending uploader
     ownership before streaming the file with private, no-store headers. On
     2026-10-12, authenticated Vite `/messages` downloaded the synthetic
     attachment from `/api/message-attachments/{id}` through the Go route with
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`,
     `CHASTE_GO_MESSAGING_ATTACHMENT_DOWNLOAD=1`, and
     `GO_MESSAGE_ATTACHMENT_DOWNLOAD_ROUTE=1`. The downloaded bytes matched
     the uploaded fixture, and the browser error log was empty. See proof 324.
229. (Complete) Route Vite older
     thread pages through `messaging.readMessages` using a visible message ID
     scoped to the same organization and conversation. Use stable keyset
     pagination and preserve around-message search jumps as a separate read.
     Messaging client and page suites passed, and the Go latest-window test
     passed with runtime integration required. Authenticated browser proof is
     recorded in proof 386.
230. (Complete) Route Vite
     around-message thread reads through `messaging.readMessages`. Return the
     target with up to 30 older and 30 newer visible messages, use stable
     `(created_at, id)` ordering, and report older-side pagination metadata.
     Keep search result discovery separate from the thread read. Messaging
     client and page suites passed, and the Go around-window test passed with
     runtime integration required. Authenticated browser proof is recorded in
     proof 386.
231. (Complete) Route Vite read
     receipt updates through the session-authenticated
     `messaging.advanceReadCursor` capability when
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Set
     `CHASTE_GO_MESSAGING_READ_CURSOR=0` for explicit legacy rollback. Validate
     the strict capability result and fail closed on selected Go errors. On
     2026-10-12, authenticated Vite `/messages` advanced the read position
     after sending the synthetic attachment message through
     `messaging.advanceReadCursor`; Go returned HTTP 200 and Vite refreshed the
     conversation list. No legacy read-receipt request occurred, and the
     browser error log was empty. See proof 325.
232. (Complete) Route Vite
     pending attachment removal through `messaging.deletePendingAttachment`.
     Serialize deletion with concurrent message sends by locking the row and
     rechecking that it is still pending and owned by the actor. Keep the
     attachment in the draft and show an error when selected Go deletion fails.
     On 2026-10-12, authenticated Vite `/messages` uploaded a synthetic
     attachment through Go with HTTP 200, then retained it after the browser
     intercepted `POST /api/conversations/{id}/messages` and supplied HTTP 503.
     Removing the retained file through Go returned HTTP 200 and cleared it
     from the composer. No legacy attachment-delete
     request occurred, and the browser error log was empty. See proof 331.
233. (Complete) Route Vite message
     reactions and pins through the session-authenticated
     `messaging.setMessageReaction` and `messaging.setMessagePin` capabilities
     when `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Keep separate explicit
     rollbacks with `CHASTE_GO_MESSAGING_REACTIONS=0` and
     `CHASTE_GO_MESSAGING_PINS=0`; validate the exact output and requested
     state before refreshing the thread. On 2026-10-12, authenticated Vite
     `/messages` applied a heart reaction and pinned the synthetic message
     through `messaging.setMessageReaction` and `messaging.setMessagePin`;
     both returned HTTP 200, and the reaction and pinned marker appeared in
     the thread. No legacy reaction or pin request occurred, and the browser
     error log was empty. See proof 321.
234. (Complete) Route Vite typing and online presence through the
     session-authenticated Go conversation presence route when
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` and
     `CHASTE_GO_MESSAGING_PRESENCE=1`. The POST handler executes the
     `messaging.updateConversationPresence` capability and validates the
     conversation UUID, typing flag, and strict previous-state output. The GET
     handler reads presence within the authenticated organization and
     membership scope. Set `CHASTE_GO_MESSAGING_PRESENCE=0` for legacy
     rollback. On 2026-10-12, authenticated Vite `/messages` ran with both
     Vite and Go presence selectors enabled, sent `typing: true` and
     `typing: false` to the Go session route with HTTP 200, and received HTTP
     200 for the online presence GET polls. The browser error log was empty.
     See proof 322.
235. (Complete) Route pending
     conversation attachment uploads through the session-authenticated
     `messaging.uploadMessageAttachment` capability when
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Validate the upload receipt,
     enforce the existing 1-byte to 5-MiB limit before dispatch, and set
     `CHASTE_GO_MESSAGING_ATTACHMENT_UPLOAD=0` for legacy rollback. On
     2026-10-12, authenticated Vite `/messages` uploaded a 70-byte synthetic
     text attachment through `messaging.uploadMessageAttachment` with HTTP
     200, then sent it with a Go `messaging.sendMessage` request. The file
     appeared in the refreshed thread, with no browser errors. See proof 323.
236. (Complete) Route conversation
     creation through the session-authenticated `messaging.createConversation`
     capability when `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Validate the Go
     receipt, retain the exact request intent across reloads within the actor
     and organization session scope, and set
     `CHASTE_GO_MESSAGING_CONVERSATION_CREATE=0` for legacy rollback. On
     2026-10-12, authenticated Vite `/messages` created a synthetic channel
     with `messaging.createConversation` through Go, then refreshed the list
     and opened the thread; all capability requests returned HTTP 200, no
     legacy conversation-create request occurred, and the browser error log
     was empty. See proof 319.
237. (Complete) Route conversation
     settings updates through the session-authenticated
     `messaging.updateConversation` capability when
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Validate the Go receipt, reject
     empty updates before dispatch, retain the exact pending settings and
     intent across reloads within the actor, organization, and conversation
     scope, and set `CHASTE_GO_MESSAGING_CONVERSATION_UPDATE=0` for rollback.
     On 2026-10-12, authenticated Vite `/messages` renamed the synthetic
     channel through `messaging.updateConversation` with HTTP 200, and the new
     title appeared in the channel list and thread. No legacy conversation
     update request occurred, and the browser error log was empty. See proof
     326.
238. (Complete) Route conversation
     archive and restore actions through the session-authenticated
     `messaging.archiveConversation` capability when
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Require and validate the archived
     state, retain unresolved action and intent across reloads and selector
     rollback, and set `CHASTE_GO_MESSAGING_CONVERSATION_ARCHIVE=0` for
     rollback of new actions. On 2026-10-12, authenticated Vite `/messages`
     archived and restored the synthetic conversation through
     `messaging.archiveConversation`; both requests returned HTTP 200 and the
     active/archived counts updated after each action. The channel ended in
     Active, with no browser errors. See proof 327.
239. (Complete) Route leave-
     conversation actions through the session-authenticated
     `messaging.leaveConversation` capability when
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Retain unresolved action and
     intent across reloads and selector rollback, atomically remove membership
     in Go, and set `CHASTE_GO_MESSAGING_CONVERSATION_LEAVE=0` for rollback of
     new actions. On 2026-10-12, authenticated Vite `/messages` created a
     synthetic channel and left it through the Go capability route; the
     capability request returned HTTP 200 and the active conversation count
     returned to zero. No legacy leave request occurred, and the browser error
     log was empty. See proof 329.
240. (Complete) Route add-member
     actions through the session-authenticated `messaging.addMember`
     capability when `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Validate the
     target user against the active organization in Go, retain exact pending
     target and intent across reloads and selector rollback, and set
     `CHASTE_GO_MESSAGING_CONVERSATION_ADD_MEMBER=0` for rollback of new
     actions. The Messaging client and page suites passed, and Go's add-member
     receipt replay and concurrent-duplicate test passed with runtime
     integration required. Authenticated browser proof is recorded in
     proof 387.
241. (Complete) Route confirmed
     conversation deletion through the session-authenticated
     `messaging.deleteConversation` capability when
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Retain the exact request across
     reloads and selector rollback, clear it after the completed receipt
     before list refresh, and serialize deletion with sends and other
     lifecycle writes. Set `CHASTE_GO_MESSAGING_CONVERSATION_DELETE=0` for
     rollback of new actions. On 2026-10-12, authenticated Vite `/messages`
     deleted the confirmed synthetic channel through Go; the capability
     request returned HTTP 200 and the active conversation count returned to
     zero. No legacy delete request occurred, and the browser error log was
     empty. See proof 330.
242. (Complete) Route Vite
     Accounting invoice list reads through the session-authenticated
     `accounting.listInvoices` capability when
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Strictly validate the Go envelope
     and invoice rows, including safe integer `creditedMinor`, preserve the
     legacy route shape for explicit rollback, and fail closed on selected Go
     errors. On 2026-10-12, authenticated Vite `/accounting/invoices` loaded
     the empty-state page through `accounting.listInvoices`; with the Go read
     gate enabled, the capability returned HTTP 200. No legacy `/api/accounting`
     request occurred, and the browser error log was empty. See proof 332.
243. (Complete) Route Vite
     Accounting payment-reminder drafts through the session-
     authenticated `accounting.buildReminders` capability when
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Strictly validate the Go envelope
     and reminder rows, keep `CHASTE_GO_ACCOUNTING_PAYMENT_REMINDERS=0` as an
     explicit legacy rollback, and fail closed on selected Go errors. Add
     focused Vite API, selector, and Accounting page coverage. Go's binary
     customer-name tie ordering can differ from browser locale ordering for
     some names; reminder contents and grouping are unchanged. On 2026-10-12,
     authenticated Vite Accounting requested payment reminder drafts through
     `accounting.buildReminders`; the exact empty-input capability request
     returned HTTP 200 with no overdue balances, and the page showed that no
     customers needed chasing. No legacy accounting API request occurred, and
     the browser error log was empty. See proof 333.
244. (Complete) Route Vite
     cash-basis summary reads through the session-authenticated
     `accounting.cashBasisReport` capability whenever the Go session capability
     route is enabled. Strictly validate the Go response, including its
     `accrualExpenseMinor` field, then project to the existing five-field UI
     shape. Keep failures nullable and do not fall back to the legacy API.
     On 2026-10-12, authenticated Vite `/accounting` loaded the 2026 cash-basis
     summary through `accounting.cashBasisReport`; Go returned HTTP 200 with
     the expected zero-valued summary, and the page rendered its overview. No
     legacy `/api/accounting` request occurred, and the browser error log was
     empty. See proof 334.
245. (Complete; authenticated browser proof recorded in item 314) Route Vite
     Accounting overview reads through the session-authenticated Go
     `accounting.overview` capability unconditionally. Validate the strict
     overview response and safe-integer entry debit aggregates, and fail closed
     on Go errors without retrying the legacy overview route.
246. (Complete; authenticated browser proof passed) Route Vite Support
     inbox and selected-thread reads through the session-authenticated
     `support.listConversations` and `support.readConversation` capabilities
     when `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Validate the strict Go wire
     shapes, retain customer-bound inbox filtering, use full-detail thread
     reads, fail closed on selected Go errors, and set
     `CHASTE_GO_SUPPORT_INBOX_READS=0` for explicit legacy rollback.
247. (Complete; authenticated browser proof passed) Route Vite Support
     canned-response and knowledge-article reads through the session-
     authenticated `support.listLibrary` capability when
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Strictly validate the response,
     fail closed on selected Go errors, and set
     `CHASTE_GO_SUPPORT_LIBRARY_READS=0` for explicit legacy rollback.
248. (Complete; authenticated browser proof passed) Route Vite Support
     canned-response saves through the session-authenticated
     `support.createCannedResponse` capability when
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`. Persist the exact input and
     idempotency intent across uncertain failures and reloads, scoped to actor
     and organization; block fallback to legacy while a Go attempt is
     unresolved. Set `CHASTE_GO_SUPPORT_CANNED_RESPONSE_WRITE=0` for explicit
     rollback of new writes.
249. (Complete; authenticated browser proof passed) Route Vite Support
     conversation creation, posting messages, escalation, resolve, and reopen
     through the session-authenticated `support.startConversation`,
     `support.postMessage`, `support.escalateConversation`,
     `support.resolveConversation`, and `support.reopenConversation`
     capabilities. Persist exact actor- and organization-scoped payloads and
     intent IDs across uncertain results and reloads, restore them in the page,
     and block legacy fallback while unresolved. Preserve customer-words
     message attribution, with Go applying `support.write` permission checks
     and recording the signed-in human actor. Set
     `CHASTE_GO_SUPPORT_CONVERSATION_WRITES=0` for explicit rollback.
250. (Complete; field updates and clears passed authenticated browser proof) Route Vite Support
     ticket metadata updates through the session-authenticated
     `support.updateTicket` capability behind paired
     `CHASTE_GO_SUPPORT_TICKET_WRITES=1` and
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1` selectors. Persist exact
     actor- and organization-scoped payloads and intent IDs for uncertain
     results and reloads, restore the ticket fields for retry, and block legacy
     fallback while unresolved. Set `CHASTE_GO_SUPPORT_TICKET_WRITES=0` for
     explicit rollback.
251. Route the Vite onboarding state's GET and PATCH methods directly to Go
     alongside workspace creation when `CHASTE_GO_ONBOARDING_ROUTE=1`. Go
     resolves the signed-in session and active organization for the state read,
     returns the existing `{state, steps}` response, and updates onboarding
     status under `dbx.WithOrgTx`. Changed pending or skipped steps create the
     same notification as before in the state transaction. Keep the existing
     Go POST behavior and use the selector as an explicit rollback switch.
     (Complete; authenticated browser proof passed) The Vite
     onboarding API, wizard, page, and route-proxy suite passed all 190 tests;
     Vite typecheck and lint passed. The full Go HTTP API package passed with
     runtime integration required, including onboarding session, organization
     scope, state, notification, origin, and error-mapping cases. Independent
     review found no remaining issues.

252. Route the Vite Manufacturing overview report through a new
     `manufacturing.overviewReport` Go capability under the existing
     paired `CHASTE_GO_SESSION_CAPABILITY_ROUTE` and
     `CHASTE_GO_MANUFACTURING_PLANNING_READS` selectors. Setting either selector
     to `0` sends Vite overview and planning reads through the legacy
     `/api/manufacturing` endpoint. The Go read preserves
     the legacy strict response shape and limits: all organization BOM edges
     and items, the latest 100 work orders, up to 100 production runs grouped
     from the latest 2,000 stock movements, and the latest 200 lot balances.
     Production outputs retain output unit cost, rounded consumed cost,
     reversal state, and consumed lot codes. The DB-backed Go capability test
     passed with runtime integration required, covering authorization,
     organization isolation, report fields, and limits. The focused Vite API
     and route-selector suite passed all 205 tests; Vite typecheck and lint
     passed. `graft build` completed. Independent review found no actionable
     issues. (Complete; authenticated browser proof recorded in item 271)

253. Route the Vite Marketing overview read through the new
     `marketing.overviewSnapshot` Go capability by default whenever the
     session capability route is enabled; `CHASTE_GO_MARKETING_OVERVIEW_READS=0`
     is the explicit legacy rollback. Preserve the strict
     segments, campaigns, provider-confirmed send counts, and recent delivery
     log response. All four reads and all joined records are constrained to
     the active organization inside `dbx.WithOrgTx`. The DB-backed test passed
     with runtime integration required and verifies authorization, exact
     report fields, provider state, and cross-organization isolation. The
     focused Vite marketing API and selector suite passed all 190 tests;
     typecheck and lint passed. `graft build` completed. Browser proof is
     complete: an isolated authenticated Vite session rendered `/marketing`,
     received `GET /api/modules` from Go with 200, and completed
     `marketing.overviewSnapshot` through `POST /api/capabilities/execute` with
     200. The visible Marketing overview rendered without browser errors. The
     `/marketing` page is now Vite-owned in the generated route manifest.

254. (Implemented and runtime verified) Route the organization switcher's
     `/api/org` GET and POST through Go unconditionally from Vite. The Go handler
     is mounted by default unless `GO_ORG_ROUTE=0`; Vite has no rollback
     selector. The proxy preserves cookies, Origin, request bodies, and response
     cookies, and unsupported methods and suffix paths retain their current
     owner. Focused Vite tests cover exact method selection and forwarding; Go
     handler tests cover GET and POST membership, session, and cookie contracts.
     The authenticated onboarding journey
     completed with Go `POST /api/onboarding` and observed Go `GET /api/org`
     returning 200. An authenticated Vite browser POSTed the active member org
     to `/api/org`, received 200 `{ok:true}`, and the browser's HttpOnly
     `chaste_active_org` cookie changed from a deliberately invalid value to
     that org ID. The browser HAR omits `Set-Cookie` response headers, so the
     cookie jar before and after the request is the browser evidence. A forged
     nonmember UUID returned 403. GET and POST are Go-owned in the generated
     manifest; PUT, PATCH, DELETE, and suffix paths remain on their existing
     owner. The Go handler's unmount switch does not route requests back to the
     legacy server.
     The temporary user, organization, and dependent rows were removed after
     verification.

255. (Implemented and verified) Make the Go jobs worker the sole owner of
     `crm.createTask` jobs. The Go capability executor and worker RLS policy
     already support the operation; the TypeScript claimant excludes this
     type. At that point, `crm.completeTask`, `crm.updateTaskDetails`, and
     `crm.restoreTaskDetails` remained eligible for both workers; item 256
     completes their cutover. The Go database-backed CRM task worker test passed,
     proving task creation and action receipt; the focused TypeScript jobs
     suite passed all 7 tests, including that the legacy claimant skips the
     row without changing its status or attempts.

256. (Implemented and verified) Make the Go jobs worker the sole owner of
     `crm.completeTask`, `crm.updateTaskDetails`, and
     `crm.restoreTaskDetails`, completing the CRM task job family cutover
     started in item 255. The TypeScript claimant excludes all three while
     other CRM capability job types remain unchanged. The Go database-backed
     CRM task worker test passed for create, update, restore, and completion,
     including completion state, receipt, and system audit. The focused
     TypeScript jobs suite passed all 10 tests, including skip checks for all
     four Go-owned CRM task types.

257. (Implemented and verified) Make the Go jobs worker the sole owner of
     `crm.createDeal`, `crm.moveDealStage`, and `crm.convertLead`. Their Go
     capability handlers, worker permissions, and database-backed execution
     proof already existed. TypeScript ownership checks now prove the legacy
     claimant leaves each job pending; the Go deal worker DB test passed for
     deal creation, stage changes, and conversion. Other CRM capability job
     types remain unchanged. The focused TypeScript jobs suite passed all 13
     tests.

258. (Implemented and verified) Make the Go jobs worker the sole owner of
     `crm.createCustomer` jobs. The Go capability permission map and
     database-backed worker proof already cover governed creation, receipt
     replay, approval linkage, and audit. The TypeScript claimant now skips
     customer creation without changing its pending status or attempts; other
     CRM customer job types remain with their existing owners.

259. (Implemented and verified; full Go database worker proof passed) Make the
     Go jobs worker the sole owner of the full inventory cycle-count lifecycle:
     `inventory.createCycleCount`, `inventory.recordCycleCounts`,
     `inventory.postCycleCount`, and `inventory.cancelCycleCount`. The worker
     proof verifies tenant isolation, snapshot creation, count recording,
     variance posting, cancellation without a stock movement, action receipts,
     and system audit events for each successful capability execution. The
     TypeScript claimant leaves these jobs pending without incrementing
     attempts.

260. (Runtime verified) Route only
     `GET /api/pos` through the Go session handler. The handler preserves the
     legacy sessions and sales JSON contract, resolves cookie or bearer
     sessions, checks `pos.read`, validates the active organization, and reads
     within `dbx.WithOrgTx`. The database-backed test passed with the pinned Go
     toolchain and required runtime integration, proving tenant isolation and
     sale, return, tender, and stock tracking mappings. The Vite proxy tests
     cover exact GET path/method selection and rollback. `POST /api/pos` and
     `/pos` page ownership remain unchanged. On 2026-10-11, authenticated
     agent-browser opened `/pos` in Vite with the paired Go selectors enabled.
     The register workspace rendered its closed-register state, and both
     `/api/pos` and `/api/pos/customers` returned HTTP 200. No browser page
     errors were reported. The POS test fixture now mirrors the Go customer
     picker endpoint and fails if the legacy shared customer path is used.

261. (Implemented and verified) Make the Go jobs worker discover due recurring
     invoice templates, create one linked occurrence and job per scheduled
     tick under tenant RLS, and execute that exact occurrence through
     `accounting.generateDueInvoices`. The TypeScript claimant leaves this
     capability to Go. The DB-backed worker proof passed with concurrent
     scheduler retries, one linked job, invoice posting, schedule advancement,
     governed receipt, and system audit. The TypeScript claimant test passed
     all 19 cases, and the jobs-role metadata-boundary test passed all 10.

262. (Implemented and verified) Record `POST /api/pos/shift-summary` as a
     Go-only route in the generated ownership manifest. Its exact Go mount and
     Vite proxy are covered by route ownership, handler, router, and proxy tests.

263. (Implemented and verified) Mark `/pos` as Vite-owned after an authenticated
     browser proof covered register open, a manually entered cash sale and
     return, register close, shift summary, customer lookup, and the Go-backed
     empty inventory catalog. Each API used by the proof returned successfully
     from Go. The browser proof did not cover stock-tracked item effects.

264. (Runtime verified) An authenticated `agent-browser` session loaded the
     Vite dashboard and team pages through Go. Dashboard, setup, and my-work
     reads returned 200; the team page rendered the active member and role from
     `GET /api/team`. The `/analytics` catalog, preview, and generated report
     also returned 200. No browser console errors were reported. The notification
     feed and read-receipt proof is recorded in item 146.

265. (Done; focused parity proofs and authenticated browser proof pass)
     Move only the Vite approvals inbox `GET /api/approvals` read to Go. Go
     resolves the verified session and active organization, then reuses the
     tenant-scoped approval inbox reader and Go capability permissions. The
     paired Go and Vite route selectors default on with explicit `=0` rollback
     settings. Vite proxies only the exact GET. Handler, reader parity, ownership
     manifest, and Vite middleware tests cover the slice. On 2026-10-11,
     agent-browser opened
     `/approvals` in the authenticated Vite app, confirmed the empty inbox
     rendered, and observed `GET /api/approvals` return 200 through Go with no
     browser console errors.

266. (Runtime verified) Move only
     Vite `POST /api/approvals` decisions to Go. Go resolves the verified
     session and active organization, derives capability ID and payload digest
     from the tenant-scoped approval row, then uses the governed approval
     decider. Both approval and rejection require the row capability's mapped
     permission. The paired Go and Vite selectors default on and support
     independent `=0` rollback. The exact POST route is covered by router and
     proxy tests; other methods keep their current owner. On 2026-10-11, an
     authenticated Vite browser session approved and rejected seeded requests
     through Go. Both POSTs returned 200, the UI showed the matching success
     state, each row left the pending inbox and appeared in recent decisions,
     and the browser reported no errors.

267. (Runtime verified) Mark `/approvals` as Vite-owned after the authenticated
     browser proof loaded the page in the Vite app and exercised both Go-backed
     decisions. The generated route-ownership manifest and its exact ownership
     test now record the Vite page owner.

268. (Complete) Accept Better Auth's opaque user IDs when Vite
     scopes durable CRM retry intents. Keep organization IDs UUID-validated and
     keep the client actor identifier out of authorization claims; Go continues
     to derive authority from the authenticated session. API and CRM page tests
     cover opaque IDs and overlong-ID rejection. Authenticated browser proof of
     a CRM Go write using an opaque Better Auth ID is recorded in proof 390.

269. (Runtime verified) Mark `/crm` as Vite-owned after the authenticated
     browser proof loaded the CRM workspace, customer list, and customer
     timeline. The CRM deals, customers, tasks, saved views, and timeline reads
     returned 200 through Go, and the Vite component tests cover the page's
     write controls with Better Auth's opaque user ID format.

270. (Complete)
     Accept Better Auth's bounded opaque user IDs in local retry scopes for all
     Vite Go-backed writes. This covers CRM, products, accounting, HR, expenses,
     marketing, support, projects, and purchasing payment runs. Organization
     IDs remain UUID-validated, and the actor ID is only a local recovery key;
     Go derives identity and authorization from the verified session. Focused
     tests cover the opaque actor format and fail-closed invalid scopes.
     Authenticated Vite browser proof using an opaque Better Auth ID is
     recorded in proof 389.

271. (Complete) Keep `/manufacturing` in Vite and remove its link to the
     temporary legacy workspace. The page owns the overview, BOM, production,
     work order, and runs/lot sections. The initial authenticated browser
     proof on 2026-10-11 verified the Go overview report; proof 391 verifies
     the complete Vite and Go manufacturing flow and route ownership.

272. (Implemented and database-tested) Expose the existing Go
     `documents.listDocuments` capability to routine agents as
     `documents_listDocuments`, with a strict empty-object model schema and the
     existing `documents.read` permission. The routine integration proof
     verifies the local ingested document projection, excludes another
     organization's document, and records a session-linked system audit event.

273. (Implemented and database-tested) Make Go the only claimant for
     `purchasing.createPurchaseOrder`, `purchasing.receiveGoods`, and
     `purchasing.returnGoods`. Go processes all three through the existing
     governed system capability worker; TypeScript ownership tests verify that
     those queued jobs stay pending with zero attempts. The Go DB proof covers
     the full create, receive, and partial-return sequence, stock effect, one
     action receipt per job, and one audit event per action.

274. (Implemented; Go worker DB proof passed; TypeScript claimant exclusion
     passed) Make Go the only claimant for Purchasing payment-run creation,
     draft cancellation and restoration, and listing jobs. The Go DB proof exercises
     these four jobs through the governed worker, verifies tenant-scoped listing
     and final draft state, and counts each matching receipt and system audit.
     Approved instruction and reversal jobs use the separate approval-bound
     Go worker path documented in item 275.
275. (Implemented; worker DB proof passed; independent review clean) Make Go
     the only claimant for approved `purchasing.instructPaymentRun` and
     `purchasing.reversePaymentRun` jobs. The worker DB proof must bind each
     job to an approval with matching organization, capability, and exact
     payload, verify the posting and reversal state transitions, and count the
     receipt and system audit for each action. A mismatched approval must be
     denied without financial effects, including wrong-payload,
     wrong-organization, and wrong-capability approval links.

276. (Verified) Route the
     Vite marketplace listing read through Go's session-authenticated
     `creator.listMarketplace` capability. Preserve the legacy listing schema,
     and keep marketplace writes on their existing routes at this milestone.
     Marketplace signature verification later moved to Go in item 289 and
     publish moved in item 290. Go DB capability tests prove legacy listing
     parity; Vite client tests cover the capability request, response
     validation, and fail-closed behavior without legacy fallback. The
     marketplace API and page suites passed 31 tests, and two DB-backed Go
     marketplace listing parity and organization-access tests passed with
     runtime integration required.

277. (Implemented and verified) Route exact Vite `GET /api/portal/invoice/{token}`
     requests to Go by default, with no Vite rollback selector. Mount the Go
     handler by default; `GO_PORTAL_INVOICE_ROUTE=0` unmounts it. Preserve
     current ownership for other methods and suffix paths. Existing client and
     Go handler contract tests cover the token response, privacy headers,
     unknown or revoked links, and rate limiting. `agent-browser` confirms the
     public Vite route renders the safe not-found state for an invalid share
     token and the exact GET returns 404 without browser console errors.

278. (Implemented and verified against the Vite/Go contract; authenticated persona
     browser proof passed) Route exact Vite
     `PUT` and `PATCH /api/org` persona
     requests through Go. Keep exact path matching, preserve existing GET and
     POST routing, and leave DELETE and suffix paths with their current owner.
     Go enforces an 8,000 UTF-16-code-unit persona limit, including multibyte
     text, bounds escaped JSON request bodies, and requires same-origin Origin validation for cookie-authenticated POST and
     PATCH writes, accounting for configured trusted proxy CIDRs. Focused unit, runtime DB,
     settings client, and Vite proxy tests cover Go behavior and forwarding.
     The manifest assigns PUT/PATCH to Go with verified Vite/Go contract evidence
     under the narrow `/api/org` persona policy exception. No byte-for-byte
     Next response comparison is claimed; authenticated browser read/save,
     proxy, handler, and runtime-role tests cover the active target behavior.

279. (Implemented and verified against the Vite/Go contract; authenticated browser
     proof passed) Route exact `GET` and
     `POST /api/routines` requests from Vite Settings through Go by default.
     Preserve fallback ownership for unsupported methods and suffix paths, in
     particular `/api/routines/webhook/:token`. Restrict Vite schedule entry to
     phrases accepted by the Vite deterministic parser because Go does not
     run the legacy model refinement fallback. Go remains authoritative and
     validates every submitted schedule; the Vite guard is pre-submit
     feedback. The runtime HTTP proof resolves
     a signed session against the app database role, scopes reads and writes
     to the active organization, and verifies a created routine by readback.
     The webhook URL projection includes stored tokens for disabled routines,
     matching the legacy list response; scheduled routines with stored tokens
     also retain their URL, while webhook execution still refuses disabled or
     non-webhook routines. On 2026-10-14, authenticated Vite Settings listed
     routines from Go, created the synthetic Heartbeat routine through Go, and
     refreshed the list. All three requests returned HTTP 200 and the browser
     error log was empty.
     The manifest records both collection methods as Go-owned with verified
     Vite/Go contract evidence under a narrow policy exception. This does not
     claim byte-for-byte Next parity; the deterministic schedule parser scope
     is documented above. Webhook handling and worker
     execution remain separate migration items.

280. (Implemented and verified against the Vite/Go contract; authenticated browser
     proof passed) Route exact
     Vite Settings `GET` and `POST /api/memory` requests through Go by default.
     Go resolves the signed user session and active organization, uses a
     tenant-scoped projection for the legacy 200-row list contract, and derives
     `canEdit` from resolved permissions. Preserve empty and one-character
     searches, source matching, kind filtering, pre-filter `total`, preview and
     timestamp fields. Memory deletion continues through the governed
     `documents.deleteOrgMemory` capability, which enforces permission and
     organization scope. Unsupported methods and suffix paths retain their
     existing owner. The generated route manifest records both methods as Go-owned with verified
     Vite/Go contract evidence under an exact-path policy exception. No
     byte-for-byte Next response comparison is claimed.
     On 2026-10-14, authenticated Vite Settings loaded organization memory
     through Go, then deleted the synthetic onboarding entry through the
     governed Go route and refreshed the list. GET and POST returned HTTP 200;
     the browser error log was empty.

281. (Implemented and verified against the Vite/Go contract; authenticated browser
     proof passed)
     Route exact `GET` and `POST /api/module-settings` requests from the active
     Vite Inventory settings panel through Go by default. Go resolves the
     signed user session and active organization. Reads are available to
     organization members and run through `dbx.WithOrgTx`; missing rows return
     `{}`. Inventory reads apply the registered schema's trimming, validation,
     and unknown-key stripping. Writes accept only registered module settings
     (currently inventory) and execute `iam.setModuleConfig`, leaving
     `iam.admin`, approval, and audit enforcement in the capability executor.
     Unsupported module writes retain the legacy 404. The manifest records
     only exact GET/POST collection ownership as Go with verified Vite/Go
     contract evidence. No byte-for-byte Next response comparison is claimed.
     On 2026-10-14, authenticated Vite Settings read inventory defaults and
     saved a synthetic unit label and reorder point through Go. GET and POST
     returned HTTP 200, the UI confirmed the save, and the browser error log
     was empty.

282. (Implemented and verified against the Vite/Go contract; authenticated browser
     proof passed) Route exact
     `GET` and `POST /api/policy`
     requests from Vite Settings through Go by default. Reads require a signed
     session and active organization membership, use `policy.Reader.ForOrg`
     through `dbx.WithOrgTx`, return legacy defaults for a missing policy, and
     derive `canEdit` from resolved `iam.admin` permission. Writes preserve the
     legacy input constraints and pending/success envelopes and execute
     `iam.setOrgPolicy` through the capability executor. Cookie writes require
     same-origin validation. The generated route manifest records exact GET
     and POST ownership as Go with verified Vite/Go contract evidence under a
     narrow policy rule.
     On 2026-10-14, authenticated Vite Settings loaded and saved the existing
     governance policy through Go. GET and POST returned HTTP 200, the UI
     confirmed the save, and the browser error log was empty.

283. (Complete) Route Vite Accounting and Purchasing tax-code catalog reads
     through Go's `accounting.listTaxCodes` capability. Go requires
     `accounting.read`, executes the read in the active organization's
     `dbx.WithOrgTx`, and returns all tax codes in legacy active-first,
     newest-first order with the fields both Vite forms consume. Accounting
     continues to select active output codes; Purchasing continues to select
     active input codes. The existing `/api/accounting/tax` route remains for
     the legacy Next app. The canonical accounting registry and generated
     capability manifest now expose the shared schema and intent for other
     clients. The capability endpoint is already Go-owned; no global route
     ownership change is implied. The authenticated Vite browser proof is in
     proof 388. No Next differential was run because Vite and Go are the
     migration target.

284. (Complete; runtime-role DB projection proof, focused Vite API/proxy tests,
     and authenticated Support browser proof passed) Move
     only the Vite Support create-conversation customer picker to Go's exact
     `GET /api/support/customers` endpoint. Keep the shared `/api/customers`
     route and its POST writes with their existing owner because Vite CRM still
     uses that full directory contract as a fallback. Go resolves the signed
     session and active organization, permits `crm.read` or `pos.sell`, and
     applies legacy filtering: CRM readers can select deactivated customers;
     POS-only readers see active, non-merged customers. The query uses
     `dbx.WithOrgTx` and returns the picker `id`, `name`, and `email` fields in
     name order with the existing 500-row limit. The generated manifest adds
     only the new exact Go GET route. With Next stopped, authenticated Vite
     Support opened the new-conversation customer picker, showed the seeded
     customer, and received HTTP 200 from `/api/support/customers` with no
     browser errors.

285. (Complete; focused Vite HR page proof, runtime-role Go `hr.report`
     integration proof, and authenticated browser proof passed) Route the Vite HR People directory
     through the existing Go `hr.report` capability, matching Overview and
     retaining existing selected-Go behavior for Leave, Payroll, and Hiring.
     Preserve active organization resolution through the signed capability
     session, the shared `HrReport` response shape, and the employee list's
     newest-hired-first ordering with a 200-row limit. The People tab must not
     request legacy `GET /api/hr`; Go errors fail closed as they do for
     Overview. No route ownership changes are required. Direct authenticated
     load of `/hr?tab=people` with Next stopped rendered the People view, sent
     three Go capability requests with HTTP 200, made no `/api/hr` request,
     and reported no browser errors.

286. (Complete; focused Vite API/page tests, Go runtime-role projection proof,
     module checks, manifest parity check, and authenticated browser proof
     passed) Replace the Vite Purchasing workspace
     `GET /api/purchasing` read with the authenticated Go
     `purchasing.listWorkspace` capability. Preserve vendor, recent order and
     bill projections, payable aging, purchase requests and RFQs, price
     history, and supplier performance in one organization-scoped response.
     Require `purchasing.read`, preserve ordering, limits, nullable values,
     and legacy amount calculations, and keep every section populated when
     the dedicated workflow and Intel selectors are disabled. Do not change
     Purchasing writes or route ownership for the legacy Next app. With Next
     stopped, authenticated Vite loaded Purchasing overview, received HTTP
     200 from the Go workspace and inventory reads, made no `/api/purchasing`
     request, and reported no browser errors.

287. (Complete; focused Vite API/page tests, Go runtime-role projection proof,
     module checks, manifest parity check, and authenticated browser proof
     passed) Replace the Vite Accounting Banking detail
     GET with the authenticated Go `accounting.listBankingWorkspace` capability.
     Return accounts, newest unmatched/matched/excluded statement lines, recent
     payment candidates, and the `accounting.bankSummary` projection from one
     `dbx.WithOrgTx` transaction. Require `accounting.read`, preserve the
     existing ordering and limits, and validate the full response in Vite.
     Keep reconciliation writes on their current route and do not change the
     legacy Next route owner. Direct authenticated load of
     `/accounting?tab=bank` with Next stopped rendered the Banking detail,
     received HTTP 200 from Go capability requests, made no `/api/banking`
     request, and reported no browser errors.

288. (Complete; focused HR API/page tests, Go runtime-role `hr.report` proof,
     and authenticated browser proof passed)
     Route the Vite HR Time tab's employee-picker report through the existing
     session-authenticated `hr.report` capability. Keep time totals and
     pending-entry approvals on `hr.timeReport` and `hr.pendingTimeEntries`,
     respectively, and preserve existing time writes. A direct load of
     `/hr?tab=time` must render the employee picker using Go, request all three
     capabilities, and never call legacy `GET /api/hr`. Direct authenticated
     load of `/hr?tab=time` with Next stopped rendered the employee picker,
     sent all three Go capability requests with HTTP 200, made no `/api/hr`
     request, and reported no browser errors.

289. (Implemented; focused Vite API/page tests and authenticated browser proof
     passed) Route Vite
     Marketplace Verify through the session-authenticated
     `creator.verifyPlugin` capability. Send only `manifest`,
     `signatureBase64`, and `publisherPublicKeyBase64` in the capability input,
     and strictly validate `{ok:true,data:{valid,reason?}}`. An invalid
     signature is a successful Go verdict with `valid:false`, not an HTTP 422
     response. Preserve permission errors; publish, install, and uninstall use
     their authenticated Go capability cutovers.

290. (Implemented; focused Vite API/page tests, Go runtime-role DB proof, and
     authenticated browser proof passed) Route Vite Marketplace
     publish through the session-authenticated Go `creator.publishListing`
     capability. Send only `manifest`, `signatureBase64`, and
     `publisherPublicKeyBase64`, strictly validate success and pending approval
     envelopes, and route install and uninstall through Go. The Go runtime-role
     proof verifies governed persistence, submitting-organization ownership,
     and refusal to overwrite another publisher's slug. Vite tests cover
     publish success and list refresh, pending approval, errors, strict envelope
     validation, and no legacy publish request. The authenticated browser proof
     verified a signed manifest, published it through Go, and saw it in the
     Go-refreshed marketplace list with no browser page errors.

291. (Implemented; focused Vite API/page tests, a direct-human runtime-role DB
     proof, and authenticated browser proof passed) Route Vite
     Marketplace install through the session-authenticated Go
     `creator.installListing` capability, sending only the listing ID. Preserve
     signature and verified-status checks, idempotency, the installed-list
     projection, and other organizations' installed state. Use paired narrow
     `SECURITY DEFINER` helpers: one locks and returns signature fields without
     mutation, and the other derives the installer from transaction-local
     `app.org_id` and updates only install state. Both pin search path and are
     executable only by `chaste_app`. Keep uninstall idempotent and preserve
     publisher-owned fields.
     Vite tests cover the capability request, Go list refresh, pending approval,
     errors, and no legacy install request; runtime-role coverage proves signed
     install, idempotent repeat, invalid/unverified refusal, tenant preservation,
     and publisher-field protection. The authenticated Vite browser installed
     the signed listing through Go and rendered the refreshed installed state.

292. (Implemented; focused Vite API/page tests, a direct-human runtime-role DB
     proof, and authenticated browser proof passed) Route Vite
     Marketplace uninstall through the session-authenticated Go
     `creator.uninstallListing` capability, sending only the listing ID. Reuse
     the cross-publisher listing lock helper, then call a one-argument
     `SECURITY DEFINER` helper that derives the active org from
     transaction-local `app.org_id`, validates the JSONB installed-org array,
     and removes only that org. Pin `search_path`, revoke PUBLIC execution, and
     grant the helper only to `chaste_app`. Preserve idempotent success for
     repeated and initially absent installs; stale listing IDs must return
     not-found. Runtime-role proof covers another publisher, membership
     preservation, malformed state refusal without mutation, transaction/org
     mismatch, helper ACL/search path, publisher-field RLS, and human audit.
     Vite tests cover the listing-ID-only capability request, strict success
     and pending envelopes, Go listing refresh, and no legacy uninstall POST.
     The authenticated Vite browser removed the installed state through Go and
     the refreshed row returned to Install; all Marketplace and module requests
     returned 200 and page errors were empty. Local Go SMTP captured the
     verification email, and Go onboarding created a test workspace.

293. (Implemented; focused App and Dashboard tests, independent review, and
     authenticated agent-browser proof passed) Keep new or
     signed-in no-workspace entry on the Vite React app. The organization
     selector now replaces the current history entry and routes an account
     with no organizations to `/onboarding` without using the legacy redirect,
     and the Dashboard "Finish workspace setup" action points to the same-origin
     Vite route. Regression tests cover both entry paths. An authenticated
     browser signup and email verification through the local SMTP sink landed
     on Vite onboarding; Go onboarding POST/PATCH returned 200, and finishing
     setup opened the workspace dashboard on Vite. No browser page errors were
     reported.

294. (Implemented and verified: focused tests, Go runtime tests, authenticated browser proof)
     Route Vite onboarding customer and product
     CSV imports and undo exclusively through Go `crm.importCustomers`,
     `crm.undoCustomerImport`, `inventory.importItems`, and
     `inventory.undoItemImport`. Keep invalid CSV rows at the client boundary
     so valid rows can import, preserve source row numbers, duplicate counts,
     created IDs, and the customer Go import receipt for undo. Convert decimal
     major-unit values using the workspace currency's minor-unit scale and
     pass explicit minor-unit headers through without rescaling. Reject rows
     that supply both forms with a row-level error, and reject a
     request above Go's 64 KiB capability body limit before sending it. Enable
     the required Go import gates in `.env.example`. Keep per-batch undo
     receipts across split imports and reloads, retain CRM source intent IDs,
     and derive generated service SKUs deterministically so an exact retry
     keeps its payload. Focused Vite and Go runtime tests passed. Authenticated
     agent-browser proof with local SMTP verified customer and product imports,
     duplicate and invalid row handling, reload-safe undo, unchanged minor-unit
     credit limits, successful Go capability responses, and no legacy import
     requests or browser errors.

295. (Implemented and verified: focused onboarding tests and authenticated browser proof)
     When a signed-in account has a workspace but Go onboarding GET
     returns an unfinished state, keep the user on Vite onboarding with the
     active workspace ID and currency. Always reopen Data for the import path
     so saved per-batch undo receipts remain visible even after both import
     steps are marked done. Resume connect setup at Data while its step remains
     incomplete, otherwise return to Team. Redirect to the dashboard when
     onboarding state is absent or finished. Focused onboarding tests passed.
     Authenticated browser reload proof confirmed setup resumed at Data, undo
     receipts remained available, and completed import steps stayed done when
     continuing to Team.

296. (Implemented and verified: session resolver tests, independent review, and
     authenticated browser proof) Honor organization wildcard (`*`) role grants
     when Go resolves named permissions. Go onboarding assigns this grant to
     the workspace owner; checking only exact permission keys incorrectly
     denied owner-only Go settings writes. Unit and runtime-role integration
     tests cover named permission checks, and an independent review found no
     tenant-scope or fail-open regression. The authenticated Vite owner saved
     the agent persona through Go `/api/org` with HTTP 200; reload confirmed the
     saved value persisted, and browser errors were empty.

297. (Implemented) Move Vite Settings > AI & automation provider reads and
     writes off the legacy `/api/ai-config` owner. Add a dedicated Go public
     projection that never returns encrypted credentials, and execute provider
     writes through the existing governed Go settings capability. Route Vite
     GET and POST traffic to Go by default with an explicit rollback selector.
     Verify authenticated owner and denied-user behavior, secret redaction,
     approval response handling, persistence after reload, and zero legacy
     proxy requests. Focused Vite tests (212), typecheck, lint, and Go route
     integration tests pass. Independent review found no actionable issue.
     Authenticated `agent-browser` proof on Vite saved provider settings through
     Go with HTTP 200, reloaded the persisted workspace override, and showed no
     credential value or browser error. Go returned HTTP 200 on read; no legacy
     `/api/ai-config` proxy request occurred.

298. (Complete) Move Vite CRM lead conversion off legacy `/api/crm` and
     directly through Go `crm.convertLead`. Add an inverse before exposing this
     state change: restore the deal's prior lead state and remove only a
     customer created by this conversion when it remains unchanged and
     unreferenced. Preserve existing-customer conversions, organization scope,
     capability approval/audit/idempotency behavior, and actor/org-scoped Vite
     retries. Keep explicit selector rollback fail-closed. Verify both
     conversion modes and undo in Go tests and authenticated Vite browser proof.
     `TestCRMDealJobsClaimAndExecuteThroughSystemPath` proves create, approved
     undo, and reapply through the real Go jobs worker role. The authenticated
     Vite browser used local Go email verification and onboarding, converted
     one lead with a new customer and one with an existing customer, and saw
     HTTP 200 on Go capability and CRM read routes with no legacy CRM write or
     browser errors. Independent review found no remaining blocker.

299. (Complete) Move Vite authored-document editor presence, autosave drafts,
     soft locks, and release from the legacy workspace route to Go. The Go
     route resolves the authenticated session and active organization, checks
     request origin, and performs tenant-scoped writes through `dbx.WithOrgTx`.
     Drafts stay outside the capability ledger in keeping with ADR 0056. Go
     runtime-role integration proof covers heartbeat-only presence, autosave
     revision increments, stale revision conflicts, invalid bodies,
     cross-organization document rejection, another editor's lock, and
     caller-only release. An independent review found no actionable issue.
     With Next stopped, authenticated `agent-browser` opened the Vite editor,
     received HTTP 200 from workspace POST and DELETE requests, edited and
     reloaded the draft successfully, and reported no browser errors.

300. (Complete; focused Go/Vite tests, independent review, and authenticated
     browser proof passed) Move Vite
     Messaging presence GET and typing heartbeat POST to the Go route at
     `/api/conversations/{id}/presence`. GET validates the session, active
     organization, and conversation membership, then reads via
     `dbx.WithOrgTx`. POST validates same origin and delegates to the governed
     `messaging.updateConversationPresence` capability with the caller's intent
     ID, preserving module, permission, audit, receipt, and inverse behavior.
     Preserve the `people` response, 45-second online window, 8-second typing
     window, and explicit Vite/API rollback flags. Focused Go and Vite tests
     cover the route, intent propagation, authentication, disabled-module
     rejection, and exact proxy match. GET remains available while Messaging is
     disabled, matching the legacy GET route. The runtime-role integration
     proof runs POST through the real capability executor and verifies the
     action receipt and inverse data. With Next stopped, authenticated
     `agent-browser` loaded Vite `/messages`; presence GET and POST returned
     HTTP 200 and the browser reported no errors. Independent review found no
     remaining actionable issue.

301. (Implemented and verified) Move Vite Messaging global search from
     legacy `GET /api/messages/search` to the Go session-authenticated
     `messaging.searchMessages` capability. Preserve trimmed 2-100 character
     queries, case-insensitive literal matching, wildcard escaping, membership
     and organization scope, deleted-record exclusion, newest-first ordering,
     the 50-result cap, snippets, and sender/conversation metadata. Vite
     validates Go results and fails closed without retrying through Next.
     Focused Go runtime-role integration and Vite Messaging API/page tests pass.
     Authenticated `agent-browser` proof on 2026-10-12 created a message through
     Go, searched it from Vite `/messages`, and opened the result. The
     capability route returned HTTP 200, no legacy message-search request was
     made, and the browser reported no errors.

302. (Complete) Move Vite Settings SMTP status and test sends, plus
     Accounting invoice email, from the legacy `/api/email` route to Go.
     Go authenticates the session or bearer token, derives actor and
     organization identity, reads invoices within the organization, creates
     invoice links through `accounting.shareInvoice`, and sends email through
     SMTP. Failed sends use a bounded detached cleanup context to revoke newly
     created links; successful SMTP DATA remains delivered if QUIT fails.
     Sender parsing accepts a valid display name and rejects malformed or
     injected values. Focused Go tests, proxy tests, route ownership generation,
     independent review, and authenticated Vite Settings browser proof pass.
     The browser received HTTP 200 from Go status and test-send routes, the
     local TLS SMTP sink received the message, and the browser reported no page
     errors. Full workspace verification passed: typecheck, lint, all
     workspace tests, Go verification and vet, and generated route ownership
     checks.

303. (Runtime verified) An authenticated `agent-browser` session on 2026-10-12
     loaded Vite `/messages` on port 3300 against Go on port 18084, with Next
     stopped. It created a non-agent channel, sent a message, saw it in the
     refreshed thread, and completed reaction and pin actions. Go capability
     requests and presence GET/POST returned HTTP 200; the browser reported no
     errors. The first send attempt targeted an AI-enabled channel and stayed on
     the existing route, so this proof does not cover agent-enabled sends,
     attachments, or conversation lifecycle actions. Keep `/messages` legacy-
     owned until those remaining parity and browser gates pass.

304. (Focused browser verified) On 2026-10-12, an authenticated Vite Support
     session opened the new-conversation customer picker and created `Support
     Proof Customer` through Go's `crm.createCustomer` capability. The request
     to `/api/capabilities/execute` returned HTTP 200, the customer appeared in
     the picker, and no legacy `/api/customers` request was made. The write
     uses the CRM actor and organization retry scope and fails closed when the
     Go customer-create selector is disabled. This verifies Support quick-
     create only; it does not complete browser proof for Support inbox,
     selected-thread, library, conversation-write, or ticket routes in items
     246-250. The first proof run also exposed a missing Vite notifications
     selector: its GET fell through to the stopped Next app and returned 502.
     Restarting Vite with `CHASTE_GO_NOTIFICATIONS_ROUTE=1` routed the request
     to Go, confirmed by Go's unauthenticated 401 response. An authenticated
     notifications browser response was not recaptured after that selector
     correction.

305. (Complete; focused Go/Vite tests, independent review, and authenticated
     browser proof passed) Move the Vite CRM customer directory to the stable
     `GET /api/customers` endpoint owned by Go. The session-authenticated Go
     handler delegates CRM readers to `crm.listCustomerCollection` and retains
     the POS-only restricted projection with purchase counts and lifetime
     spend. Both paths resolve the active organization; POS reads use
     `dbx.WithOrgTx`. Keep POST and trailing customer paths on their existing
     owner, and use `CHASTE_GO_CRM_READS` to select Go or legacy for the exact
     directory GET. The focused Go and Vite tests cover permission precedence,
     tenant scoping, response fields, exact method/path routing, and rollback.
     On 2026-10-12, authenticated `agent-browser` created and verified a local
     account through Go auth and onboarding, then loaded the Vite CRM directory
     with Go enabled. `GET /api/customers` returned HTTP 200, the directory
     rendered, no legacy customer GET occurred, and the browser reported no
     errors. Independent review found no actionable issue.

306. (Runtime verified) On 2026-10-12, authenticated `agent-browser` opened
     Vite `/support`, created a local customer and conversation through Go's
     session capability endpoint, then saw the new conversation in the inbox
     and its selected thread in the page. All three capability requests
     returned HTTP 200; the request trace contained no legacy Support API calls
     and the browser reported no errors. This completes item 246 and verifies
     the conversation-create portion of item 249. Posting, escalation,
     resolution, and reopen remain unverified in the browser.

307. (Runtime verified) In the same authenticated Vite Support session on
     2026-10-12, opening Library loaded canned responses and knowledge articles
     through the Go `support.listLibrary` capability. The request returned
     HTTP 200, both lists rendered their empty states, no legacy Support API
     request occurred, and the browser reported no errors. This completes
     item 247.

308. (Runtime verified) On 2026-10-12, the authenticated Vite Support session
     saved a canned response from Library through the Go
     `support.createCannedResponse` capability. The capability request returned
     HTTP 200, the exact shortcut, title, and body appeared in the refreshed
     library, no legacy Support write request occurred, and the browser
     reported no page errors. This completes item 248.

309. (Runtime verified) In the authenticated Vite Support session on
     2026-10-12, the existing Go-created conversation accepted a
     customer-attributed message, escalation with a required human-review
     reason, resolution, and reopen. The `support.postMessage`,
     `support.escalateConversation`, `support.resolveConversation`, and
     `support.reopenConversation` capability requests each returned HTTP 200;
     the message and status changes rendered after refresh. No legacy Support
     write request or browser error occurred. Together with the conversation
     creation proof in item 306, this completes item 249.

310. (Runtime verified) On 2026-10-12, the authenticated Vite Support session
     saved ticket priority `High` and category `Migration verification`
     through `support.updateTicket`. The capability request and the refreshed
     `support.readConversation` request returned HTTP 200, and the updated
     fields remained visible in the ticket form. No legacy Support write
     request or browser error occurred. This verified setting metadata only;
     clearing existing fields remained unverified.

311. (Runtime verified) On 2026-10-12, the same authenticated Vite Support
     session cleared a previously set ticket category, assignee, and SLA
     deadline. The Vite request sent explicit `null` values through
     `support.updateTicket`, Go returned HTTP 200, and the refreshed ticket
     showed all three fields blank. No legacy Support write request or browser
     error occurred. Together with item 310, this completes item 250.

312. (Runtime verified) On 2026-10-12, the authenticated Vite browser session
     read onboarding state from `/api/onboarding`, sent an idempotent
     `business_profile: done` update, and read the state again. Go returned
     HTTP 200 for GET, PATCH, and the follow-up GET; the state remained
     consistent, and the browser error log was empty. The captured request log
     showed no legacy onboarding endpoint calls. The Vite process had
     `CHASTE_GO_ONBOARDING_ROUTE=1` and pointed to the running Go API. This
     completes item 251.

313. (Runtime verified) On 2026-10-12, the authenticated Vite CRM customer
     directory mapped a custom CSV's organization, email, and phone columns,
     reviewed one valid row, one invalid row, and a possible duplicate, then
     imported the selected customer through `crm.importCustomers` with HTTP
     200. After reload, the page restored the import's Undo action; undo through
     `crm.undoCustomerImport` also returned HTTP 200 and the imported customer
     disappeared from the active directory. The browser request log contained
     no `/api/import` calls, and the browser error log was empty. This completes
     item 188.

314. (Runtime verified) On 2026-10-12, the authenticated Vite Accounting page
     loaded its books and reports through Go. `accounting.overview`, the five
     financial report capabilities, `accounting.cashBasisReport`, and
     `accounting.listBankingWorkspace` each returned HTTP 200. The overview and
     accounting sections rendered, no legacy `/api/reports` request occurred,
     and the browser error log was empty. Vite had
     `CHASTE_GO_ACCOUNTING_REPORTS=1` and used the running Go API. This completes
     item 245.

315. (Runtime verified) On 2026-10-12, the authenticated Vite Sales page created
     a draft order for the synthetic proof customer through Go's
     `sales.createOrder` capability, refreshed it through `sales.listOrders`,
     and confirmed it through `sales.confirmOrder`. Each capability returned
     HTTP 200, and the page showed the order as confirmed. The request trace
     contained no legacy `/api/sales` calls and the browser error log was empty.
     The existing database-backed
     `TestSalesOrdersConfirmReservesGuardsAndBackorder` Go test passed against
     the configured database. This completes item 136.

316. (Runtime verified) On 2026-10-12, Vite routed account signup, verification,
     session lookup, and sign-in through Go's `/api/auth` routes. Signup and
     verification email requests returned HTTP 200; local TLS Mailpit captured
     the Go auth outbox email, and opening its verification link returned HTTP
     200. Sign-in and session lookup returned HTTP 200. The user completed Go
     onboarding to create a synthetic workspace; onboarding writes, team read,
     organization read, notifications, dashboard, setup, and My Work then each
     returned HTTP 200 from the authenticated Vite session. The browser error
     log was empty. This completes item 175.

317. (Runtime verified) On 2026-10-12, the authenticated Vite CRM Customers page
     created `Go CRM Create Proof 20261012` in the synthetic SMTP auth workspace
     through `/api/capabilities/execute` with HTTP 200. The Go-backed customer
     directory refresh returned HTTP 200 and showed the new row. The browser
     request trace contained no legacy customer-create POST, and the browser
     error log was empty. Vite and Go had the CRM customer-create and read
     selectors enabled. This completes item 172.

318. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` loaded
     its conversation list through Go and refreshed the list after a synthetic
     channel was created. The `/api/capabilities/execute` requests returned
     HTTP 200, the channel remained visible after a full page reload, no legacy
     conversation-list request occurred, and the browser error log was empty.
     This completes item 226.

319. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` created
     `Go Messaging Create Proof 20261012` with the Go
     `messaging.createConversation` capability. The captured request body
     contained the intended title and agent-enabled setting and returned HTTP
     200; Go then refreshed the conversation list and read the selected thread.
     No legacy conversation-create request occurred, and the browser error log
     was empty. This completes item 236.

320. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` sent
     `Go thread send and read proof 20261012` in the non-agent channel
     `Go Thread Proof 20261012` through the Go `messaging.sendMessage`
     capability, which returned HTTP 200. Go's `messaging.readMessages`
     capability returned HTTP 200 after send and after a full page reload; the
     message appeared in the refreshed thread. No legacy message-send or
     thread-read request occurred, and the browser error log was empty. This
     completes item 147.

321. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` applied
     a heart reaction to and pinned the synthetic message
     `Go thread send and read proof 20261012`. The Go
     `messaging.setMessageReaction` and `messaging.setMessagePin` capability
     requests both returned HTTP 200, and the refreshed thread displayed the
     reaction and pinned marker. No legacy reaction or pin request occurred,
     and the browser error log was empty. This completes item 233.

322. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` sent
     typing heartbeat updates with `typing: true` and `typing: false` through
     Go's session-authenticated `/api/conversations/{id}/presence` route; both
     returned HTTP 200. The online presence GET polls also returned HTTP 200.
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`,
     `CHASTE_GO_MESSAGING_PRESENCE=1`, and
     `GO_MESSAGING_PRESENCE_ROUTE=1` were set, and the browser error log was
     empty. This completes item 234.

323. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` uploaded
     the 70-byte file `chaste-message-attachment-proof-20261012.txt` through Go's
     `messaging.uploadMessageAttachment` capability; the upload and subsequent
     `messaging.sendMessage` requests both returned HTTP 200. The file appeared
     in the refreshed synthetic thread, and the browser error log was empty.
     This completes item 235.

324. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` opened
     the Go-backed `/api/message-attachments/{id}` link for the synthetic
     70-byte text attachment. `agent-browser` saved the download successfully,
     and its SHA-256 matched the local upload fixture. The selectors
     `CHASTE_GO_SESSION_CAPABILITY_ROUTE=1`,
     `CHASTE_GO_MESSAGING_ATTACHMENT_DOWNLOAD=1`, and
     `GO_MESSAGE_ATTACHMENT_DOWNLOAD_ROUTE=1` were enabled. The browser error
     log was empty. This completes item 228.

325. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` advanced
     the read cursor for `Go Thread Proof 20261012` through Go's
     `messaging.advanceReadCursor` capability after the synthetic attachment
     message appeared. The capability request returned HTTP 200, the
     conversation list refreshed, no legacy read-receipt request occurred, and
     the browser error log was empty. This completes item 231.

326. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` renamed
     `Go Thread Proof 20261012` to `Go Thread Proof 20261012 Updated` through
     Go's `messaging.updateConversation` capability. The request returned
     HTTP 200, and the updated title appeared in the conversation list and
     selected thread. No legacy conversation-update request occurred, and the
     browser error log was empty. This completes item 237.

327. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` archived
     and restored `Go Thread Proof 20261012 Updated` through Go's
     `messaging.archiveConversation` capability. Both requests returned HTTP
     200; the archived count changed to one, then returned to zero, and the
     active count returned to three. The conversation remained visible and the
     browser error log was empty. This completes item 238.

328. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` loaded
     mention candidates and searched the settings add-member picker through
     Go's `messaging.listPeople` capability. The initial list request used
     limit 100; the picker request used query `Proof` and limit 30. Both
     returned HTTP 200, and `SMTP Proof User` appeared in both suggestion
     surfaces. No legacy people-list request occurred, and the browser error
     log was empty. This completes item 219.

329. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` left the
     synthetic channel `Go Leave Proof 20261012` through the Go
     `messaging.leaveConversation` capability. The capability request returned
     HTTP 200, and the active conversation count returned to zero. No legacy
     leave request occurred, and the browser error log was empty. This proof
     covers the confirmed leave flow; retry and selector-rollback behavior were
     not exercised. This completes item 239.

330. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` deleted
     the confirmed synthetic channel `Go Delete Proof 20261012` through Go's
     `messaging.deleteConversation` capability. The capability request
     returned HTTP 200, and the active conversation count returned to zero.
     No legacy delete request occurred, and the browser error log was empty.
     This proof covers the confirmed delete flow; retry and selector-rollback
     behavior were not exercised. This completes item 241.

331. (Runtime verified) On 2026-10-12, authenticated Vite `/messages` uploaded
     the synthetic attachment through `messaging.uploadMessageAttachment`,
     which returned HTTP 200, then retained it after the browser intercepted
     `POST /api/conversations/{id}/messages` and supplied HTTP 503. Removing
     the pending file through `messaging.deletePendingAttachment` returned
     HTTP 200 and cleared the file from the composer. No legacy
     attachment-delete request occurred, and the browser error log was empty.
     The test send was intentionally intercepted and did not create a message.
     This completes item 232.

332. (Runtime verified) On 2026-10-12, authenticated Vite
     `/accounting/invoices` loaded its empty state through the Go
     `accounting.listInvoices` capability. The captured request body was
     `{"capabilityId":"accounting.listInvoices","input":{}}`; Go returned
     HTTP 200. `GO_ACCOUNTING_INVOICE_READS=1` was enabled locally, no legacy
     `/api/accounting` request occurred, and the browser error log was empty.
     This completes item 242.

333. (Runtime verified) On 2026-10-12, authenticated Vite Accounting's Cash &
     collections section requested payment reminder drafts through Go's
     `accounting.buildReminders` capability with empty input. Go returned HTTP
     200 with no overdue balances, and the page showed the no-customer-chasing
     empty state. No legacy `/api/accounting` request occurred, and the browser
     error log was empty. This completes item 243.

334. (Runtime verified) On 2026-10-12, authenticated Vite `/accounting` loaded
     the 2026 cash-basis summary through Go's `accounting.cashBasisReport`
     capability with input `{"year":2026}`. Go returned HTTP 200 with the
     expected empty-workspace summary, including `accrualExpenseMinor: 0`.
     No legacy `/api/accounting` request occurred, and the browser error log
     was empty. This completes item 244.

335. (Runtime verified) On 2026-10-12, authenticated Vite `/team` created a
     synthetic member invite through `POST /api/team`, which returned HTTP
     200. The follow-up `GET /api/team` also returned HTTP 200, and the page
     displayed the invite link and refreshed member list. No legacy team
     request or browser error occurred. The invite was created but not
     accepted. This completes item 148.

336. (Runtime verified) On 2026-10-12, authenticated Vite Settings loaded the
     agent persona, saved a synthetic persona through `PATCH /api/org` with
     HTTP 200, and reloaded it from Go after a full page reload. The browser
     showed the saved value, with no browser errors. This completes the
     authenticated browser proof for item 278; its live legacy differential
     remains open.

337. (Runtime verified) On 2026-10-12, authenticated Vite `/team` created a
     synthetic invitation through Go, and the invitee opened the Vite
     `/invite/{token}` route, completed signup and email verification through
     the local SMTP service, then accepted the invitation through Go with HTTP
     200. After reloading `/team`, the invitee appeared in the organization's
     member list with the invited role. No legacy invite route or browser
     error occurred. This completes the invitation acceptance proof for item
     148.

338. (Runtime verified) On 2026-10-12, authenticated Vite
     `/purchasing/receiving` loaded the receiving empty state. Go `GET
     /api/modules` and `POST /api/capabilities/execute` returned HTTP 200. No
     legacy `/api/purchasing` request occurred, and the browser error log was
     empty after reload. This completes item 224.

339. (Runtime verified) On 2026-10-12, authenticated Vite Inventory created
     synthetic item `MIG-PROOF-20261012` with barcode `MIGBAR-20261012` and
     opening stock through Go, then scanned that barcode in the cycle-count
     picker. The item was selected, Go returned HTTP 200 through
     `POST /api/capabilities/execute`, and no legacy `POST /api/inventory`
     lookup occurred. The browser error log was empty. This completes item 160.

340. (Complete; authenticated browser proof recorded in item 341) The Vite
     Inventory page no longer links to the legacy `/inventory` workspace. The
     existing page provides its stock report, item actions, cycle counts,
     locations, reservations, transfers, barcode lookup, lots, and movement
     history in Vite. Authenticated browser proof confirms the stock report and
     cycle-count creation use Go without legacy inventory requests.

341. (Runtime verified) On 2026-10-12, authenticated Vite `/inventory`
     loaded the synthetic stock report from `GET /api/inventory` (HTTP 200),
     showed the item created in proof 339, and created a synthetic cycle-count
     sheet through `POST /api/capabilities/execute` (HTTP 200). The barcode
     scan and item creation are recorded in proof 339. The legacy workspace
     link was absent, no legacy inventory request occurred, and the browser
     error log was empty. This completes item 340.

342. (Runtime verified) On 2026-10-12, authenticated Vite created synthetic
     purchase order 1 for `Go Proof Supplier 20261012` and received its two
     `MIG-PROOF-20261012` units. Both create and receive writes used
     `POST /api/capabilities/execute` and returned HTTP 200. The order showed
     Received, and `/purchasing/receiving` displayed receipt 1 with two units
     accepted, zero rejected, and zero outstanding. No legacy purchasing
     request occurred and the browser error log was empty. This completes item
     162 and extends the receiving runtime proof in item 338.

343. (Runtime verified) On 2026-10-13, authenticated Vite `/manufacturing`
     replaced a synthetic assembly BOM through `POST /api/capabilities/execute`
     (HTTP 200). The page showed the updated component quantity, no legacy
     `/api/manufacturing` request occurred, and the browser error log was empty.
     This completes item 225.

344. (Complete) Route Vite inventory item creation and adjustment, cycle-count
     creation and transitions, location and reservation writes, and transfer
     creation and confirmation through Go capabilities. Each client validates
     output envelopes, preserves actor/org-scoped retry intents, and fails
     closed when Go writes are disabled or unavailable. The authenticated
     browser proof is recorded in item 345.

345. (Runtime verified) On 2026-10-13, authenticated Vite `/inventory` created
     a stock location through `POST /api/capabilities/execute` (HTTP 200). The
     same focused browser proof exercised location and reservation creation and
     reservation release through Go (HTTP 200). No legacy `POST /api/inventory`
     request occurred, and the browser error log was empty. This completes
     item 344.

346. (Complete) Route Vite Products & Services item creation, editing,
     archiving, and stock adjustments through Go's authenticated capability
     endpoint. Require active actor and organization scope, preserve exact
     actor/org-scoped retry intents, validate action-specific results before
     reporting success, and fail closed without a legacy inventory write.
     Authenticated browser proof is recorded in item 347.

347. (Runtime verified) On 2026-10-13, authenticated Vite `/products` edited
     a synthetic item through `POST /api/capabilities/execute` (HTTP 200), and
     the updated name appeared in the catalog. No legacy `POST /api/inventory`
     request occurred and the browser error log was empty. This completes
     item 346.

348. (Complete) Route Vite Accounting year-end close through Go's authenticated
     `accounting.closeYear` capability with active actor and organization
     scope, an exact retry intent, and strict result validation. Keep invoice
     workspace links on the Vite route.

349. (Runtime verified) On 2026-10-13, authenticated Vite `/accounting?tab=periods`
     submitted the synthetic workspace's 2026 close through
     `POST /api/capabilities/execute`. Go returned its expected no-activity
     refusal (HTTP 500); Vite retained the exact retry marker. The invoice
     workspace link opened Vite `/accounting/invoices` and loaded its empty
     state. No legacy invoice route was opened. This verifies Go routing,
     refusal handling, retry behavior, and Vite navigation; a successful close
     still requires a workspace with income or expense activity. This completes
     item 348.

350. (Complete) Route Vite Support knowledge-base article creation through
     Go's authenticated `support.createKbArticle` capability with active actor
     and organization scope, exact retry protection, strict result validation,
     and no article-write fallback to the legacy endpoint.

351. (Runtime verified) On 2026-10-13, authenticated Vite Support created a
     synthetic internal knowledge-base article. Go capability execution
     returned HTTP 200 and the article appeared in the library. The browser
     made no legacy `POST /api/support` request and reported no page error.
     This completes item 350.

352. (Complete) Complete Vite Documents write paths through Go: create an
     authored draft, save a document template, ingest pasted text, and upload
     PDF or image files. Bound uploads to 5 MiB at both the browser and Go
     capability body boundary, and keep ordinary Go capability requests at
     64 KiB.

353. (Runtime verified) On 2026-10-13, authenticated Vite `/documents` added
     a synthetic text record and a 128 KiB PDF through Go's
     `documents.createDocument` capability (HTTP 200). The record list and
     detail reflected both writes. The same browser session created a draft,
     opened its Vite editor, and saved a template through Go (HTTP 200). No
     browser console or page errors occurred. Go tests verified that 5 MiB
     document payloads pass and oversized document payloads fail, while other
     capabilities retain the 64 KiB limit. This completes item 352.

354. (Complete) Mark `/onboarding` as Vite-owned after matching the route
     ownership manifest to the existing Vite wizard and its Go onboarding API.

355. (Runtime verified) The authenticated signup and email-verification proof
     in GATES.md item G102 used the local SMTP sink, then completed the Go
     onboarding POST/PATCH flow and opened the Vite dashboard. The route
     ownership manifest now records `/onboarding` as Vite-verified. This
     completes item 354.

356. (Complete) Add Vite Sales quote creation/listing/acceptance through Go's
     authenticated `accounting.createQuote`, `accounting.listQuotes`, and
     `accounting.acceptQuote` capabilities. Load the related customer and deal
     views with `crm.listCustomers` and `crm.listDeals`, validate response
     UUIDs and amounts, preserve exact actor/workspace-scoped retry intents for
     writes, and remove the link to the legacy Sales workspace.

357. (Runtime verified) On 2026-10-13, the authenticated Vite browser created
     quote #1 for a synthetic customer, then accepted it into invoice #1.
     The quote list showed the accepted status and UGX 125 total; the customer
     and deal tabs loaded from the Go-backed workspace. Quote create, accept,
     and subsequent quote/customer/deal reads used authenticated
     `/api/capabilities/execute` requests with HTTP 200. No quote or deal
     traffic used `/api/quotes`, `/api/deals`, or port 3001. The browser page
     error log was empty. Runtime testing also caught and fixed a retry-scope
     check that incorrectly required Better Auth user IDs to be UUIDs. The
     full CRM page still has legacy customer reads, so this proof only covers
     the Sales quote workspace. Go rejects invalid input and amounts beyond
     PostgreSQL integer bounds, and returns HTTP 422 for a missing or foreign-
     workspace customer. This completes item 356.

358. (Complete) Keep the Settings links for Team & roles, agent sessions, and
     creator proposals on their same-origin Vite routes instead of sending
     users to the legacy application.

359. (Runtime verified) On 2026-10-13, the authenticated Vite Settings page
     exposed `/team` and `/sessions` for its Workspace links and `/proposals`
     and `/sessions` for its AI links, all resolving to `localhost:3000`.
     Clicking Team & roles opened the Vite `/team` page in the same tab. The
     browser error log was empty; 14 Settings tests, Vite typecheck, focused
     lint, and diff checks passed. This completes item 358.

362. (Complete) Move Vite CRM reads for deals, customers, follow-up tasks,
     saved views, and customer timelines to Go's authenticated capability
     executor. Validate capability envelopes and returned data, use the
     existing session and organization scope, and fail closed without legacy
     API fallbacks.

363. (Runtime verified) On 2026-10-13, the authenticated Vite CRM page loaded
     `crm.listDeals`, `crm.listCustomerCollection`, `crm.listTasks`, and
     `crm.listCustomerViews` through `/api/capabilities/execute`, all with
     HTTP 200. The customer directory showed the existing synthetic Sales
     customer; pipeline and task views rendered their empty states, and the
     saved-view selector showed no saved views in this workspace. Opening the
     customer's history called `crm.customerTimeline` with HTTP 200 and showed
     its accepted Quote #1 and sent Invoice #1. No legacy CRM read requests or
     browser page errors occurred. The API and page tests (109 total), Vite
     typecheck, focused ESLint, and diff checks passed. This completes item
     362.

360. (Complete) Route Vite HR reports, employee actions, time data, and expenses
     directly through authenticated Go capabilities. Remove the HR and time
     legacy API fallbacks from the Vite adapters.

361. (Runtime verified) On 2026-10-13, the authenticated Vite HR People page
     created an employee in the Migration Proof Workspace, showed it as active,
     and retained it after reload. Writes and HR reads used
     `/api/capabilities/execute` with HTTP 200. No `/api/hr` or `/api/time`
     requests or browser errors occurred. Typecheck, scoped lint, and 49 HR
     tests passed. This completes item 360.

364. (Complete) Route all Vite Manufacturing reads and writes through Go's
     authenticated capability executor. Remove client legacy route selectors,
     preserve exact scoped retry intent and validated action data across reload,
     and return expected business refusals as recoverable client errors.

365. (Runtime verified) On 2026-10-13, the authenticated Vite browser loaded
     Manufacturing reads and saved a BOM through Go capabilities. Aborting a
     write showed a saved retry action; replay after reload sent the same input
     and intent. An invalid assembly returned HTTP 422, cleared the terminal
     attempt, and allowed a corrected BOM write. No `/api/manufacturing`
     requests or browser errors occurred. The page suite passed 24 tests,
     focused Vite API and Go handler checks passed, along with typecheck and
     scoped lint. This completes item 364.

366. (Complete) Move the Vite Proposals page reads, human review decisions,
     and candidate release transitions to authenticated Go capabilities.
     Scope proposal review by organization and stored permission, preserve
     compare-and-set transitions, and show setup guidance that applies to the
     user's local agent instead of relying on the Next server's PATH.

367. (Runtime verified) On 2026-10-13, the authenticated Vite Proposals page
     rendered proposals, capability gaps, and setup guidance. Both list calls
     used `/api/capabilities/execute` and returned HTTP 200. No legacy proposal,
     capability-gap, or creator-agent routes were requested and the browser
     error log was empty. The Vite proposal suite, typecheck, scoped lint, and
     database-backed Go capability and HTTP tests passed. This completes item
     366.

368. (Complete) Move the Vite receipt history page and Receiving desk order
     and history reads to Go's authenticated Purchasing capabilities. Remove
     obsolete receipt-read selectors and route Purchasing cross-links to the
     active Vite pages.

369. (Runtime verified) On 2026-10-13, the authenticated Vite receipt history
     page showed its empty state using Go capability reads with HTTP 200, with
     no `/api/purchasing` requests or browser errors. The Receiving desk and
     Purchasing links now stay under Vite routes. Receipt, Receiving desk, and
     proxy suites passed (252 tests), Vite typecheck and scoped lint passed.
     This completes item 368.

370. (Complete) Load Vite development selectors from the repository-root
     `.env` so the documented `pnpm dev` setup reaches the configured Go
     capabilities when Vite runs inside its workspace package.

371. (Runtime verified) On 2026-10-13, the authenticated Vite purchasing flow
     created a vendor and purchase order, recorded a receipt against its
     stocked line, then showed receipt #1 and the accepted/outstanding
     quantities in receipt history. Vendor, order, receipt, and history
     requests used `/api/capabilities/execute` with HTTP 200 after Vite loaded
     the repository-root configuration. No `/api/purchasing` request was made
     during the proof. Typecheck, focused lint, and the 252 purchasing and
     proxy tests passed. This completes item 370.

372. (Complete) Serve Vite document file downloads from the Go API at
     `/api/go/documents/{id}/content`. Resolve the signed session, verify the
     active organization, `documents.read` permission, and Documents module,
     then read the file through an organization scoped transaction. Validate
     stored content and return bounded file bytes with safe download headers.

373. (Runtime verified) On 2026-10-13, the authenticated Vite browser uploaded
     a synthetic PDF, opened its document detail, and fetched the file from
     `/api/go/documents/{id}/content` with HTTP 200. The response was a bounded
     attachment with `application/octet-stream`, no-store and sandbox headers.
     The response length matched its `Content-Length`, and the browser reported
     no page errors. Go tests cover authorization, module state, response
     metadata, and organization isolation; Vite tests cover direct Go routing.
     Independent review found no security or correctness blocker. This
     completes item 372.

374. (Complete) Move Vite Settings runtime composition history to the
     authenticated Go `harness.listCompositions` capability. Scope reads to
     the active organization, verify persisted composition digests, and return
     safe metadata without patch values to authorized human operators.

375. (Runtime verified) On 2026-10-13, the authenticated Vite Settings Runtime
     tab loaded its empty state through `harness.listCompositions` with HTTP
     200. No legacy `/api/harness/compositions` request was made and the
     browser reported no page errors. The Go startup registry regression and
     executor tests passed, including explicit empty-module lists for both
     supported permissions, along with 46 Vite Settings tests. Independent
     review approved the permission and module-gate behavior. This completes
     item 374.

376. (Complete) Bind asynchronous Vite POS return recovery, quick item
     creation, and opening-stock completion to the actor and organization
     scope captured when each request starts. Reset quick-add form state on
     organization changes and ignore stale responses in the new register.
     Keep Go routine webhook enqueue limited to enabled webhook routines and
     restrict the application database role to the enqueue function.

377. (Runtime verified) On 2026-10-14, authenticated agent-browser loaded the
     Vite POS register with the paid synthetic sale still visible after reload.
     Go POS reads and capability requests returned HTTP 200 and the browser
     reported no page errors. Workspace typecheck passed all 27 packages, lint
     had no errors, all 25 Turbo test tasks passed, and `pnpm go:verify` passed
     with runtime integration required. POS regressions cover delayed sale,
     return recovery, item creation, and opening-stock responses after an
     organization switch. Independent webhook and POS reviews found no
     remaining actionable issue. This completes item 376.

378. (Complete) Add `accounting.arAging` to the Go Messaging agent tool catalog
     with a closed empty-object input schema and descriptive output guidance.
     Advertise it only to users with `accounting.read`, and execute it through
     the existing tenant-scoped capability executor with the agent session and
     signed user claims intact. Tests cover catalog permission filtering and
     governed executor dispatch. This advances Go agent operational breadth;
     additional supported capabilities still need authored contracts.

379. (Verified) On 2026-10-14, `GO_RUNTIME_INTEGRATION_REQUIRED=1 pnpm
     go:verify` passed after the new Messaging tool was added. The tool
     catalog permission test, governed dispatch test, existing receivables
     aging executor integration tests, all Go HTTP tests, and `go vet` passed.
     Independent review found no actionable issue. This completes item 378.

380. (Complete) Keep unknown Vite page URLs inside the React app. Remove the
     browser redirect to the legacy app, render an explicit not-found page, and
     keep all visible navigation links on Vite-owned routes.

381. (Runtime verified) On 2026-10-14, authenticated `agent-browser` loaded
     an unknown URL directly in Vite, rendered its not-found page and home link,
     remained on the Vite origin, and reported no browser errors. The 34 focused
     Vite app tests passed; workspace typecheck passed all 27 packages; lint
     reported 206 existing warnings and no errors; all 25 Turbo test tasks and
     `pnpm go:verify` with runtime integration required passed. Independent
     review found no route regressions. This completes item 380.

382. (Complete) Route every Vite `/api` request to the Go API. Keep explicitly
     selected Go handlers intact, send unclaimed paths through the Go catch-all,
     and return Go's response, including 404 for unsupported paths. Selector
     opt-outs no longer restore routing to the legacy Next app.

383. (Runtime verified) The Vite proxy suite loaded the actual Vite config and
     verified the API catch-all shares the Go origin with health and capability
     execution. An unsupported path returned the Go 404 response; a separate
     legacy recorder received no request. Existing proxy checks passed for
     request data and selector opt-outs. Vite lint, typecheck, production build,
     and `git diff --check` passed. This completes item 382.

384. (Complete) Make `pnpm dev` start the React/Vite app only. Keep the
     temporary Next.js compatibility server behind the explicit
     `pnpm dev:legacy` command, and document Go API startup separately.

385. (Runtime verified) The root package script assertion passed. Running
     `pnpm dev` started Vite at `http://localhost:3000`; installed
     `agent-browser` loaded the Vite not-found page, retained the Vite URL, and
     reported no browser errors. A TCP check confirmed the legacy server port
     3001 stayed closed. This completes item 384.

386. (Runtime verified) On 2026-10-14, authenticated `agent-browser` searched
     the synthetic `Migration paging proof` conversation for message 61.
     Go's `messaging.readMessages` around request returned HTTP 200 with the
     61-message window 31 through 91, and the older-page request using the
     returned visible-message cursor returned HTTP 200 with messages 01
     through 30. With the reader away from the bottom, the around result,
     message 01, and message 61 stayed rendered through a five-second poll
     interval; no latest-page read was issued. The browser error and console
     logs were empty. This completes items 229 and 230.

387. (Runtime verified) On 2026-10-14, authenticated Vite invited a synthetic
     teammate to the local proof workspace, verified the account through the
     Go SMTP path, and accepted the invitation through Go with HTTP 200. In
     the `Migration paging proof` channel, the Vite add-member picker found
     `Migration Proof Teammate`; the `messaging.addMember` capability request
     returned HTTP 200. The database contains one matching ledger event and
     one conversation membership for that user. The browser error log was
     empty. This completes item 240.

388. (Runtime verified) On 2026-10-14, authenticated Vite created a local
     Uganda tax profile and synthetic active output and input tax codes
     through Go's `accounting.createTaxProfile` and `accounting.createTaxCode`
     capabilities. Go's `accounting.listTaxCodes` returned HTTP 200 with both
     directions. The Accounting Tax tab displayed only `MIGOUT18`; Purchasing's
     vendor-bill form offered only `MIGIN18` under Input tax. The browser error
     log was empty. This completes item 283.

389. (Runtime verified) On 2026-10-14, authenticated Vite loaded Projects
     collection and board data through Go's `/api/projects` and `/api/team`
     routes. The authenticated Better Auth user ID was opaque and not a UUID.
     Vite created a synthetic project and a task assigned to the synthetic
     teammate, then moved the task to Doing through Go's
     `projects.createProject`, `projects.createTask`, and `projects.moveTask`
     capabilities; all returned HTTP 200. After reload, the project, task
     status, and assignment remained. No browser errors occurred. This
     completes item 270 and verifies the Projects browser flow.

390. (Runtime verified) On 2026-10-14, authenticated Vite saved the synthetic
     customer view `Migration CRM Opaque ID Proof 20261014` through Go's
     `crm.saveCustomerView` capability with HTTP 200. Go refreshed the view
     list and the saved view appeared in the Vite customer selector. The
     authenticated Better Auth user ID was opaque and not a UUID. The browser
     error log was empty. This completes item 268.

391. (Runtime verified) On 2026-10-14, authenticated Vite created synthetic
     assembly and component items through `inventory.createItem`, stocked the
     component through `inventory.adjustStock`, defined the BOM through
     `manufacturing.defineBom`, and received a producible BOM report through
     `manufacturing.bomReport`. Vite then created, released, and completed a
     two-unit work order through Go capabilities. Every capability returned
     HTTP 200. The Runs & lots page displayed the production record, consumed
     component quantity, and completed state after a full reload; the browser
     error log was empty. This completes item 271.

392. (Runtime verified) On 2026-10-14, authenticated Vite submitted the
     synthetic POS cart to `pos.completeSale` with a simulated Go HTTP 404.
     The UI kept the sale attempt locked, showed recovery instructions, and
     retained the cart. Retrying sent the same payload and intent ID to Go
     again. Both requests were intercepted before reaching the API, no legacy
     `/api/pos` write was issued, the register still showed zero completed
     sales, and the browser error log was empty. This completes item 223.

393. (Complete) Keep Vite Marketplace listing and signature verification
     available when the Creator module is disabled, matching Go's human
     organization-member contract. Hide publish and install controls until
     Creator Mode is enabled.

394. (Complete) The Marketplace page suite proves the disabled-module state
     still calls Go `creator.listMarketplace` and `creator.verifyPlugin`,
     renders returned listings, and exposes no Creator mutation controls. An
     authenticated `agent-browser` proof disabled Creator in Settings, loaded
     the Go-backed listing, verified a manifest, observed Go return the
     expected invalid-schema verdict with HTTP 200, and confirmed no publish
     or install controls were available. Vite typecheck and scoped lint passed.
     This completes item 393.
395. (Complete) The Vite Reports screen confirms and posts period-end FX
     revaluation through `accounting.revalueForeignReceivables`. An authenticated
     `agent-browser` proof selected October 2026, confirmed the modal, and
     observed Go return HTTP 200 with a persisted revaluation result and no
     journal entry for a workspace with no foreign receivables. Component tests
     also cover restoration of an unresolved period across reload and retry
     with the same intent ID. The Go integration suite covers nonzero FX
     postings.
396. (Complete) `/api/modules` lets a stale `chaste_active_org` cookie reach
     the membership-safe Go organization resolver while continuing to reject an
     explicit mismatched `X-Organization-ID`. Focused handler and runtime DB
     resolver tests passed. An authenticated `agent-browser` request with a
     deliberately stale organization cookie returned HTTP 200 from Go and
     `/api/org` confirmed the active workspace remained the signed-in user's
     actual organization.

397. (Complete) Vite Projects surfaces failed or malformed Go `/api/team`
     responses and disables task assignment controls until the directory loads.
     Focused API and component tests cover the failed response, disabled
     controls, and successful retry. Authenticated `agent-browser` forced the
     Go team request to fail, confirmed the visible retryable error, removed the
     failure, and retried successfully. The authenticated member then appeared
     in task assignment choices. This completes the Projects runtime proof.

398. (Complete) Add Vite Inventory valuation posting and reversal through Go
     `inventory.postValuationSummary` and `inventory.reverseValuationSummary`.
     Recent history comes from Go Accounting overview, which requires
     `accounting.read`; posting remains available to `inventory.write` users if
     history is denied, while reversing a summary requires Accounting access.
     Confirmation copy describes approval as dependent on workspace policy.
     Focused API and component tests cover zero variance, posting, pending
     approval, reversal, exact retry after an uncertain result, and posting
     when history returns 403. Authenticated `agent-browser` used a Go
     purchasing receipt to create UGX 10,000 of stock value against a zero GL
     balance, posted and reversed the valuation through Vite, then reloaded and
     confirmed there were no unreversed valuation summaries. Browser errors
     were empty. This completes the Inventory valuation runtime proof.

399. (Runtime verified) Authenticated Vite opened and closed a Go POS register
     with a UGX 100 opening float and a UGX 100 counted drawer. Go returned
     HTTP 200 for both `pos.openSession` and `pos.closeSession`. After reload,
     Vite Sessions displayed expected cash UGX 100, counted cash UGX 100, and
     variance UGX 0 without adding the opening float twice. The browser error
     log was empty and no legacy POS write was issued. This completes items
     154 and 155.

400. (Runtime verified) Authenticated Vite POS created a synthetic stocked
     item through `inventory.createItem` and opened its stock through
     `inventory.adjustStock`, both returning HTTP 200 from Go. POS search showed
     12 units available at the configured sale price. No legacy inventory write
     or browser error was observed. This completes item 157.

402. (Implemented and API verified) Vite Expenses reserves actor- and
     organization-scoped retry markers under Web Locks, refuses a competing
     action while an unresolved marker exists, and clears a marker only when
     both its intent ID and action fingerprint still match. Focused API tests
     cover cross-tab reservation, delayed duplicate completion, and unavailable
     browser locks. Authenticated `agent-browser` verification in the Migration
     Verification Workspace set a synthetic `migration-proof-20261014` policy
     through `accounting.setExpensePolicy`; Go returned HTTP 200 and Vite
     reloaded the saved policy. The browser error log was empty, and no
     `POST /api/expenses` request was captured. This completes the Expenses
     browser proof.

401. (Runtime verified) Authenticated Vite POS completed a cash sale for a
     synthetic stocked item, returned the full sale to cash, and loaded the
     shift summary. Go capability requests for sale and return each returned
     HTTP 200; `POST /api/pos/shift-summary` also returned HTTP 200. The
     reloaded summary showed one sale, UGX 2,500 cash takings, and UGX 2,500
     cash refunds. No legacy `POST /api/pos` write or browser error was
     observed. This completes the current Go runtime proof for item 153.

403. (Runtime verified) Vite Payroll runs report, draft
     creation, execution, voiding, and reversal through Go's `hr.report`,
     `hr.createPayrollRun`, `hr.executePayrollRun`, `hr.voidPayrollRun`, and
     `hr.reversePayrollPosting` capabilities. Execution, void, and reversal
     require explicit confirmation; reversals require a reason. Exact pending
     attempts are scoped by actor and organization, protected by Web Locks,
     and cleared only when both intent ID and fingerprint still match. Draft
     creation is disabled when the selected period already has a run.
     Focused API and component tests cover capability contracts, validated
     outputs, pending recovery, confirmation gates, duplicate-period blocking,
     and no legacy write path. Authenticated `agent-browser` verification in
     the Migration Verification Workspace created one synthetic UGX 1,000
     employee, executed and reversed the October run with a reason, and voided
     a September draft. After reload, October showed `reversed` and September
     showed `voided`; the Accounting journal showed the payroll posting and its
     linked reversal. Lifecycle write capabilities returned HTTP 200 and no
     `/api/hr` write was observed. An accidental duplicate-period submission
     before the new guard returned HTTP 500 without creating another run; the
     UI now disables the existing October period and shows why. Go now maps
     duplicate and invalid lifecycle rejections to definite HTTP 422 results,
     with integration coverage confirming a duplicate cannot create another
     run. No browser runtime errors were observed.

404. (Implemented and API/component verified) Vite People can deactivate an
     active employee through Go's `hr.deactivateEmployee` capability after
     explicit confirmation. The directory retains the employee as inactive,
     while Go excludes deactivated employees from new payroll runs. The exact
     employee action is scoped by actor and organization, pending approval
     survives reload, and its retry marker clears only when intent ID and
     fingerprint still match. Focused API and component tests cover capability
     input/output, pending recovery, confirmation gating, and removal of the
     active action after refresh. Authenticated `agent-browser` proof on
     2026-10-14 deactivated a synthetic employee, reloaded the People page,
     and confirmed inactive status with no available action. The Go Payroll
     page then reported zero active people and disabled draft creation. The
     capability request returned HTTP 200, no legacy HR write occurred, and
     the browser reported no errors.

405. (Implemented and browser verified) Vite Sales can partially deliver
     confirmed orders by line, limited to quantities reserved by Go. The Go
     `sales.listOrders` response reports each line's quantity delivered and
     remaining deliverable balance; the Vite form validates positive
     thousandth quantities and submits them through `sales.deliverOrder` with
     actor/org scoped retry recovery. Go integration, Vite API, and Sales page
     tests cover the balance and partial-invoice flow. Authenticated
     `agent-browser` proof on 2026-10-14 created and confirmed synthetic order
     #1 with two units, delivered 1.25 units, then reloaded the page. Go
     reported 0.750 units remaining. Capability requests returned HTTP 200, no
     legacy Sales write occurred, and the browser reported no errors.

406. (Implemented and browser verified) Vite Purchasing can reverse an
     individual standalone vendor bill payment through Go's
     `purchasing.reverseVendorPayment` capability. The workspace read includes
     scoped payment IDs and run membership, the UI requires a reason and
     confirmation, and payment-run members remain reserved for whole-run
     reversal. Actor/org scoped retry recovery preserves the exact action and
     intent through pending approval or uncertain transport; strict API output
     validation and component tests cover the capability request and
     confirmation gate. Authenticated `agent-browser` proof on 2026-10-14
     created and paid synthetic bill #1 for UGX 1,000, reversed its standalone
     payment with a reason, and reloaded the Bills page. The bill reopened
     with UGX 1,000 due and the Reverse action stayed hidden. Capability
     requests returned HTTP 200, no legacy Purchasing write occurred, and the
     browser reported no errors. The Go integration test verified the linked
     journal reversal entry and persisted payment state.

407. (Fixed and API/component verified) Go standalone vendor payment reversal
     now records `reversed_at` and `reversal_entry_id` on the payment in the
     same transaction as its journal reversal and bill balance update. The
     Purchasing workspace projects the stored or journal-linked reversal
     evidence, and Vite hides the individual reversal action after refresh.
     Focused Go projection and Vite component tests cover the persisted state.
     The authenticated Purchasing proof above also verified the hidden action
     after reload.

408. (Implemented and verified: focused tests, independent review, and
     authenticated browser proof) Vite Marketplace offers Install only for
     verified listings. Existing installations remain uninstallable after a
     listing changes status, and the listing displays both its status and
     installed state. The Go install capability independently enforces
     verified status and signature validity; uninstall remains organization
     scoped. The focused Marketplace API/page tests cover a rejected
     installed listing, capability dispatch, and refreshed uninstall state.
     Authenticated browser proof installed and then uninstalled the synthetic
     `Migration Browser Proof` listing. Both capability requests returned
     HTTP 200, no legacy marketplace request occurred, and the browser error
     log was empty.

409. (Implemented and verified: focused tests, independent review, and
     authenticated browser proof) Vite Inventory now exposes Go's
     `inventory.cancelTransfer` for pending drafts with no moved stock. The UI
     requires confirmation, scopes its exact retry to the actor and
     organization, and clears stale confirmation and response state when that
     scope changes. The focused API and panel tests pass 26 cases, including a
     deferred scope-switch check. Authenticated browser proof drafted one unit
     of a synthetic transfer, cancelled it, and confirmed it disappeared from
     refreshed history. Both capability requests returned HTTP 200 and the
     browser error log was empty.

410. (Implemented and verified: focused tests, independent review, and
     authenticated browser proof) Vite Hiring now closes open roles through
     Go's `hr.closeOpening` capability. The client validates the request and
     response, retains an exact actor/org-scoped retry, and refreshes the
     hiring report after success. Focused API and page tests pass 66 cases.
     Authenticated browser proof created and closed the synthetic
     `Migration Proof Role 20261014` opening, then reloaded the Hiring tab and
     confirmed it stayed closed. Capability requests returned HTTP 200, no
     legacy HR write occurred, and the browser error log was empty.

411. (Implemented and verified: focused tests, independent review, and
     authenticated browser proof) Vite POS now accepts an explicit register
     name when opening a shift and preserves it in exact retry recovery. Go
     trims JavaScript whitespace and enforces the same 1-80 UTF-16 code-unit
     limit at the parser boundary. Focused Vite tests pass 112 cases and the
     Go parser contract test passes. Authenticated browser proof opened a
     synthetic named shift through `pos.openSession`, confirmed HTTP 200, then
     closed it with a balanced zero drawer and reopened the workspace's `main`
     register. The browser error log was empty.

412. (Implemented and verified: focused tests, independent review, and
     authenticated browser proof) Vite Sales now quick-creates catalog items
     through Go's `inventory.createItem` capability and fills the selected
     order line with the returned item's SKU, name, and price. Retry state is
     isolated from the Inventory page by actor and organization; the create
     action stays disabled when the Go inventory slice is off. Focused Sales
     and inventory-item tests pass 43 cases, with typecheck and lint passing.
     Authenticated browser proof created `MIG-SALES-20261014` through Go,
     added it to a draft, and saved order #2. Capability requests returned
     HTTP 200 and the browser error log was empty.

413. (Implemented and verified: focused tests, independent review, and
     authenticated browser proof) Vite Support now files internal requests,
     bugs, and capability-gap tickets through Go's `support.createTicket`
     capability. The client validates the Go receipt and uses actor/org-scoped
     exact intent recovery. Definitive rejections such as 403 clear the retry
     lock, while 422 stays locked because Go also uses it for intent conflicts.
     The Support API and page suites pass 73 cases. Authenticated browser proof
     filed a synthetic capability-gap ticket through Go; the capability
     request returned HTTP 200 and the browser error log was empty.

414. (Implemented and verified: focused tests and authenticated browser proof)
     Vite
     Analytics can answer revenue, receivables, and sales-pipeline questions
     through Go's authenticated `analytics.askYourBusiness` capability. Go
     validates the single `questionFocus` query, resolves the signed-in user
     and active organization, then executes the governed read capability. Vite
     validates the complete answer shape and scopes displayed results to the
     current actor and organization. Suggested actions are displayed but never
     executed by this flow. Authenticated `agent-browser` proof on 2026-10-14
     asked a revenue question and received a cited result from Go. The request
     returned HTTP 200 and the browser error log was empty.

415. (Implemented and verified: focused tests and authenticated browser proof)
     Vite People can update an employee's department and job title through Go's
     `hr.updateEmployeeStructure` capability. The UI validates the Go request
     and receipt, scopes the exact retry to actor and organization, and refreshes
     the employee report after success. A pending response offers an explicit
     exact-retry action with the same intent. HR API and page tests pass 38 and
     32 cases respectively. Authenticated `agent-browser` proof on 2026-10-14
     updated the synthetic migration employee through Go, showed the refreshed
     department and title, observed the capability request return HTTP 200,
     and recorded no browser errors or legacy `/api/hr` requests.

416. (Implemented and verified: focused tests and authenticated browser proof)
     Vite Documents now shows the stored coding suggestions for the selected
     ingested document. The full detail read remains organization-scoped through
     Go's `documents.listIngestedDocuments` capability; Vite validates each
     suggestion, including its JSON token metadata, and treats an omitted list
     as empty. API and page tests pass 27 cases, with typecheck and lint passing.
     Authenticated `agent-browser` proof created a synthetic text document,
     generated a suggestion through Go's governed capability, and reloaded the
     Vite detail view. The account suggestion appeared from Go, requests
     returned HTTP 200, and the browser error log was empty.

417. (Runtime verified) Vite Accounting now compares the
     selected budget scenario against posted actuals and open purchase
     commitments for each month through Go's authenticated
     `accounting.budgetActualVsPlan` capability. The page validates the complete
     response shape, supports month selection, and identifies posted entries in
     currencies that cannot be converted. Focused Accounting API and page tests
     cover the validated result, malformed rows, selected scenario request, and
     rendered comparison. Authenticated `agent-browser` proof created a
     synthetic budget through Go in the Migration Verification Workspace, then
     showed October plan, actual, and commitment values on Vite after reload.
     Capability reads returned HTTP 200 and browser page-error output was empty.

418. (Runtime verified) Vite Inventory can load stock
     movement history in pages of 100 through the authenticated Go inventory
     reader. Go applies an exclusive `(createdAt, id)` cursor over descending
     ledger order, probes one extra row to report whether older movements exist,
     and keeps each page organization-scoped through `inventory.itemHistory`.
     Vite validates the `hasMore` response and appends older entries without
     dropping the latest page. A Go integration test inserts a higher-ID
     movement with the same timestamp between page reads and confirms the older
     page is unchanged. Focused Go
     handler/capability and Vite API/page tests cover cursor validation and
     appended history. Authenticated browser proof loaded 100 rows, then 105
     after loading older movements; both Go cursor reads returned HTTP 200 and
     the browser reported no page errors. The local verification stock quantity
     was restored through Go after the proof.

419. (Runtime verified) Vite CRM deal creation now captures
     the lead source and assigns an organization member through Go's existing
     `crm.createDeal` capability. The Go `crm.listDeals` projection returns
     source and owner details under tenant scope, and the pipeline displays
     them after a fresh read. Owner identity is resolved only when the deal
     owner remains an organization member; a Go regression test covers stale
     nonmember owner data. Exact actor/org retry recovery retains both fields.
     Go CRM parser, creation, and list integration tests plus focused Vite CRM
     API and page tests pass. Authenticated browser proof created a deal with
     source and owner, reloaded the pipeline, and confirmed both values; Go
     capability calls returned HTTP 200 and the browser reported no errors.
420. (Runtime verified) Vite Hiring can convert an offer-stage applicant into
     an employee through Go's `hr.hireApplicant` capability. The form collects
     monthly salary in organization currency and sends integer minor units;
     exact actor/org retries preserve pending approval behavior, and hired
     applicants become read-only. Focused Go parser and Vite API/page tests
     pass. An authenticated browser proof created an opening and applicant,
     moved the applicant to offer, and hired them at UGX 1,000 monthly. Go
     capability calls returned HTTP 200 and the browser reported no errors.
421. (Runtime verified) Vite Purchasing now shows accepted, rejected, returned,
     and remaining quantity for each purchase order line from Go receipt
     history. Receipt inputs are capped at the remaining quantity and the
     action disables over-entry. The Go workspace projection integration test,
     five focused Vite suites, typecheck, and lint pass. Authenticated browser
     proof created a synthetic 2.5-unit purchase order, confirmed 2.6-unit
     receipt entry was disabled, then recorded 1.25 units and saw 1.25 accepted
     with 1.25 remaining. Go capability calls returned HTTP 200 and the browser
     reported no errors.
422. (Runtime verified) Vite Projects can delete a task through Go using the
     complete task snapshot, then restore that same task through an actor- and
     organization-scoped Undo action. The Go board read now returns the snapshot
     fields needed for a guarded restore. Focused Vite API/page tests, typecheck,
     lint, Go parser, and handler tests pass; the Go database-backed board test
     is included in the full verification run. Authenticated browser proof
     created a synthetic task, deleted it, and restored it with Undo. Go
     capability calls returned HTTP 200 and the browser reported no errors.

423. (Runtime verified) Vite Sales order rows now expand to show the Go-provided
     item descriptions and ordered, delivered, and reserved-to-deliver
     quantities. The strict Vite CRM deal schema now includes Go's nullable
     source and owner fields, fixing a 200 response that previously rendered as
     an unavailable Sales workspace. Focused Sales suites pass 47 cases;
     typecheck and lint pass. Authenticated browser proof showed the order
     disclosure values, loaded Quotes and Deals without a shape error, and
     recorded no console errors or failed requests.

424. (Runtime verified) Vite Documents can delete an ingested record through
     Go's `documents.deleteDocument` capability after explicit confirmation.
     Exact retries persist the document ID, intent, actor, and organization;
     reload recovery remains available when a response is lost, and the action
     refuses to replay under another actor or organization. Confirmation stays
     bound to the selected record. Focused tests pass 25 cases, with Vite
     typecheck and lint passing. Authenticated browser proof aborted the first
     request, recovered after reload, refused a different workspace without a
     capability call, then replayed successfully in the original workspace.

425. (Runtime verified) Vite Accounting now matches bank statement lines to
     exact remaining payments or whole posted journal entries through Go. Go
     projects org-scoped balances; Vite filters by signed amount and currency,
     refreshes before dispatch, and rejects stale candidates. Partial payment
     matching sends the exact remaining amount. Focused Banking Vite tests pass
     201 cases, the Go workspace integration test and Vite typecheck/lint pass.
     An authenticated browser proof paid a synthetic UGX 6,000 invoice, imported
     a matching bank line, matched it to the journal entry, and confirmed the
     line remained matched after reload. No console errors or failed requests
     were recorded.

426. (Runtime verified) Vite Support can insert an organization-scoped canned
     reply into an inbox composer using Go's existing `support.listLibrary`
     capability. Insertion preserves the editable draft and never sends; it is
     disabled while the message is marked as customer-authored. An open picker
     reloads when organization scope changes and exposes retry on read failure.
     The focused Support suite passes 23 cases, with typecheck and lint passing.
     Authenticated browser proof created a synthetic response and conversation,
     inserted the text into the composer, left Send untouched, saw successful Go
     capability requests, and recorded no browser errors.

427. (Runtime verified) Vite Manufacturing can undo and redo a BOM deletion
     through Go's snapshot-guarded `manufacturing.restoreBom` capability. Each
     successful restore supplies the next expected snapshot, and the action
     label tracks Undo and Redo across repeated changes. Focused tests pass 96
     cases with typecheck and lint passing. Authenticated browser proof verified
     the Go writes and repeated undo/redo behavior with no browser errors.

428. (Runtime verified) Vite CRM's customer profile shortcut opens the Go-backed
     follow-up form with the customer and generated title while clearing an
     unrelated task draft's due date, assignee, and note. The focused UI test
     verifies every field. Authenticated browser proof exercised the shortcut
     against Go reads and confirmed all three unrelated fields were cleared;
     capability writes returned 200 and the browser reported no errors.

429. (Runtime verified) Vite Hiring opening creation captures optional
     department and role notes through Go's existing `hr.createOpening`
     capability, preserves both values through exact pending-approval retry,
     and displays them from the refreshed Go report. Focused HR tests pass 71
     cases, with typecheck and lint passing. Authenticated browser proof created
     an opening, reloaded the page, and confirmed both details persisted; the
     browser reported no errors.

430. (Runtime verified) Vite Purchasing keeps receipt drafts bound to the
     selected order while Go history requests race or retry. Touched accepted,
     rejected, and reason fields survive an active history refresh; untouched
     fields use refreshed Go quantities. Focused Purchasing tests pass 72
     cases, with Vite typecheck and lint passing. Authenticated browser proof
     delayed the Go receipt-history response, entered a receipt quantity, then
     confirmed the quantity remained after the response completed. No receipt
     was submitted and the browser reported no errors.

431. (Runtime verified) Vite Documents lists Go-backed reusable templates and
     creates a new draft from the selected template content. Go and Vite enforce
     the same ProseMirror structure and canonical JSON byte, depth, value, and
     node limits. Focused Vite tests pass 87 cases, and the Go capability
     package passes. Authenticated browser proof selected a template, confirmed
     its content in the new draft after reload, and recorded successful Go
     capability requests with no browser errors.

432. (Runtime verified) Vite Analytics compares customer or product revenue
     across two inclusive date ranges through the session-authenticated Go
     `analytics.explainChange` route. The page shows period totals, movement,
     contributions, and invoice drill IDs when activity exists. Focused
     Analytics tests pass 23 cases, with Vite typecheck/lint and focused Go
     handler/parser checks passing. Authenticated browser proof received HTTP
     200 from Go and rendered the zero-activity empty state for the selected
     dates; the browser reported no errors.

433. (Runtime verified) Vite CRM edits open task titles and notes through the
     Go `crm.updateTaskDetails` capability, reads the stored note from Go, and
     restores title, note, due date, and assignee from the complete inverse
     snapshot. Focused CRM API/page tests pass 124 cases, with typecheck, lint,
     and the Go task integration test passing. Authenticated browser proof
     created and edited a synthetic task, reloaded it, and confirmed the title
     and note persisted through Go; no browser errors were reported.

434. (Runtime verified) Vite Sales edits notes and line descriptions,
     quantities, prices, tax, and SKU on draft orders through the Go
     `sales.updateDraftOrder` capability. Go locks and checks draft status,
     scopes the write to the organization, and enforces Vite's 4,000 UTF-16
     unit note limit. Focused Sales API/page tests pass 65 cases, with Vite
     typecheck/lint and Go parser/update database tests passing. Authenticated
     browser proof changed a synthetic draft, reloaded it, and confirmed the
     updated note, line values, and total persisted; Go returned HTTP 200 and
     the browser reported no errors.

435. (Runtime verified) Go owns the session-authenticated GET and POST routes
     for accounting budgets, banking, and time entries, and Vite proxies those
     paths directly to Go. Budget undo validates its scenario ID before
     capability dispatch, and all state-changing requests require a caller
     supplied idempotency intent ID. Focused Go HTTP and router tests pass with
     vet enabled, Vite proxy tests pass, and route ownership checks pass at
     94 files, 162 methods (72 Go, 88 legacy, 2 auth), and 30 pages.
     Authenticated agent-browser proof
     used local SMTP email verification and returned HTTP 200 from all three
     Go routes; the browser reported no errors.

436. (Runtime verified) Go owns the session-authenticated expenses, Accounting
     tax, and period close routes, and Vite proxies those paths directly to Go.
     Writes use the governed capability executor and require client intent IDs.
     Tax report reads use request-scoped receipt IDs. Response contracts
     validate required fields and period readiness before returning success.
     Focused Go handler, router, and Vite proxy tests pass, and route ownership checks pass at
     94 files, 162 methods (78 Go, 82 legacy, 2 auth), and 30 pages.
     Authenticated agent-browser proof
     verifies the routes through the Vite proxy with no browser errors.

437. (Runtime verified) Go now owns
     Vite's Accounting and HR collection reads/actions, Marketing reads/actions,
     and POS collection writes. Writes resolve the Go session, enforce same
     origin for cookie requests, validate exact request/output contracts, and
     execute through the governed capability pipeline. Review added strict
     Accounting unknown-field rejection and the missing HR payroll reversal
     action. Focused Go handler/router tests, Vite proxy tests, the full
     TypeScript gate, and `pnpm go:verify` pass. The live Vite and Go endpoints
     both returned 401 without a session, confirming the proxy and auth boundary.
     Authenticated agent-browser proof loaded Accounting and HR, created a
     Marketing segment, and opened a POS register through Go with successful
     responses and no browser errors. No legacy API requests were used.
     Route ownership checks pass at 94 files, 162 methods (85 Go, 75 legacy,
     2 auth), and 30 pages.

438. (Ownership verified) Active Vite's `/api/health` request reaches Go's
     health handler, and `/api/docs/assist` reaches the session-authenticated
     Go Documents assistant. Both endpoints already had Vite proxy rules and
     Go handlers with focused tests; their generated ownership records now
     match that runtime. Route ownership checks pass at 94 files, 162 methods
     (87 Go, 73 legacy, 2 auth), and 30 pages.

439. (Runtime verified) Support quick-create now
     submits `crm.createCustomer` through Go's session capability API even when
     the obsolete client rollout selector is false. Go still resolves the
     session and organization, enforces `crm.write` and policy approval, and
     returns validated output; errors do not fall back to a legacy endpoint.
     The 58 focused Support API tests, targeted lint, and an independent
     authorization-path review pass. Authenticated agent-browser proof created
     a synthetic customer from the New support conversation flow. The Go
     `crm.createCustomer` capability request returned HTTP 200, the new
     customer appeared in the selector, and the browser reported no errors.

440. (Contract verified) Vite Sales now strictly validates the Go create-order,
     deliver-order, and cancel-order response shapes. Malformed success payloads
     fail closed and retain the scoped retry marker, avoiding a duplicate write
     after an uncertain response. The focused Sales API suite passes 38 tests,
     and independent review confirmed each schema matches its Go output struct.

441. (Contract verified) Vite Accounting now validates the exact Go module
     switchboard shape across its ledger, invoice, and period-close readers.
     Unknown or missing catalog and top-level fields fail closed. Invoice
     creation retains its actor and organization scoped retry marker when a
     successful HTTP response violates the exact Go output contract. The
     focused Accounting API suites pass 155 tests, targeted lint passes, and
     independent review confirmed the response shapes and retry behavior.

442. (Contract verified) Vite Inventory now strictly validates cycle-count
     success and pending-approval responses against Go. Recorded line counts
     are constrained to Go's 500-entry input limit, while malformed responses
     preserve the original retry intent. Focused API and component tests pass
     21 cases, and independent review confirmed output bounds and retry
     behavior against the Go executor.

443. (Contract verified) Vite Purchasing strictly validates Go vendor rows and
     AP aging buckets, including required bucket totals. Unknown fields and
     incomplete aging payloads fail closed. The focused Purchasing API suite
     passes 62 tests, and independent review confirmed the schemas match Go's
     workspace response types.

444. (Typecheck verified) Vite Sales now narrows recovered order writes by
     action before reading delivery-only fields. This fixes the strict TypeScript
     error in the success-message branch without changing the action result.

445. (Contract verified) Vite Support and Dashboard now reject malformed Go
     response identifiers, unsupported enum values, and undeclared fields.
     Support retains and reuses its original intent after malformed successful
     write receipts. Focused Support and Dashboard tests pass 70 cases, targeted
     lint and the Vite package typecheck pass, and independent review found no
     contract or retry regressions.

446. (Contract verified) Vite Analytics now validates the Go dataset, preview,
     and report response contracts and recursively rejects unsafe integer
     values in nested result rows before JavaScript can round int64 money or
     quantities. Documents API response contracts remain strict and match Go.
     Focused Documents and Analytics tests pass 98 cases, targeted lint passes,
     and an independent review verified the numeric precision guard.

447. (Contract verified) Vite Auth now accepts Go's browser sign-in envelope
     while rejecting unexpected session token fields. Organizations require
     Go's baseCurrency field, Team writes validate action-specific outputs, and
     Settings reject malformed policy approval values. The focused suites pass
     68 tests, targeted lint and Vite typecheck pass, and independent review
     confirmed the client shapes match the Go handlers.

448. (Contract verified) Vite Sales quotes, Products, and invoice printing
     validate Go's nullable fields and action-specific receipts. Malformed
     write responses preserve retry identity. Focused suites, targeted lint,
     Vite typecheck, and independent contract review pass.

449. (Contract verified) Vite Projects returns separately typed Go and legacy
     action receipts. Consumers can rely on Go-required fields only after
     narrowing by backend, while legacy receipt fields remain optional. Focused
     Projects, Approvals, portal, and widget suites pass 44 tests; lint,
     typecheck, and independent review pass.

450. (Contract and UI verified) Go's Vite Inventory projection now includes
     each lot's integer balance, and the strict client contract validates it.
     The page renders populated and zero balances. Eight focused UI and API
     suites pass 75 tests, the Go handler test and Vite typecheck pass, and
     independent review found no contract mismatch.

451. (CI gate added) Required CI now runs `pnpm verify:vite-go` to build the
     active Vite app and run Go tests and vet, alongside migration-era
     typecheck, lint, test, route/action/capability/contract census, database
     continuity, and live business proof checks. These broader checks remain
     required while their Go replacements are pending. CI no longer requires a
     Next.js production build.

452. (Boundary verified) Go workspace onboarding now rejects undeclared top-
     level fields, unsupported or repeated deferred setup steps, and step lists
     larger than the supported set before workspace bootstrap. Vite validates
     the same step contract before sending. Focused Go and Vite tests pass, Vite
     typecheck passes, and independent review confirmed session, organization,
     and field boundaries. An active Vite audit found its Settings, onboarding,
     public widget, portal, Dashboard, and agent requests already route through
     Go; no duplicate endpoints were added. Widget and Dashboard Go routing
     setup guidance was corrected.

453. (Runtime verified) Vite Go marketing campaign email rows now
     have a dedicated Go SMTP worker, database role, and
     `claim_marketing_email` function. Claims require `kind=email` and the
     `marketing:` prefix; delivery rechecks current customer email, opt-out,
     and active status under `dbx.WithOrgTx`, then acknowledges through the
     existing lease fence. Database-backed proof verifies role isolation,
     blocked non-marketing payload reads, consent enforcement, and successful
     eligible delivery. A separate opt-in SMTP sink test sent a message through
     the running local SMTP server with its local CA certificate and verified
     the captured headers, stable Message-ID, and body. The TypeScript
     dispatcher remains in source for Next compatibility producers; this does
     not claim that the wider TypeScript worker is retired. Independent review
     found no remaining authorization or fencing issue.

454. (Security fix) Go Messaging presence reads require `messaging.read` and
     an enabled Messaging module.
     Documents editor workspace reads require `documents.read` and all
     workspace operations require `documents.write` and an enabled Documents
     module. The Go document assistant requires
     `documents.read` for document chat and template prefill, and
     `documents.write` for selection editing and continuation. Permission and
     module denials happen before workspace database access, assistant data
     reads, or model calls. Focused verification is recorded with this change.

455. (Tenant-scope fix, runtime verified) Vite CRM now requires a valid
     organization ID for every Go request and forces it into the request header.
     CRM hides and clears old-scope rows, views, profiles, timelines, and drafts
     while the next organization loads; failed collection reads do not retain
     previous-scope data. The focused API and page suites pass 127 tests, Vite
     typecheck and focused lint pass, and an authenticated agent-browser load
     returned four Go capability reads with HTTP 200 and no console or page
     errors. The component suite covers populated-data switches and in-flight
     writes across organization changes.

456. (Worker port, independently reviewed) Go now delivers queued approval
     notification emails through a dedicated SMTP worker and notification-only
     database role. Claims are limited to approval email jobs; payload reads,
     lease renewal, and acknowledgements are organization-scoped and fenced.
     The migration and role provisioning succeeded locally, and the database
     integration proved delivery, stored receipt, and isolation from another
     email class. Notification role tests passed. The dispatcher rerun and
     delivery through the local SMTP sink remain unverified because Docker Go
     compilation stalled while host swap was exhausted. Independent review
     found no authorization or fencing issues.

457. (Port and runtime verified) Vite Event Ledger now loads history in
     100-entry pages from Go. The Go
     session route accepts a positive sequence cursor and reads only events
     before that cursor inside the resolved organization's transaction. The
     page fetches one lookahead row to show the older-events control only when
     more history is available, and its search spans every loaded page. Focused
     Go handler, ledger reader, Vite API, and Vite page checks cover cursor
     validation, tenant scope, ordering, and continued search behavior. Vite
     typecheck and targeted lint pass, and the App organization-switch test
     passes with the updated 101-event request. An authenticated agent-browser
     proof loaded 100 descending events, fetched 53 older events through Go,
     and showed 153 unique descending rows with no page, console, alert, or
     request errors.

458. (Runtime verified) Vite People can clock active employees in and out
     through Go's `hr.clockIn` and `hr.clockOut` capabilities. Go scopes employee
     and attendance access to the active organization and enforces `hr.write`.
     Focused API and page suites pass 73 tests, Vite typecheck and targeted lint
     pass, and independent review found no authorization or retry issue. An
     authenticated browser proof hired one synthetic employee, clocked in and
     out through Go, reloaded to confirm the clocked-out state, rejected the
     resulting test time entry, and deactivated the employee. All requests
     returned HTTP 200 with no page or console errors; the inactive employee's
     historical record remains because the UI has no delete workflow.

459. (Runtime verified) Vite Manufacturing now loads the nested bill-of-
     materials tree from Go and displays scaled quantities and each component's
     scrap percentage for one assembly. Focused Vite API and page suites pass
     97 tests, with Vite typecheck and targeted lint passing. The Go database
     lifecycle/tree test and checked-scaling boundary tests pass, and
     independent review confirms the overflow guard remains inside both the
     int64 and JavaScript safe-integer limits. Authenticated browser proof
     defined a two-level synthetic BOM through Vite, loaded it through Go, and
     displayed leg quantity 4.000 with 20.0% scrap and nested foot quantity
     8.000 with 10.0% scrap; the request returned HTTP 200 with no page errors.
     Both synthetic BOMs were deleted and all three zero-stock test products
     were archived through the UI; a tenant-scoped read confirmed no BOM lines
     remain and all exact QA items are archived.

460. (Route ownership census) Mark onboarding GET and PATCH as Go-owned and
     verified after the authenticated Vite proof in item 312 confirmed the
     state read, update, follow-up read, and absence of legacy requests. The
     other reviewed routes already have ownership entries and supporting
     focused or runtime proof. Inventory POST remains legacy-owned because
     active Vite uses capability endpoints for inventory writes and has no
     caller for the legacy POST route. The generated census now records 94
     route files, 162 API methods (89 Go, 71 legacy, 2 auth), and 30 Vite
     pages; the earlier count in item 438 is historical.

461. (Runtime verified) Vite CRM Overview reads
     full organization-scoped deal-stage counts and totals through the existing
     Go `crm.pipelineReport` capability. The board, table, and search continue
     to use the existing 200-row `crm.listDeals` collection. Vite strictly
     validates the aggregate response, hides the prior organization's report
     while loading, and shows unavailable values instead of stale totals after
     an invalid response. The CRM API and page suites pass 133 tests, Vite
     typecheck and targeted lint pass, and authenticated `agent-browser` opened
     `/crm` in the Migration Proof Outfit organization. Its `crm.pipelineReport`
     POST returned HTTP 200 through Go with all six stage rows and zero totals,
     which matched the rendered Overview; all four CRM collection calls
     returned 200 with the active organization header and no page errors.

462. (Runtime and interleaving verified) Vite CRM collection loads use
     a monotonically increasing request generation and current organization
     scope guard. Late refresh, retry, and import-completion responses cannot
     overwrite data loaded for a newer organization. The focused page suite
     covers both an old refresh completing after a new organization load and a
     stale import completion attempting to start a load while the new one is
     pending.

463. (Focused verified) Go AI provider settings count request limits in
     JavaScript-compatible UTF-16 units. The encrypted-key bound is 4043
     characters in both Go capability and shared Zod storage validation,
     matching the maximum encoding of 1000 UTF-16-unit plaintext. Focused
     handler tests post a maximum CJK key, pass the encrypted configuration
     through the capability parser, and decrypt it back to the original value.

464. (Focused verified) Vite Approvals now reads and submits through Go's
     session-owned routes with explicit organization scope, strict response
     validation, and stale-load suppression. Completed decisions leave the
     actionable inbox immediately, including when the refresh read fails, and
     follow-on approvals are not reported as executed. Vite Dashboard keeps
     work queue failures visible instead of presenting a false empty state.

465. (Focused verified) Go routine and public support consumers validate
     stored AI configuration through the bounded parser and reject malformed
     or oversized organization settings before using provider credentials.
     Focused worker and public support parser tests pass in Docker.

466. (Vite/Go route verified) Vite Settings AI configuration GET and POST are
     Go-owned with no legacy selector or fallback. The authenticated Settings
     page loaded its provider configuration through `/api/ai-config` with HTTP
     200 and no browser errors. Proxy tests prove the former opt-out value still
     reaches Go when the fallback points to a distinct legacy server; Go router
     tests keep unsupported methods and nested paths out of that fallback. The
     route manifest and its ownership tests now agree that both methods are
     verified Go routes. The census is 94 API files, 162 methods (91 Go, 69
     legacy, 2 auth), and 30 Vite pages.

467. (Go durable-run producer and worker verified) Go now accepts authenticated
     durable-run creation requests, persists pinned composition and actor
     identity in a tenant-scoped transaction, and dispatches sequential governed
     steps through the existing jobs worker. The runtime-role integration proof
     creates and processes a two-step run, verifies approval linkage, and checks
     that the run and approval reach their completed states. The migration
     runner applied migration 0140, but could not take its requested pre-change
     `pg_dump` snapshot because the binary is unavailable in the migration
     environment.

468. (Focused verified) Go routines now expose all seven legacy
     `manufacturing.read` capabilities that already have Go system executors:
     production runs, work-order lists, BOM trees, cost previews, lot tracing,
     production feasibility, and BOM reports. The Go-only overview report is
     excluded from the legacy routine contract. Unit tests verify sanitized tool
     names, capability dispatch, read-only permission mapping, required fields,
     bounds, defaults, and parser rejection of invalid values. A new
     database-backed system-actor and tenant-isolation proof remains pending
     PostgreSQL recovery.

469. (Focused verified) Go now owns SSO connection management at
     `/api/team/sso`. Listing resolves the Go session and uses organization RLS;
     creation, disablement, and restoration resolve the Go session, require
     `iam.admin`, and execute through audited, reversible capabilities. The Go
     route rejects unsafe URL credentials and malformed hostnames, excludes
     public signing certificates from list responses, and blocks cookie-based
     writes without a same-origin request. Handler and capability tests pass;
     runtime-role tenant isolation and governed-write integration proofs remain
     pending PostgreSQL verification.

470. (Focused verified) The public business OpenAPI contract now describes all
     four `/api/org` methods, including cookie-session requirements, active
     organization selection, same-origin switching and persona writes,
     membership and `iam.admin` checks, body limits, no-store caching, and
     error responses. Go handlers and Vite organization/settings clients
     consume generated types while retaining strict runtime validation.
     Resolver infrastructure failures are logged and return a generic 500;
     missing sessions remain 401 and short secrets remain 503.

471. (Focused verified) The public business OpenAPI contract now describes
     Go GET and POST `/api/notifications`, including cookie and bearer auth,
     org selection, GET cache behavior and limit coercion, strict bounded
     mark-read input, and governed success/refusal/not-found results. Go
     handlers and the Vite client consume generated models while retaining
     runtime validation. The exact-path mount preserves per-method flag
     fallback and returns 405 with the configured `Allow` methods for other
     methods once either Go method owns the path.

472. (Focused verified) The public business OpenAPI contract now describes
     Go GET and POST `/api/team`, including action-discriminated role, grant,
     assignment, and invitation inputs and results. Go handlers and the Vite
     client consume generated models while retaining runtime validation. The
     exact-path mount returns 405 with the configured `Allow` methods for
     unsupported methods and preserves feature-flag fallback for disabled
     GET/POST methods.

473. (Focused verified) The public business OpenAPI contract now describes
     Go GET `/api/setup`, including cookie and bearer auth, active-organization
     selection, the `iam.admin` gate, ignored query/body inputs, cache headers,
     and the checklist response. Go and Vite use generated response models;
     Vite retains safe-local-path and safe-integer runtime validation while
     allowing fixture and future checklist lengths. The enabled Go mount owns
     the exact path, returns 405 with `Allow: GET` for other methods, and keeps
     suffix paths on the base router.
