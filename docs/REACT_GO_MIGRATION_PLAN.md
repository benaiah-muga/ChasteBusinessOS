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
changing the route-ownership manifest. Organization switching now has a
separate `go.org.switch` assertion and `GO_ORG_SWITCH=1` opt-in. Go verifies
membership using the runtime database role and issues the existing HttpOnly
active-organization cookie; the public `/api/org` method remains legacy-owned
by default. A parallel React 19 and Vite client now builds as static assets and
proxies the Go health check in development.
API-method, page, server-action, live capability, and exported database-table
manifests are checked in and CI verifies them against the current source and
runtime registry.
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
switches through the existing `/api/org` route, which remains legacy-owned and
continues to validate membership and set the HttpOnly cookie. Vite listens on
`localhost` so the browser can send the existing host-scoped session cookie
across the port change. `CHASTE_LEGACY_WEB_ORIGIN` configures the development
proxy when the legacy server is not on `http://localhost:3001`.
The current application
continues to own production traffic, and no writes have changed owner.
The Vite `/approvals` preview now reads the legacy pending queue and decision
history and submits decisions through the same governed legacy endpoint by
default. `GO_APPROVAL_DECISION=1` opts POST decisions into the signed Go
service using the exact organization-scoped payload stored with the approval;
unknown outcomes fail closed and require a queue refresh. GET queue/history
and production route ownership remain unchanged. The UI refreshes after
organization changes and redacts credential-shaped fields in previews.

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
database-backed parity tests. The legacy TypeScript worker remains the default
runtime owner. A separate Go capability-jobs worker now claims only its
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
open because other legacy routine tools do not yet have Go model input schemas.
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
assignee lookup. Analytics component and API tests pass; its browser runtime
proof remains open while the in-app browser is unavailable in this IDE session.
Direct `/analytics` visits render the Vite `AnalyticsPage`, and the ownership
manifest records that page as Vite-owned alongside its verified Go API routes.

Sessions
preserve the existing selection, event sequence, replay, durable-run, and
metrics response contracts. Projects preserve module availability, board and
task ordering, governed writes, archive confirmation, and `202` approval
notices. Both use existing legacy APIs and retain legacy production route
ownership. Projects component, API, shell, typecheck, build, and lint tests
pass; its requested in-app browser proof remains open because no in-app browser
connection is exposed in the current environment.

Go now implements all five Projects write capabilities through the existing
governed executor. DB-backed proofs cover input parser parity, module and grant
checks, verified-session and tenant scope, approval payload replay, audit
rollback, and durable receipts. The public `POST /api/projects` bridge is
available behind `GO_PROJECTS_WRITE=1`. It preserves legacy response shapes
and fails closed on uncertain outcomes. The flag defaults off, while
`GET /api/projects` now has an independent `GO_PROJECTS_READ=1` opt-in for the
Go collection and board readers. The collection reader keeps its legacy
no-audit behavior; the board continues through the audited capability. The
development shadow flag compares collection reads only, because shadowing the
board would append an extra capability audit event. All flags default off and
the public route remains legacy-owned pending the remaining browser parity
gates.

Go CRM read parity covers the timeline and task query modes through an
explicit signed opt-in; CRM writes and unported read modes remain on the
legacy route. The Go metrics reader matches the newest-200-session aggregate,
null-rate, rounding, and organization-scope behavior. Its short-lived signed
HTTP adapter is opt-in through `GO_METRICS_READ=1`; the public route remains
legacy-owned by default. The current route census has 94 API route files, 158
methods, and 30 pages. Seven API methods are Go-owned, 151 remain legacy-owned,
and `/analytics` is the only Vite-owned page; the other 29 pages remain
legacy-owned.

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
The current manifest records seven Go-owned API methods and the Vite-owned
`/analytics` page, with the remaining API methods and pages assigned to legacy.

Local verification on 2026-10-04 passed `pnpm typecheck`, `pnpm lint`,
`pnpm test`, and `pnpm go:verify` with `GO_DATABASE_URL` set to the
least-privilege runtime role. The verified local demo set includes the Go
slice, M2-M13, M4b, and support. The Dashboard, Projects, and Analytics
in-app-browser gates remain open. The `/analytics` page and its verified Go API
methods are Vite- and Go-owned; remaining routes retain their recorded owners
until their parity and cutover gates pass.

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
production durable-run dispatcher or outbox reconciliation endpoint was found;
and async OCR has no successful worker proof. These are recorded in the
integration and worker inventories. Preserve current behavior only after the
owner accepts a documented risk or defines a versioned correction, then add
the resulting decision to the applicable parity gate.

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
   Go capability       Go auth after parity proof
   kernel, modules      (temporary Better Auth bridge during port)
        |                 |
        +--------+--------+
                 |
           PostgreSQL + pgvector

Go worker: jobs + outbox + routines + durable agent runs -> same Go kernel
```

Use one origin for browser requests so cookie scope and relative `/api/*` calls
stay stable. A route ownership manifest is consumed by the local dev proxy and
the production ingress. While migration is underway, it assigns each UI path
to either the legacy app or Vite, each business API path to either its legacy
handler or Go, and `/api/auth/*` to the auth owner:

```text
/api/auth/*                 -> Better Auth bridge, then Go after auth parity
/api/* owner=go             -> Go business API
/api/* owner=legacy         -> legacy API handler until its Go port passes
UI path owner=vite           -> Vite-built React app served as static assets
UI path owner=legacy         -> legacy app until that page is ported
```

Vite proxies by this manifest in development. In production, the ingress
serves Vite assets and forwards only legacy-owned paths to the old app. Every
route and capability has exactly one owner at a time. Legacy handlers may
continue to serve unported work, but they never shadow a Go write or create a
second audit path. Once no business API or UI path remains legacy-owned, the
old app can be removed after the auth owner also changes to Go.

Initially, the existing auth catch-all remains the owner for `/api/auth/*`.
After other routes move, host the same Better Auth configuration as an
auth-only bridge, or keep its current adapter until standalone hosting is
proven. The bridge is the session authority while Go reproduces session
resolution, verified-email binding, active-organization selection, and RBAC.
Go asks the bridge to validate the original request cookies; the bridge
returns only the verified identity and session facts Go needs. Sign-in,
verification, and recovery continue through the bridge during this period.
The final Go auth cutover requires evidence that existing password hashes,
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
4. (Done) Define the versioned HTTP contract and auth bridge contract, and
  prove Go read-only policy and ledger endpoints under existing session,
  permission, and RLS policies. OpenAPI 3.1 covers `GET /__go/policy` and
  `GET /__go/ledger`; audience-specific signed assertion claims are specified
  for the Go bridge. `pnpm migration:contracts:check` verifies generated Go
  and TypeScript models, and `TestGoReadOnlyHandlersEnforcePermissionsAndTenantRLS`
  exercises both reads through the least-privilege runtime role.
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
    Focused API and component tests pass. Keep API and page ownership on the
    existing defaults until runtime and parity proofs pass; browser proof
    remains deferred by user direction.
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
136. (Implemented; runtime proof pending for Vite order confirmation) Add one
     Sales action to the Vite page: confirm draft orders through the existing
     session-authenticated `sales.confirmOrder` capability. The API validates
     the order id and response, preserves pending approval, and reuses an intent
     id after uncertain transport outcomes. Other Sales actions and route
     ownership remain unchanged. Focused Vite API and page tests cover the
     capability request, approval response, and visible confirmed state. The
     authenticated browser and database-backed confirmation proofs remain open.
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
140. (Implemented; exact GET Go-owned, report POST legacy-owned) Go serves
     session-authenticated analytics dataset discovery and previews through
     exact `GET /api/analytics`. The Vite selector and Go mount are enabled by
     default and accept `=0` opt-outs; report `POST /api/analytics` and
     unsupported methods and paths continue to legacy. Focused handler and
     real Vite middleware tests pass, and ownership is recorded per method in
     the route manifest. The Analytics in-app browser proof remains open as a
     separate runtime gate.
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
     tests pass. Runtime proof and route ownership remain open.
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
     remains open.
147. (Implemented; Vite sends use Go by default) Promote eligible conversation
     sends through the existing session-authenticated `/api/capabilities/execute`
     route to `messaging.sendMessage`. Go rechecks conversation membership and
     attachment ownership under organization RLS, records mentions in the same
     transaction, and returns the message ID used by the declared
     `messaging.deleteMessage` inverse. Stable retry intents and pending
     approvals remain supported. Agent-enabled conversations and @agent
     messages stay on legacy until Go workmate replies are supported. The
     Vite flag is enabled by default and remains paired with the Go session
     capability route. Focused Vite API and Messages page tests plus Go
     capability tests pass; authenticated browser proof remains open.
