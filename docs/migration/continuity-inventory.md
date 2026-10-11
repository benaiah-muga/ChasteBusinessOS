# Data, identity, governance, and proof continuity inventory

Status: Phase 0 source inventory. The Next.js application still owns
production requests and writes. No production traffic has moved to Go.

## Database and stored business data

- [`data-tables.json`](data-tables.json) is generated from
  [`packages/db/src/schema/index.ts`](../../packages/db/src/schema/index.ts)
  and records all 133 exported Drizzle tables with their source line. CI runs
  `pnpm migration:data:check` to catch source drift.
- Existing SQL history remains under `packages/db/drizzle/`. The runtime move
  does not require a database copy or schema rewrite. Continue using the same
  PostgreSQL database and rows, including Better Auth, business, audit, agent,
  worker, receipt, and integration records.
- Tenant reads and writes in the current web runtime use
  `withOrgContext`, which sets `app.org_id` transaction-locally
  ([`client.ts#L35-L56`](../../packages/db/src/client.ts#L35-L56)). Go's
  `WithOrgTx` rejects an empty organization, sets the same transaction-local
  setting, and commits only after the action succeeds
  ([`org_tx.go#L16-L40`](../../apps/api/internal/dbx/org_tx.go#L16-L40)).
  Go startup also rejects any role other than `chaste_app`, a superuser, an
  RLS bypass role, or a role with memberships
  ([`runtime_role.go#L16-L43`](../../apps/api/internal/dbx/runtime_role.go#L16-L43)).
- High-risk stored invariants include the hash-linked `ledger_events`,
  `approvals` payload and status, `action_receipts` intent and input hash,
  agent `session_events`, version-pinned `agent_run_steps`, worker leases and
  fencing tokens, routine occurrences, and outbox dedupe keys. Their table
  declarations are in `packages/db/src/schema/index.ts` at the corresponding
  exported declarations; the generated manifest gives every table's exact
  declaration line.

## Authentication, identity, and active organization

- Better Auth uses the existing Drizzle tables through its PostgreSQL adapter
  ([`auth.ts#L8-L11`](../../apps/web/src/server/auth.ts#L8-L11)). The stored
  tables are `auth_user`, `auth_session`, `auth_account`, and
  `auth_verification`; account passwords and session tokens remain in the same
  database rows ([`schema/index.ts#L2617-L2668`](../../packages/db/src/schema/index.ts#L2617-L2668)).
- Email and password sign-in requires verified email, sessions last seven
  days, credential endpoints have explicit rate limits, and sign-up avoids
  account-enumeration responses ([`auth.ts#L12-L47`](../../apps/web/src/server/auth.ts#L12-L47)).
  A Go auth cutover must prove an existing password account can sign in and an
  existing session cookie remains valid. Do not rehash passwords, delete
  sessions, or require a password reset as a migration shortcut.
- Session resolution looks up the authenticated email, denies memberships and
  permissions to unverified email identities, validates the active-org cookie
  against the user's current memberships, then resolves permissions in that
  organization ([`session.ts#L26-L68`](../../apps/web/src/server/session.ts#L26-L68),
  [`kernel.ts#L489-L585`](../../apps/web/src/server/kernel.ts#L489-L585)).
  Preserve multi-organization switching and the current permission result.
- The organization GET and POST now enforce that verified-email boundary
  before querying memberships. An unverified session receives an empty org list
  and cannot set the active-org cookie; route regression tests cover both
  methods ([`route.ts#L10-L22`](../../apps/web/src/app/api/org/route.ts#L10-L22),
  [`route.ts#L27-L35`](../../apps/web/src/app/api/org/route.ts#L27-L35),
  [`org-route.test.ts#L1-L175`](../../apps/web/src/server/org-route.test.ts#L1-L175)).
- The signed Go bridge now supports policy reads, ledger reads, and an opt-in
  organization membership switch. The switch assertion binds the verified
  user and requested org; Go rechecks membership in an org-scoped transaction
  under the runtime role before returning the existing active-org cookie. The
  public route stays legacy-owned unless `GO_ORG_SWITCH=1`; the auth catch-all
  remains Next-owned, and Go does not yet validate browser sessions or own
  sign-in, verification, recovery, or session refresh
  ([`route.ts#L29-L109`](../../apps/web/src/app/api/org/route.ts#L29-L109),
  [`go-bridge.ts#L52-L73`](../../apps/web/src/server/go-bridge.ts#L52-L73),
  [`org_switch.go#L32-L85`](../../apps/api/internal/httpapi/org_switch.go#L32-L85),
  [`membership.go#L22-L32`](../../apps/api/internal/orgswitch/membership.go#L22-L32),
  [`route-ownership-overrides.json`](route-ownership-overrides.json)). Policy
  reads remain explicitly opt-in through their own flags
  ([`route.ts#L26-L75`](../../apps/web/src/app/api/policy/route.ts#L26-L75),
  [`route.ts#L101-L130`](../../apps/web/src/app/api/policy/route.ts#L101-L130)).
- The Vite invoice print page requests its invoice through Go's direct
  Better Auth session handler at exact `GET /api/sales/{orderId}`. Go scopes
  order, lines, customer, organization, and branding reads through
  `dbx.WithOrgTx`; the runtime integration proof checks tenant rows and hides
  unscoped and foreign-organization invoices. Vite sends only that exact GET
  shape to Go; other methods, trailing slashes, and suffix paths retain their
  existing owner. `GO_SALES_INVOICE_ROUTE=0` unmounts the Go handler.

## Vite Go route cutovers

- Vite Support channel settings use exact `GET` and `POST /api/support/channels`
  requests. Both route directly to Go regardless of the former Vite selectors;
  the Go handler mounts by default, and `GO_SUPPORT_CHANNELS_ROUTE=0` unmounts
  it, causing the Vite requests to fail closed. Other methods and extra paths
  retain their existing owner. The Go handler resolves Better Auth sessions,
  validates verified organization membership and Support module access, checks
  same-origin writes and `iam.admin`, and uses organization-scoped transactions
  for settings reads and writes. Handler tests cover response privacy and
  validation, but currently use a fake store; there is no runtime-role database
  upsert proof. See [`support_channels.go`](../../apps/api/internal/httpapi/support_channels.go),
  [`support.ts`](../../apps/web-vite/src/api/support.ts), and
  [`go-route-proxy.test.ts`](../../apps/web-vite/src/api/go-route-proxy.test.ts).
- Vite inventory catalog reads and SKU history queries use exact `GET
  /api/inventory` requests. Both route directly to Go regardless of the former
  Vite selector; `GO_INVENTORY_READ_ROUTE=0` unmounts the handler and requests
  fail closed. Inventory POSTs and nested paths keep their current owner. The
  Go session handler checks verified identity, active organization,
  `inventory.read`, and module availability before executing tenant-scoped
  capabilities. Runtime-role database tests verify stock report valuation and
  foreign-organization exclusion for both stock reports and SKU history
  (`TestInventoryStockReportGovernedExecutorPreservesValuationAndTenantScope`
  and `TestInventoryHistoryAndLotsGovernedExecutorPreservesTenantScope`). See
  [`inventory_read_session.go`](../../apps/api/internal/httpapi/inventory_read_session.go),
  [`inventory_read_executor_integration_test.go`](../../apps/api/internal/capability/inventory_read_executor_integration_test.go),
  and [`go-route-proxy.test.ts`](../../apps/web-vite/src/api/go-route-proxy.test.ts).
- Vite HR Overview and People directory tabs read their report through the
  authenticated Go `hr.report` capability unconditionally. Go errors fail
  closed without retrying legacy `/api/hr`; Leave, Payroll, and Hiring retain
  their existing Go selectors. The capability checks `hr.read`, derives the
  active organization from the signed session, and runs through the tenant-
  scoped runtime database role. The employee reader keeps its
  newest-hired-first query and 200-row limit, and Vite consumes the shared
  `HrReport` response shape. The existing
  `TestGoWave5PayrollApplicantsGovernedExecutorPath` runtime-role proof checks
  the report includes its seeded employee; it does not independently assert
  employee ordering, the 200-row boundary, or cross-organization isolation. See
  [`HrPage.tsx`](../../apps/web-vite/src/components/HrPage.tsx),
  [`hr.ts`](../../apps/web-vite/src/api/hr.ts), and
  [`hr_employees.go#L216-L239`](../../apps/api/internal/capability/hr_employees.go#L216-L239),
  [`wave5_executor_integration_test.go#L195-L209`](../../apps/api/internal/capability/wave5_executor_integration_test.go#L195-L209).
- Vite Messaging mention lists and add-member searches use the Go
  `messaging.listPeople` capability unconditionally. The Go API enables it by
  default; `GO_MESSAGING_PEOPLE_READS=0` disables the capability, and Vite
  fails closed without retrying the still-legacy-owned Next
  `GET /api/conversations/people` route. Go checks organization-scoped
  `messaging.read`; its runtime database integration proof verifies filtered
  results, workmate inclusion, and exclusion of a foreign-organization member
  (`TestMessagingConversationLifecycleGovernsMembershipAndTenant`), while session
  capability tests cover its permission and route gate. See
  [`messaging.ts`](../../apps/web-vite/src/api/messaging.ts),
  [`messaging.go`](../../apps/api/internal/capability/messaging.go),
  [`messaging_integration_test.go`](../../apps/api/internal/capability/messaging_integration_test.go),
  and [`session_capability_test.go`](../../apps/api/internal/httpapi/session_capability_test.go).
- Vite Marketplace Verify sends only the manifest and publisher signature
  fields through the session-authenticated Go `creator.verifyPlugin`
  capability, and strictly validates the `{ok:true,data:{valid,reason?}}`
  response. A bad signature is a successful `valid:false` verdict, not an
  HTTP 422 response; capability permission errors remain visible. Publish,
  install, and uninstall retain their current request route. Existing Go tests
  cover a plugin-kit valid signature, invalid verdicts, and governed execution;
  focused Vite tests assert valid and invalid behavior with no legacy
  verification call. Authenticated browser proof remains pending. See
  [`marketplace.ts`](../../apps/web-vite/src/api/marketplace.ts),
  [`MarketplacePage.tsx`](../../apps/web-vite/src/components/MarketplacePage.tsx),
  [`creator.go#L365-L425`](../../apps/api/internal/capability/creator.go#L365-L425),
  [`creator_test.go#L190-L247`](../../apps/api/internal/capability/creator_test.go#L190-L247),
  and [`creator_executor_test.go#L92-L106`](../../apps/api/internal/capability/creator_executor_test.go#L92-L106).
- Vite Marketplace publish sends the manifest and publisher signature material
  through the session-authenticated Go `creator.publishListing` capability.
  Strict Go success and pending approval envelopes are validated; successful
  publication refreshes listing data, while approval and errors preserve the
  draft. Install and uninstall retain their existing route. The Go runtime-role
  database proof checks governed persistence, organization ownership, and
  refusal to claim a foreign publisher's slug; focused Vite tests cover success,
  refresh, pending approval, errors, strict envelopes, and no legacy publish
  request. Authenticated browser proof remains pending. See
  [`marketplace.ts`](../../apps/web-vite/src/api/marketplace.ts),
  [`MarketplacePage.tsx`](../../apps/web-vite/src/components/MarketplacePage.tsx),
  and [`creator_executor_test.go`](../../apps/api/internal/capability/creator_executor_test.go).
- Vite Marketplace install now sends only the listing ID through the
  session-authenticated Go `creator.installListing` capability. Go verifies
  the current listing signature and verified status under the existing
  advisory and row locks. Because the runtime role's table RLS deliberately
  prevents locking another publisher's row for update, a pair of one-argument
  `SECURITY DEFINER` helpers handles the cross-tenant lock and install write.
  The read helper returns signed listing fields without mutation while holding
  the row lock through transaction commit. The write helper derives the
  installer from transaction-local `app.org_id`, pins `search_path`, checks
  verified status, and updates only `installed_by_org_ids` and `updated_at`.
  PUBLIC cannot execute either helper; only `chaste_app` can. Repeated
  installs preserve the organization array without duplicates while retaining
  the previous timestamp-refresh behavior.
  Runtime-role proof covers direct human execution, valid signature, repeat
  install, invalid signature and unverified refusal without mutation, foreign
  install preservation, inability to claim another organization, and blocked
  publisher-field updates. Vite API and page tests verify the capability
  payload, Go listing refresh, installed state, and absence of the legacy
  install POST. Uninstall remains on its previous route. Authenticated browser
  proof remains pending. See [`marketplace.ts`](../../apps/web-vite/src/api/marketplace.ts),
  [`creator.go`](../../apps/api/internal/capability/creator.go),
  [`0130_go_marketplace_install_state.sql`](../../packages/db/drizzle/0130_go_marketplace_install_state.sql),
  and [`creator_executor_test.go`](../../apps/api/internal/capability/creator_executor_test.go).
- Vite Accounting Overview reads through Go's authenticated
  `accounting.overview` capability unconditionally. The client validates the
  strict response and fails closed on errors; there is no legacy retry or
  overview-specific selector. The Go executor integration proof checks
  `accounting.read`, overview semantics, audit recording, and tenant isolation
  with the runtime database role. The shared capability proxy must be enabled
  for Go execution. See [`accounting.ts`](../../apps/web-vite/src/api/accounting.ts),
  [`AccountingPage.tsx`](../../apps/web-vite/src/components/AccountingPage.tsx),
  and [`accounting_overview_test.go`](../../apps/api/internal/capability/accounting_overview_test.go).

## Capabilities, approvals, transactions, and audit

- The live capability manifest records 311 registrations across 21 modules.
  Humans, agents, and the existing demos call the same TypeScript executor;
  the target Go executor must preserve the capability ids and schemas
  ([`executor.ts#L104-L138`](../../packages/kernel/src/executor.ts#L104-L138)).
- The executor checks module availability, validates input, evaluates policy,
  verifies an approval against the exact capability and payload, then checks
  the receipt key before an effect. Output validation, execution audit, and
  receipt behavior are part of the same public contract
  ([`executor.ts#L120-L180`](../../packages/kernel/src/executor.ts#L120-L180),
  [`executor.ts#L181-L265`](../../packages/kernel/src/executor.ts#L181-L265)).
- Approval decisions are organization-scoped. Approval or rejection claims a
  pending row with a conditional status update before execution, so a
  concurrent approver cannot execute the action twice. The action's own
  permission is checked before claiming; the executor then verifies the stored
  approval payload ([`approvals.ts#L27-L122`](../../apps/web/src/server/approvals.ts#L27-L122)).
- `executeAtomically` places the capability effect, ledger append, and action
  receipt in one tenant transaction and rethrows audit failure so the effect
  rolls back ([`unit-of-work.ts#L5-L28`](../../apps/web/src/server/unit-of-work.ts#L5-L28)).
  Preserve this transactional path and keep `intentId` idempotency. A repeated
  intent with the same capability and input returns its prior result; a
  different capability or input is a conflict.
- Ledger hashes use SHA-256 over the prior hash and a byte-stable field
  concatenation that includes JSON serialization of the payload and event time
  ([`ledger.ts#L26-L40`](../../packages/kernel/src/ledger.ts#L26-L40)). The
  PostgreSQL writer obtains the existing advisory transaction lock, reads the
  chain head, and inserts the next hash-linked row
  ([`kernel.ts#L150-L180`](../../apps/web/src/server/kernel.ts#L150-L180)).
  Go must continue the existing chain without rewriting historical rows.
- Secret-class capability inputs are redacted before they reach the ledger
  ([`executor.ts#L291-L301`](../../packages/kernel/src/executor.ts#L291-L301)).
  Preserve redaction and the existing separation between secret references
  and values provided to models.

## Agent histories and durable runs

- `agent_sessions` stores the organization, user, mode, status, model reference,
  and token usage. `session_events` stores each ordered user, model, tool,
  approval, and compaction event ([`schema/index.ts#L193-L227`](../../packages/db/src/schema/index.ts#L193-L227)).
- `agent_runs` and `agent_run_steps` record the registry version, contract
  revision, current step, version-pinned capability, input hash, output,
  receipt, approval, and execution timestamps
  ([`schema/index.ts#L287-L312`](../../packages/db/src/schema/index.ts#L287-L312),
  [`schema/index.ts#L3176-L3202`](../../packages/db/src/schema/index.ts#L3176-L3202)).
  Keep prior histories replayable and resume from their stored checkpoints;
  do not reconstruct a trajectory from only the latest visible message.
- Existing tests for durable coordination, run recovery, receipts, approval,
  and worker crash recovery include `apps/web/src/server/durable-coordinator.test.ts`,
  `durable-runs.test.ts`, `effect-receipts.test.ts`, `approvals.test.ts`,
  `harness-approval.test.ts`, `worker-kill.test.ts`, and
  `packages/kernel/src/executor.receipts.test.ts`.

## Existing executable proofs

The public demo commands and current TypeScript entrypoints are:

| Command | Entry point | Existing focus |
|---|---|---|
| `demo` | `scripts/demo-agent.ts` | Real provider-backed agent run |
| `demo:slice` | `scripts/demo-slice.ts` | Customer, invoice, gated payment, approval, balanced trial balance |
| `demo:m2` | `scripts/demo-m2.ts` | Receivables aging and closed-period guards |
| `demo:m3` | `scripts/demo-m3.ts` | Document ingestion and deterministic parsing |
| `demo:m4` | `scripts/demo-m4.ts` | Vendor bill, AP posting, gated payment, financial statements |
| `demo:m4b` | `scripts/demo-m4b.ts` | Hire, leave approval, and payroll draft |
| `demo:m5` | `scripts/demo-m5.ts` | POS session, sale, and drawer variance |
| `demo:m6` | `scripts/demo-m6.ts` | Teams and RBAC, inventory and POS stock integrity, three-way matching, and Creator Mode |
| `demo:support` | `scripts/demo-support.ts` | Provider-backed support-agent proof |
| `demo:m7` through `demo:m13` | `scripts/demo-m7.ts` through `scripts/demo-m13.ts` | Inventory, signals, quote-to-cash, accounting depth, people/projects/expenses, analytics/support/documents, and POS/marketing |

Command declarations are in [`package.json#L17-L28`](../../package.json#L17-L28)
and [`package.json#L42-L46`](../../package.json#L42-L46). The user-facing list
notes that every demo needs a migrated database and some require a real model
provider key ([`README.md#L124-L142`](../../README.md#L124-L142)). CI can skip
provider-backed demos when no key is configured, so a skipped proof is not
evidence of Go parity.

The current demo scripts import the TypeScript registry and executor directly.
Keep the command names and assertions, but replace their runtime adapter so
each proof exercises Go before marking it migrated. `demo:slice` is the first
Phase 2 acceptance proof, not a proof of the current Go service.

## Server action replacement

The generated server-action census contains one action,
`switchOrgAction` ([`server-actions.json`](server-actions.json)). It resolves
the signed-in user, checks membership in the requested organization, sets the
HttpOnly active-org cookie for 90 days, and redirects home
(`apps/web/src/app/(app)/_shell/actions.ts:9-31`).
The `/api/org` POST performs the same membership check and cookie write, then
returns `{ok:true}`. Legacy remains the default; with `GO_ORG_SWITCH=1`, the
Next route signs a short-lived assertion, and Go repeats the membership check
under RLS before writing the matching cookie. The Go path fails closed if its
response or cookie does not match the expected contract
([`route.ts#L26-L144`](../../apps/web/src/app/api/org/route.ts#L26-L144),
[`org-route.test.ts#L1-L321`](../../apps/web/src/server/org-route.test.ts#L1-L321),
[`org_switch_test.go`](../../apps/api/internal/httpapi/org_switch_test.go),
[`org_switch_integration_test.go`](../../apps/api/internal/httpapi/org_switch_integration_test.go)).
The Vite org switcher uses a Zod-validated client for the Go `/api/org` handler
and returns to `/` after a successful response. The Settings persona editor
reads with exact `PUT /api/org` and saves with exact `PATCH /api/org`; Go
resolves the same session, requires `iam.admin` for writes, and enforces the
legacy 8,000 UTF-16-code-unit string limit. Preserve membership denial and
cookie flags; the client never reads or writes the active-org cookie
([`ActiveOrganization.tsx#L1-L112`](../../apps/web-vite/src/components/ActiveOrganization.tsx#L1-L112),
[`organizations.ts#L1-L71`](../../apps/web-vite/src/api/organizations.ts#L1-L71),
[`settings.ts#L458-L474`](../../apps/web-vite/src/api/settings.ts#L458-L474)).
Vite always proxies exact GET, POST, PUT, and PATCH `/api/org` requests to Go.
The Go handler mounts by default; `GO_ORG_ROUTE=0` unmounts it and causes these
requests to fail closed. The proxy preserves the session cookie, Origin, body,
and response cookies. The manifest records exact GET and POST ownership as Go
with verified parity. PUT and PATCH are Go-owned with parity pending under a
narrow `/api/org` persona policy exception. Focused Go handler, unit, and
runtime DB tests cover persona authorization and Go's UTF-16 length boundary;
proxy tests cover forwarding and rejection of suffix paths and unsupported
methods. The live legacy differential did not complete: the legacy server was
initially unavailable, then returned
401 for the seeded session. Authenticated browser proof for persona read and
save also remains pending. Existing browser proof
verified a 200 same-org POST and active-org cookie change, plus a 403 for a
forged nonmember target. DELETE and suffix paths remain on their existing owner.
The Vite selector has been removed; `GO_ORG_ROUTE=0` disables the Go handler
without restoring legacy routing.

Vite Settings sends exact GET and POST `/api/routines` collection calls to Go
by default. Set `CHASTE_GO_ROUTINES_ROUTE=0` to route Vite through the legacy
app; set `GO_ROUTINES_ROUTE=0` as well to unmount the Go handler. The
collection handler resolves the signed session and dispatches mutations
through the governed capability executor. Vite uses its deterministic parser
for pre-submit feedback because the Go path does not use the legacy model
refinement fallback. Go remains authoritative and validates every submitted
schedule. Runtime-role HTTP coverage verifies active organization scoping for
list, create, and readback. The manifest records
these exact methods with parity pending until live legacy differential and
authenticated browser proof complete. Webhook token delivery and worker
execution retain their existing owners and lifecycle.

Vite Settings sends exact `GET` and `POST /api/memory` requests to Go by
default. Go resolves the signed Better Auth session and active organization.
The list projection runs through `dbx.WithOrgTx`, returns up to 200 newest
entries with the legacy fields, filters by kind and by query text in either
content or source, and reports `total` before filtering. This projection is
kept in the Go HTTP adapter because `documents.searchMemory` requires a query
of at least two characters and returns at most ten results without entry IDs
or timestamps. `canEdit` comes from Go-resolved `documents.write` permission.
POST deletion dispatches `documents.deleteOrgMemory`, preserving the governed
permission, organization, approval, and audit checks. Vite proxies only these
exact methods and path; other methods and suffix paths retain their existing
owner. Unit, runtime-role HTTP, and Settings client tests cover kind filtering,
empty and one-character source search, pre-filter totals, permission-derived
controls, org isolation, and deletion envelopes. Route parity remains pending
until authenticated browser and live legacy differential proofs complete.

The Vite Inventory defaults panel sends exact `GET` and `POST
/api/module-settings` requests to Go by default. Both methods resolve the
verified Better Auth session and active organization. GET is member-readable,
validates module IDs against `^[a-z][a-z0-9_-]{0,39}$`, and selects through
`dbx.WithOrgTx`; missing rows return `{}`. Inventory is the only registered
settings schema today. Its GET projection trims the unit label, validates
reorder-point values, and strips unknown stored keys, matching
`settingsSchemaFor("inventory")`. Other syntactically valid module IDs remain
readable as stored, while POST returns 404 for modules without a registered
settings schema, matching the existing route. Supported saves pass through the
Go `iam.setModuleConfig` capability executor, which enforces `iam.admin` and
keeps approval and audit handling server-side. Runtime-role HTTP proof covers
member reads, missing defaults, tenant isolation, denied writes, and an
authorized audited write. The route manifest remains parity pending until the
authenticated browser and live legacy differential proofs complete
([`route.ts#L1-L76`](../../apps/web/src/app/api/module-settings/route.ts#L1-L76),
[`module-settings.ts#L1-L26`](../../apps/web/src/server/module-settings.ts#L1-L26),
[`iam_org_settings.go#L123-L169`](../../apps/api/internal/capability/iam_org_settings.go#L123-L169),
[`SettingsPage.tsx#L512-L605`](../../apps/web-vite/src/components/SettingsPage.tsx#L512-L605)).

The Vite Settings Governance panel sends exact `GET` and `POST /api/policy`
requests to Go by default. Reads resolve the signed session and active
organization, use `policy.Reader.ForOrg` through `dbx.WithOrgTx`, retain the
legacy `write`/`50000`/empty-list defaults, and derive `canEdit` from resolved
`iam.admin`. Writes keep the legacy risk enum, optional bounded integer,
approval-risk list defaults and limits, plus exact success and pending
approval envelopes. Go validates and dispatches writes through
`iam.setOrgPolicy`, so the capability executor remains authoritative for
permissions, approval, and audit. Explicit `moneyThresholdMinor: null` is
rejected, matching the legacy Zod route; the Go parser now has a regression
test for this difference. The route manifest remains parity pending until
authenticated browser and live legacy differential proofs complete
([`route.ts#L108-L158`](../../apps/web/src/app/api/policy/route.ts#L108-L158),
[`policy.go#L15-L55`](../../apps/api/internal/policy/policy.go#L15-L55),
[`iam_org_settings.go#L173-L213`](../../apps/api/internal/capability/iam_org_settings.go#L173-L213),
[`policy_session.go`](../../apps/api/internal/httpapi/policy_session.go)).

Vite Accounting reads bank accounts, unmatched/matched/excluded statement
lines, payment candidates, and account totals from Go's
`accounting.listBankingWorkspace` capability. The executor requires
`accounting.read` and queries all data in one `dbx.WithOrgTx` transaction,
preserving account order, transaction status order and limits, payment
candidates, and the existing `accounting.bankSummary` projection. The client
strictly validates the full response and no longer requests `GET /api/banking`.
Reconciliation writes continue through their current route. Runtime-role Go
coverage checks permission denial, cross-organization isolation, ordering,
limits, and embedded summary parity; Vite tests prove every detail section
renders from the capability and writes remain routed. Authenticated browser
proof remains pending.

Vite Accounting and Purchasing now read tax codes with Go's
`accounting.listTaxCodes` capability through the existing
`/api/capabilities/execute` session route. The executor requires
`accounting.read` and performs an organization-scoped read inside
`dbx.WithOrgTx`. It returns all active and inactive codes for both directions,
sorted active-first then newest-first; the Accounting API keeps active output
codes and the Purchasing API keeps active input codes. The Next
`/api/accounting/tax` handler remains in place for the legacy app. Runtime-role
DB and Vite API tests cover authorization, tenant isolation, sorting, both
directions, active/inactive rows, and each client's filtering. Authenticated
browser proof and live legacy differential remain pending
([`route.ts`](../../apps/web/src/app/api/accounting/tax/route.ts),
[`accounting_tax_masters.go`](../../apps/api/internal/capability/accounting_tax_masters.go),
[`accounting.ts`](../../apps/web-vite/src/api/accounting.ts),
[`purchasing.ts`](../../apps/web-vite/src/api/purchasing.ts)).

The Vite Purchasing workspace reads vendors, the newest 100 purchase orders
and bills, payable aging, the newest 50 requests and their RFQs, up to 300
price-history rows, and supplier performance from Go's
`purchasing.listWorkspace` capability. The Go executor requires
`purchasing.read`, uses the session's active organization inside one
`dbx.WithOrgTx` transaction, and retains vendor name order, order and bill
recency, line position, per-line rounding, due amounts, and nullable fields.
Requests and Intel data stay in the workspace result when their dedicated
read selectors are disabled, so those tabs remain populated. The Vite page no
longer requests legacy `GET /api/purchasing`; existing writes and the Next
application's route remain unchanged. Runtime-role Go coverage verifies
permission denial, cross-organization isolation, ordering, limits, and each
section's projection; Vite tests verify rendering with selectors disabled and
reject the legacy GET. Authenticated browser proof remains pending.

The Vite Support conversation picker reads customer options from exact
`GET /api/support/customers`. Go resolves the signed session and active
organization, accepts `crm.read` or `pos.sell`, and runs its projection through
`dbx.WithOrgTx`. CRM readers see deactivated, non-merged customers; POS-only
readers see active, non-merged customers. Results preserve the picker fields
`id`, `name`, and `email`, name ordering, and the 500-row limit. The broader
`/api/customers` GET remains with the existing owner because Vite CRM uses its
full directory projection as a fallback; `/api/customers` writes are unchanged.
Runtime-role DB proof covers both permission projections and tenant isolation,
and Vite API tests cover the same-origin URL, schema validation, and HTTP
errors. Authenticated Support browser proof remains pending
([`support.ts#L361-L363`](../../apps/web-vite/src/api/support.ts#L361-L363),
[`support_customers_session.go#L22-L66`](../../apps/api/internal/httpapi/support_customers_session.go#L22-L66),
[`support_customers_session.go#L86-L132`](../../apps/api/internal/httpapi/support_customers_session.go#L86-L132),
[`support_customers_session_integration_test.go`](../../apps/api/internal/httpapi/support_customers_session_integration_test.go)).

The Vite HR Time tab loads the employee projection through the same
session-authenticated Go `hr.report` capability used by Overview and People.
Time totals and pending approval rows continue to come from Go's
`hr.timeReport` and `hr.pendingTimeEntries` capabilities. A direct Time-tab
test verifies the employee picker, all three Go reads, and the absence of
legacy `GET /api/hr`; the existing runtime-role `hr.report` proof remains the
Go projection check. Authenticated browser proof remains pending.

## Required parity evidence before cutover

1. A cloned-database comparison proves table shape and all existing rows remain
   readable by both runtimes. The `data-tables.json` manifest must be current.
2. A password and active-session compatibility test proves existing auth rows
   and browser cookies work through the bridge and final Go auth owner.
3. Cross-organization tests prove active-org membership validation and RLS
   denial for the Go runtime role.
4. Approval race, exact-payload mismatch, retry, and conflicting intent tests
   prove one effect and the existing response semantics.
5. Go appends a valid next audit hash to an existing chain and secret-class
   inputs remain redacted.
6. Existing agent trajectories, unknown-tool behavior, approval pauses, and
   durable run checkpoints replay from existing rows.
7. Every demo command passes against the Go trust spine; provider-backed demos
   must run with their required provider key rather than be skipped.
8. Fixed-machine startup, edit-to-ready, build, API latency, chat start, and
   queue-age benchmarks meet the targets recorded in the migration plan.
