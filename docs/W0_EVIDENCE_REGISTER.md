# W0 evidence register

Status: living document; updated as W0 work proceeds. Baseline: branch
`cordis-like-engine` at `1f3b078` plus the uncommitted W0 working tree.
Scope of this pass: F01–F17 (Enterprise Evolution §2) and N01–N10 (Module
Audit §2), per the W0 deliverable "evidence register with
confirmed/ruled-out/open states".

Status vocabulary: **reproduced** (executable proof this session, command
cited), **source-confirmed** (cited anchor revalidated at this commit; the
reproduction named by the finding is still pending), **resolved** (finding
discharged), **open** (proof requires deployment, concurrency, or a
multi-actor scenario not yet exercised). Re-validate anchors before fixing:
source moves.

## Environment facts established this session

| Fact | Evidence |
|---|---|
| The historical red gate was environmental, not a code defect: shared dev DB `chaste_os_v2` had 37 applied migrations and a documents layout (`content`, `lifecycle`, `visibility`, `insights`, `current_version`; no `content_base64`) produced by no migration on this branch - migrated by out-of-branch work, likely `origin/feat/document-ingestion`. `jobs.test.ts:58` and the intermittent `products.test.ts` timeout both pass against a branch-migrated fixture DB. | Session diagnosis; full web suite 209/209 on fixture DB |
| Tests now provision per-run fixture databases by default and drop them on teardown; `CHASTE_TEST_DB=1` opts into a provided DB after a migration-count drift guard. | `packages/db/src/test-fixture.ts`; `@chaste/db/test-fixture` export |
| All 22 module test files now execute under `pnpm test` (19 were previously invisible; N36). `turbo test` is uncached. | Working tree; CHANGELOG `[Unreleased]` |
| CI demo coverage remains slice/m4/m5 only, key-conditional. | `.github/workflows/ci.yml` |

## F-register (Enterprise Evolution §2)

| ID | Status at this commit | Evidence and remaining proof |
|---|---|---|
| F01 | **reproduced** | Probe `apps/web/.w0-probes/probe-f01.mts` (run `pnpm exec tsx apps/web/.w0-probes/probe-f01.mts`): a capability whose write commits, followed by a ledger append that throws, returns `ok:false` to the caller while the effect persists - the retry-duplicates-effect window. Structural anchor: `packages/kernel/src/executor.ts:118-124` wraps execute + audit in one try. Fix belongs to B02 (atomic effect/audit receipt). |
| F02 | **reproduced** | Probe `probe-f02.mts`: capability returns `{"n":"not-a-number-7"}` against a declared `z.object({n: z.number()})` output; executor returns `ok:true` with the invalid data (`executor.ts:120` never parses `cap.output`). Fix belongs to B02/B05 (output validation before commit). |
| F03 | **resolved (T06 + B03 notification outbox slice)** | Jobs now claim with expiring leases, heartbeat the matching owner/fencing token, reclaim stale processing rows, back off retryable failures and fence late acknowledgements. Approval/support notification intents now commit to a fenced outbox before delivery; uncertain webhook/SMTP outcomes become explicit reconciliation cases. `apps/web/src/server/jobs.test.ts` and `apps/web/src/server/outbox.test.ts` cover stale-worker rejection, no-resend uncertainty and reconciliation. Payment/connector effects and full worker-kill timing remain B03 follow-up evidence. |
| F04 | **resolved (T03)** | Recurring expansion now runs only through `accounting.generateDueInvoices`; due templates are row-locked and each scheduled instant is persisted in `recurring_invoice_runs` under a unique `(org_id, recurring_invoice_id, scheduled_for)` key. `modules/accounting/src/recurring.test.ts` proves a repeated occurrence creates one invoice and one completed run. DST/outage policy and broader scheduled-work occurrence sharing remain follow-up work. |
| F05 | **reproduced (in test logs)** | On a clean fixture DB, `analytics.test.ts` and `support.test.ts` drive the agent loop; its step/tool event inserts into `session_events` fail (no parent `agent_sessions` row) and are logged fire-and-forget while the run continues - silent trajectory gaps, exactly the audit/replay risk. Fix belongs to B04 (durable run log). |
| F06 | source-confirmed | `packages/kernel/src/policy.ts` ordinal risk + amount thresholds; system actor in `jobs.ts` built from the queued capability permission. Open: delegation-ceiling and cumulative-exposure tests (A01). |
| F07 | source-confirmed | `apps/web/src/server/approvals.ts` conditional claim present; rejection branch precedes capability-permission check. Open: restricted-member rejection repro (T05). |
| F08 | source-confirmed | `modules/creator/src/index.ts` - four `risk: "read"` sites include proposal-inserting capabilities; render/test evidence split absent. Open: route-level proof (T04). |
| F09 | source-confirmed | `packages/db/src/client.ts` documents the bypass-role escape hatch; creator takes direct `deps.db`. Open: runtime-role matrix (T09/S01). |
| F10 | source-confirmed | `apps/web/src/server/kernel.ts` single constant advisory lock for the ledger chain. Open: contention measurement (ADR 0022 decision). |
| F11 | source-confirmed | `apps/web/src/server/onboarding.ts` embedding inside the org transaction (4 anchor hits). Open: slow-provider/failure/timing repro. |
| F12 | open | Wizard and tests exist from remote; persistence/correctness improvements not started (U02). |
| F13 | source-confirmed | `apps/web/src/server/rate-limit.ts` process-local counters + forwarded-header IP (2 hits). Open: multi-replica/trusted-proxy proof (S02). |
| F14 | source-confirmed | Schema uses `integer` money columns; bigint FX in JS-number mode. Open: signed-32-bit and safe-integer range tests (B06). |
| F15 | source-confirmed | CI runs only `demo:slice`, `demo:m4`, `demo:m5`, conditional on `NVIDIA_API_KEY`; other demos unproven in CI (T11). |
| F16 | source-confirmed | `apps/web/src/server/auth.ts` configures email/password; SSO remains storage/routing. Open: full SAML/SCIM login trace (S01). |
| F17 | open | ADR 0023 defers executable creator sandboxing; unchanged. E03 isolation design still pending. |

## N-register (Module Audit §2, security/operational)

| ID | Status at this commit | Evidence and remaining proof |
|---|---|---|
| N01 | source-confirmed | `apps/web/src/app/api/hr/route.ts:7` GET passes session/org check only and returns `monthlySalaryMinor`/`taxRateBps` (`:49-50`) via direct `db.select()`; same shape in customers/deals/marketing/projects/pos list routes. Open: cross-role denial matrix incl. non-owner runtime role (I1/T09). |
| N02 | source-confirmed | `modules/signals/src/index.ts` invokes all producers with org/time only (3 anchor hits); `server/kernel.ts` composes producers unconditionally. Open: cross-module disclosure repro (I1). |
| N03 | **resolved (N03 delivery)** | Sign-in sealed behind `requireEmailVerification` (link re-sent on each attempt); unverified sessions resolve to a bare identity - no memberships surfaced, no permissions, case variants included - so pre-provisioned (SCIM/invitation) emails are claimable only after verification or a trusted-IdP assertion. Concurrent first sign-ins collapse to one domain user. Deployment profiles and edges: `docs/n03-verified-binding-matrix.md`; executable proof: `identity-binding.test.ts`. Open: real-SMTP/real-IdP end-to-end runs need a staging deployment. |
| N04 | source-confirmed | `api/support/public/route.ts` binds conversations from submitted email (4 anchor hits). Open: end-to-end disclosure proof against a running server (I1). |
| N05 | source-confirmed | `modules/support/src/index.ts` `searchKnowledge` retrieves any org memory under `support.read` (3 hits). Open: retrieval repro incl. document chunks (I1). |
| N06 | source-confirmed | `api/conversations/route.ts:10` lists every org conversation with latest-message preview `body.slice(0, 80)` and **no membership filter** (detail route checks membership - boundary contradiction confirmed at HEAD); also one query per conversation (N35 overlap). Open: two-actor browser/API proof (I1). |
| N07 | source-confirmed | `modules/iam/src/index.ts` `assignRole` lacks last-owner check (3 hits); SCIM delete leaves `user_roles`. Open: lifecycle concurrency repro (I1). |
| N08 | source-confirmed | `api/support/channels/route.ts` GET lazily inserts settings; POST toggles/tokens with session+module checks only (4 hits). Open: mutation-classification inventory (I1/B01). |
| N09 | **resolved (N09/ADR 0052, migration 0046)** | Commit-time enforcement delivered: line CHECKs (nonnegative, single-sided, nonzero), deferred balance/completeness/cross-org constraint triggers, and UPDATE/DELETE/TRUNCATE refusal on `journal_entries`/`journal_lines`/`ledger_events` - with one declared maintenance context (`app.ledger_maintenance`) for teardown/repair that the balance guards ignore. The runtime role additionally lost mutation rights on the append-only set (`APPEND_ONLY_TABLES`, re-revoked on every `ensureAppRole` grant; conformance sweep asserts it). `probe-n09` now asserts DISCHARGED on a fresh fixture: 8 triggers present, unbalanced commit refused, posted-line UPDATE/DELETE refused. `journal-guards.test.ts` pins the audit's full negative/positive proof list. POS's post-insert `sourceId` patch is gone (invoice inserted before posting). Stock-ledger immutability (`stock_movements`) remains open as a follow-up slice. |
| N10 | source-confirmed | `packages/db/src/migrate.ts` `dockerDump` parses only user/database from the URL and falls back to the default local container (`:141-150`); snapshot-before-pending-check and last-ten retention confirmed in the same file. Open: restore drill + identity verification (S03). |
| N11 | **resolved (Slice E + N11 completion)** | The credit-adjusted balance contract is now the only outstanding computation: `recordPayment`/`payBill` gate and mutate under a per-document `FOR UPDATE` lock (simultaneous overpays serialize - exactly one commits), `reversePayment`/`creditNote` share the lock; `listInvoices`, `arAging`, `unrealizedFxExposure`, overdue signals, the accounting/dashboard/purchasing pages and the customer portal all show `documentBalance`'s credit-adjusted outstanding; aging and overdue signals run from `dueAt` with an explicit as-of. `n11-reconciliation.test.ts` pins one invoice's identical outstanding across contract, aging, analytics, support and portal; `balance-reconciliation.test.ts` pins the lock race. Open: none for the core; historical-disagreement audit for pre-existing rows remains a migration-time task. |
| N12–N36 | N12/N13/N14/N16/N22 **resolved** (see delivery sections below) | N12 vendor-payment domain compensation; N13 exceptional year-end entries, posting eligibility, backdated corrections; N14 allocation model + reconciled definition; N16 receipt documents + stable positions + authoritative overreceipt; N22 stock projections, bin-scoped counts, one number allocator. The remaining N12–N36 rows are not yet revalidated: treat audit anchors as starting points, revalidate at fix time per the audit's §8 contract. |

## Probe reproduction

Probes are untracked local evidence under `apps/web/.w0-probes/` (kept out of
`src/` so typecheck/test ignore them). Run from the repo root:

```sh
pnpm exec tsx apps/web/.w0-probes/probe-f01.mts   # F01 committed-write/audit-failure window
pnpm exec tsx apps/web/.w0-probes/probe-f02.mts   # F02 output schema not enforced
pnpm exec tsx apps/web/.w0-probes/probe-n09.mts   # N09 no DB-enforced ledger invariants (fixture DB, self-dropping)
pnpm exec tsx apps/web/.w0-probes/probe-n11.mts   # N11 credit-ignoring payment acceptance (fixture DB, self-dropping)
```

The DB probes create and drop their own fixture databases; they never touch
the development database.

## W0.4 - entry-point and runtime-role inventory

Mechanical classification of all 55 files under `apps/web/src/app/api/**/route.ts`
(executor calls vs direct `db.insert/update/select`, swept 2026-09-12). This is
the B01 entry-point map; "ungoverned write" = a route mutating business state
with zero `executor.execute` involvement.

### Ungoverned write surface (B01 violations, with audit-finding overlap)

| Route | Direct mutations | Finding | Required treatment |
|---|---|---|---|
| `api/chat` | agent_sessions upsert, tickets insert | X11, N08 | tickets through a governed capability returning a receipt; session upsert documented as infrastructure |
| `api/conversations` | conversation + member inserts | N08 | governed createConversation with transactional membership |
| `api/import` | batched customer/product inserts | X15 | governed bulk import capabilities (P0) |
| `api/invite/[token]` | invitation claim, membership + role inserts | N07 | transactional invitation claim service |
| `api/notifications` | shared readAt update | N29 | per-user receipt state |
| `api/org` | persona/settings update | N08 | governed org settings capability |
| `api/proposals` | review-decision update | N34 | compare-and-set decision service |
| `api/scim/tokens` | token insert/update | N07 | governed credential admin |
| `api/scim/v2/Users`, `[id]` | user/membership/role lifecycle | N07 | shared identity lifecycle service |
| `api/support/channels` | settings lazy-insert, token rotation | N08 | governed settings capability; GET must not mutate |
| `api/support/public` | 6 inserts, 2 updates | N04 | verified-binding intake service (P0 containment) |
| `api/team/sso` | connection insert/update | N07/N08 | governed SSO admin |
| `server/onboarding.ts` (via `api/onboarding`) | organization bootstrap + settings snapshot | B01, F11 | narrow documented bootstrap exception, atomic, intent-keyed |

### Ungoverned read surface (N01 class; writes governed, reads not)

`api/hr` (salaries, tax rates), `api/ledger` (full payload projection),
`api/customers`, `api/deals`, `api/marketing`, `api/projects` (list default),
`api/pos` (list), `api/sessions` (titles), `api/dashboard`, `api/approvals`
(GET), `api/metrics`, `api/conversations` (list + previews), `api/setup`
(org counts + embed token), `api/portal/invoice/[token]` (tokenized public
exception - verify scope), `api/support/public` reads. Governed writes do not
legitimize ungoverned reads; each needs an explicit permission + audience.

### Governed and infrastructure entry points

- Fully governed action routes: accounting, analytics, banking, customers,
  deals, documents, email, expenses, health, hr (POST), inventory,
  manufacturing, marketing, marketplace, modules, pos, projects, purchasing,
  quotes, recurring, reports, routines, signals, support, team, time.
- `api/auth/[...all]`: Better Auth handler - documented infrastructure
  exception (S01 governs its configuration).
- Worker (`scripts/worker.ts` → `processOneJob`) executes through the kernel
  by a system actor scoped to the job's org - governed (F06 delegation
  ceiling still open).
- Server actions: only `app/(app)/_shell/actions.ts` (org switch) - no
  domain writes.
- Boot (`instrumentation.ts`): runs migrations - infrastructure, but see N10.

### Runtime DB roles

| Fact | Evidence | Consequence |
|---|---|---|
| Exactly one role exists in the deployed database: `chaste`, **superuser, BYPASSRLS**. | `pg_roles` inventory of the live dev database, 2026-09-12 | RLS is inert for the application; the S01 gate "runtime role must be non-owner and NOBYPASSRLS" fails by default in dev **and CI** (service defines `POSTGRES_USER: chaste`) |
| The only NOBYPASSRLS probe role (`chaste_rls_probe`) is created and dropped ad hoc by `packages/db/src/rls.test.ts`. | test source | RLS isolation is proven only in that one test, never by the running app |
| No migration creates application roles. | zero `CREATE ROLE` in `packages/db/drizzle/*.sql` | role provisioning is entirely manual/out-of-band - same drift class as the schema incident |

Required: a least-privilege runtime role (SELECT/INSERT/UPDATE/DELETE on
tenant tables, no DDL, NOBYPASSRLS) wired through `DATABASE_URL`, with
separate migration credentials; CI must run the suite under it. This is the
W1 prerequisite for every RLS-dependent gate (S01, N01, F09).

## W1a - least-privilege runtime role (delivered)

`chaste_app` (NOBYPASSRLS, DML-only, no DDL) is now provisioned idempotently
by `ensureAppRole` (`@chaste/db/roles`): cluster-level role plus per-database
grants and default privileges on the migration owner, so future tables are
covered. `runMigrations` prefers `MIGRATION_DATABASE_URL`, separating owner
credentials from the runtime identity when the flip happens. The contract is
pinned by `packages/db/src/runtime-role.test.ts` (5 passing tests): sees only
the tenant named by `app.org_id`; cross-tenant filtering returns nothing;
no-context reads fail closed; in-context writes succeed and out-of-context
writes are rejected; DDL is refused.

Not yet flipped: the application still connects as `chaste` by default.
Flipping `DATABASE_URL` to the runtime role requires the codebase-wide
audit of context-setting paths (better-auth handlers, bootstrap, SCIM,
background jobs) - that is the I1/S01 matrix work. The floor is now
executable instead of aspirational, and migration 0014's stated intent
("the app connects as a role that does NOT bypass RLS") has a supported path.

## W1c - atomic receipts and honest outcomes (B02 first slice, delivered)

The executor now enforces honest effect semantics at the trust boundary:

- **F01 discharged** (`packages/kernel/src/executor.ts`): an audit append
  failure after a committed write returns `{ok: false, outcome: "unknown"}`
  instead of a plainly retryable failure. `CapabilityResult` gains
  `outcome: "known" | "unknown"` and `replayed`.
- **F02 discharged**: capability output is validated against its declared
  schema after execution. A write returning invalid output reports
  `outcome: "unknown"`; a read reports a plain failure. Invalid output can
  no longer cross as `ok: true`.
- **Action receipts**: `EffectReceiptStore` (kernel interface) +
  `action_receipts` table (migration 0035, RLS policy included) +
  `pgEffectReceiptStore` wired into `buildExecutor`. With `ctx.intentId`
  (client action identity), retries serve the prior receipt; key reuse with
  a different payload is a conflict; an unknown outcome persists so the
  retry reconciles instead of re-executing. Probes `probe-f01`/`probe-f02`
  now verify the discharged behavior.

Pinned by `packages/kernel/src/executor.receipts.test.ts` (6 tests) and
`apps/web/src/server/effect-receipts.test.ts` (3 integration tests on the
real store, including the money case: crash-after-commit + retry yields one
posting, not two).

Residual gaps, tracked for later slices: the receipt write and audit append
are two statements (the full B02 unit of work - one transaction spanning
mutation, audit and receipt - still requires injecting the transaction into
module repositories); `intentId` is adopted only by the accounting route's
mutations (UIs do not yet send it); `accounting.recordPayment` has **no
route caller at all** - a capability-discovery gap (X04), recorded here.

## W1b - route read guards and the N06 list fix (first slice, delivered)

- **N01 (route surface) discharged for the audit's listed reads**: a
  `missingPermission` guard (`apps/web/src/server/route-guards.ts`) now gates
  hr salaries (`hr.read`), the ledger payload projection (`accounting.read`),
  customers/deals (`crm.read`), marketing (`marketing.read`), projects list
  (`projects.read`), POS lists (`pos.read`), and the setup checklist
  (`iam.admin` - it exposes the support embed token and org counts). The
  sessions list applies the detail route's visibility predicate (own sessions,
  everything for `iam.admin`). Pinned by a six-case route matrix
  (`apps/web/src/server/route-guards.test.ts`) calling the real handlers with
  mocked session resolution against the fixture database - including the
  negative assertions that denied responses contain no sensitive values.
- **N06 route side fixed**: the conversations list now inner-joins
  conversation membership (`messaging.read` + member filter) and fetches
  previews only for visible conversations - a nonmember no longer sees titles,
  previews, or activity for a DM. Covered in the same matrix.
- Still open on these findings: exports/search/attachments authorization,
  cache-aware checks, and the module-side `messaging.listConversations`
  capability (same leak inside the module, per N06); the remaining ungoverned
  write routes from the W0.4 inventory; `approvals`/`metrics` GET policy.
- Infrastructure: `hookTimeout: 30_000` for the web suite - 18 files contend
  for one fixture database per run and a 5-second `beforeAll` under parallel
  load legitimately exceeded the 10s default (the historical
  `products.test.ts` flake, reproduced and resolved honestly).

## Slices A–C (delivered in one pass)

**Slice A - W1b remainder (write boundaries):**
- **N06 module side fixed**: `messaging.listConversations` now membership-scoped like the route; the system actor lists nothing.
- **N29 fixed**: notifications are immutable events with per-user receipts (`notification_reads`, migration 0036, RLS included). One person's read of a broadcast leaves it unread for everyone else; repeats are idempotent; another user's personal notification is a 404. The broadcast row's `readAt` is never rewritten.
- **N34 fixed (review race)**: proposal decisions are compare-and-set - the status check lives in the UPDATE, so concurrent reviewers produce exactly one decision and one 409. Marketplace browsing moved from `accounting.read` to a dedicated `platform.browse` permission.
- **N08 fixed (channels)**: GET never creates the settings row and hands the embed token only to `iam.admin`; POST (provision/rotate/toggle) requires `iam.admin`; the support settings UI handles the unconfigured state and non-admin read-only view.

**Slice B - W1d (B02 unit of work + adoption):**
- `executeAtomically` (`apps/web/src/server/unit-of-work.ts`): opens one transaction; a transaction-scoped registry and executor run mutation, audit fact and receipt **in the same unit**. Modules nest via savepoints (their `withOrgContext(deps.db, …)` accepts the tx).
- `failOnAuditError` executor mode: inside a unit of work, an audit failure rethrows - rolling back the whole effect - instead of the no-shared-transaction "unknown" outcome. The executor's outer catch no longer conflates audit failures with domain failures.
- Adoption: `api/accounting` `payBill` runs atomically whenever the client sends `intentId`; the accounting page generates one identity per confirmed intent. Proven by `unit-of-work.test.ts`: commit+replay in one unit; audit failure after the write rolls back payments, ledger and receipts together; the retry then starts clean and commits once.

**Slice C - S01 floor (mechanical RLS conformance):**
- Every fixture database now provisions `chaste_app` (drop `CHASTE_TEST_NO_APP_ROLE=1` to skip), so RLS conformance is testable anywhere.
- `packages/db/src/rls-conformance.test.ts` sweeps every org-scoped table (38 tables) and asserts: RLS enabled, `tenant_isolation` policy present, DML granted to the runtime role, zero rows without tenant context, and zero cross-tenant rows under the other org's context.
- **The sweep found real drift on its first run**: `bank_accounts`, `bank_transactions`, `purchase_requests`, `rfqs`, `sales_tax_filings`, `support_settings` - added after 0014's RLS pass - had no policies. Fixed in migration 0037; the suite now prevents recurrence.

Still open (unchanged scope): remaining ungoverned write routes (import, scim, invite, sso, public support, chat tickets, onboarding bootstrap - I1/I2 design work), the application-wide role flip (now far safer: the conformance sweep proves the policy floor), and intentId adoption in the remaining UI surfaces.

## Slices D–E (delivered)

**Slice D - import boundaries and ticket receipts:**
- **X15 (import) fixed at the boundary**: importing customers now requires `crm.write`, products `inventory.write` - writing domain rows is domain authority, not session membership. Money parsing is exact (`toMinor` from the raw string): `"1,234.56"` → 123456, `"19.99"` → 1999, and sub-cent precision, negatives and malformed values are row errors - the float `Math.round(n * 100)` path is gone.
- **X11 (ticket receipts)**: `TicketSink.file` returns the durable ticket id and the loop's `file_ticket` tool result carries `ticketId` - chat no longer answers "ticket filed" with no reference. Implemented in the chat route, the messages route, and the routine runner sinks.
- Verified already-gated (no change needed): `api/org` PATCH (normalized to `hasPermission`), `api/team/sso`, `api/scim/tokens` - all `iam.admin`.

**Slice E - N11 discharged (one balance contract):**
- `packages/erp-core/src/document-balance.ts`: `documentBalance` (credit-adjusted outstanding, over-allocation, settled flag) and `canAcceptPayment` (lifecycle eligibility - drafts and voids refuse money - plus the outstanding cap), integer-exact, RangeError on bad money.
- Adopted at every divergence the audit named: `accounting.recordPayment` and `purchasing.payBill` now gate on the credit-adjusted outstanding and refuse drafts (previously only voids were refused and credits ignored); analytics invoice aging and the support invoice projection compute outstanding the same way.
- Probes: `probe-n11` now asserts DISCHARGED - the full 10000 payment against a 4000-credited invoice is refused with "outstanding is 6000". Contract pinned by 7 erp-core tests including conservation and acceptance-cap sweeps.

## I1 write boundaries - remaining ungoverned writes (delivered, ADR 0053)

The W0.4 ungoverned-write inventory is now closed except onboarding
bootstrap:

- **N07 lifecycle**: `server/identity-lifecycle.ts` owns invitation claims
  (row-locked, compare-and-set, verified-email required - the N03
  containment) and member deactivation (membership + user_roles + pending
  invitations cleared in one transaction; last-owner refused with zero
  partial effects; SCIM DELETE uses it). `iam.assignRole` shares the
  last-owner guard. Pinned by `identity-lifecycle.test.ts` (8 cases incl. a
  concurrent double-accept race) and `last-owner.test.ts`.
- **N08 conversation/ticket paths**: `messaging.createConversation` and
  `support.createTicket` replace route-side inserts; the chat `file_ticket`
  sink executes through the kernel and reports refusal honestly
  (`TicketSink.file → { id: null, error }`). The routine runner's sink is a
  documented system-actor exception pending F06/A01 delegation work.
- **N04 containment**: widget conversations start unbound - visitor email
  lives on the thread (migration 0047: nullable `customer_id`,
  `visitor_email`, hashed `visitor_secret_hash`), a per-conversation secret
  issued once gates read/write/escalate, and the care agent reports "no
  account on file" for unbound threads. Knowing a customer's email plus the
  public token reveals nothing about them. Pinned by
  `support-public.test.ts`.

## B01/T08 - intent-keyed bootstrap (delivered; the I1 standing exception is discharged)

`runOnboarding` remains the one declared bootstrap exception to the governed
command path (tenant creation cannot require an existing tenant), but its
honesty is now mechanical:

- **Intent receipt (T08/B01)**: migration 0048 adds `bootstrap_intents`,
  committed in the same transaction as the organization. A retry after a
  lost response replays the receipt (even once the session resolves the
  org); a conflicting reuse of an intent id with a different payload hash is
  refused; the wizard persists its intent id in localStorage until the
  workspace exists and clears it on success.
- **Slug uniqueness in-transaction**: the suffix walk retries under
  savepoints against the unique constraint instead of a racy pre-flight
  check.
- **Async embedding (T08)**: the transaction commits a zero vector so the
  business profile is never lost; the real embedding upgrades it
  post-commit. No provider call holds the bootstrap transaction open.
- Pinned by `onboarding-bootstrap.test.ts` (5 live-DB cases) and the
  extended wizard tests (19 cases incl. retry-with-same-intent and
  clear-on-success).
- Still open by design: N03's full verified-binding matrix (deployment-level
  proof); SCIM token expiry/rotation policy.

## W0.5 build - receiving desk, My Work home, supplier page, instrumentation (delivered)

The pilot build order executes on the delivered engines:

- **P05 receiving desk** (`/purchasing/receiving`): find the order from the
  delivery note, enter per line what was accepted and what was refused
  (reason mandatory, shown to the supplier), overreceipt only with paired
  tolerance and authority, finish with receipt number and what remains
  outstanding. Receipt history is visible per order. Every write goes
  through the governed `purchasing.receiveGoods` / `returnGoods` /
  `listReceipts` capabilities via the kernel executor with operation ids.
- **P01 My Work home** (`/api/my-work`, top of the home page): one
  deterministic ranked list - approvals the viewer has authority to decide
  first (oldest first), then partial orders' outstanding lines (largest
  first), then module signals with coverage failures shown as "unavailable,
  not zero problems". Each card says what changed, why it matters, and one
  primary action.
- **NL brief**: `/api/my-work/summarize` writes a two-sentence brief over
  the already-authorized card bundle on
  `openrouter/stealth/union-alpha`; without a key it degrades honestly -
  the ranked list never depends on the model.
- **P04 supplier view**: the vendors tab remembers the relationship - open
  orders, bills still owed, receiving-desk deep link per vendor.
- **Instrumentation**: `lib/pilot-metrics.ts` records home-open,
  receiving-open, first-action and journey-complete events with elapsed
  time in localStorage - no server write path, so telemetry cannot become
  an ungoverned write; the pilot operator exports per device.

Pinned by `apps/web/src/server/pilot-ui.test.ts` (ranked composition,
receipt round-trip, rejection boundary, honest NL degradation).

## W0.5 - pilot cohort and workflow selection (recommended, awaiting owner confirmation)

`docs/w05-pilot-selection.md` selects the pilot cohort on evidence: a small
distribution/wholesale purchasing-and-receiving team, running the chain
receive → accept/reject → remaining visibility → three-way bill match →
pay → correct (returns/reversals), entered from a P01 "My work" home, with
P05's receiving desk as the first vertical journey. Every step of the chain
runs on delivered, ledger-proven contracts from this audit cycle (N16
receipts, N11 balances, N12 reversals, N22 projections); P03 (reconciliation
workspace) and P07 (checkout) are documented as deferred alternatives.
Measurement plan follows the audit's provisional usability targets. The
selection is the recommended default - owner confirmation unlocks the P05
UI build.

## N03 - verified identity binding closed; deployment matrix recorded (delivered)

A password account proves nothing about mailbox ownership, and domain
identities are pre-provisioned (SCIM, invitations) and bind by email -
so an unverified sign-up for a provisioned address could previously walk
straight into the pre-provisioned memberships. Two layers now seal the
binding: Better Auth runs with `requireEmailVerification` (sign-in refuses
unverified accounts, re-sends the verification link, sign-up skips
auto-sign-in, duplicate responses stay generic), and the resolution layer
surfaced no memberships and no permissions to an unverified session -
including case-variant claims. Verification, or a trusted-IdP assertion in
SSO profiles, unlocks pre-provisioned access; concurrent first sign-ins
collapse to one domain user via the unique email plus conflict re-select.
`docs/n03-verified-binding-matrix.md` records the deployment profiles (no
SMTP, password+SMTP, trusted IdP, SCIM), the covered edges (case, recovery,
email change, enumeration, bootstrap-while-unverified), and the executable
proof in `apps/web/src/server/identity-binding.test.ts`.

## SCIM token expiry/rotation policy (delivered, 0054)

SCIM provisioning tokens no longer live forever: creation applies a 90-day
default window (1–365 configurable), the IdP route refuses expired tokens
regardless of the active flag, rotation is create-new + deactivate-old, and
pre-policy tokens (null expiry) stay valid until deactivated. Pinned by
`apps/web/src/server/scim-tokens.test.ts`.

## N22 completion - stock projections, bin-scoped counts, one number allocator (delivered, ADR 0050 extension)

Migration 0053 adds `stock_balances` - one row per org+item+location+lot -
maintained by the `stock_balances_apply` trigger on `stock_movements`, so
the read model is consistent with the ledger by construction whatever wrote
the movement. Every on-hand read (inventory, transfers, manufacturing, POS,
purchasing, sales) now reads the projection instead of re-summing the
ledger. `inventory.rebuildStockProjections` replays the ledger into the
projection under the command locks; the review script
(`scripts/n22-projection-review.ts`) seeds 40k movements across 200 items
and shows the projection read hitting one balance row through
`stock_balance_item_idx` (constant, ~0.09 ms) while the ledger sum grows
with history (200 movement rows scanned at this seed size). Cycle counts
scope to one location: expected quantities snapshot per bin and posting
adjusts that bin only, while the movement watermark stays item-global -
stricter is safe; a false invalidation forces a recount, never a bad
adjustment. Document numbers come from one per-org allocator
(`nextDocNumber` over `doc_counters`, seeded from existing maxima),
replacing per-module MAX+1 across purchasing, accounting, sales, POS,
manufacturing and support. Pinned by
`modules/inventory/src/projections.test.ts`.

## N16 deepening - receipt documents, stable positions, authoritative overreceipt (delivered, ADR 0049 extension)

Receiving now writes a first-class document: `goods_receipts` headers (who
received, when, against which order) with lines that split arrivals into
accepted and rejected quantities - rejected goods need a stated reason,
never stock, but still complete the vendor's delivery duty. Migration 0052
gives every `po_lines` row a stable `position` assigned once at creation:
"line 1" identifies the same line for the order's whole life, in the
module, in bills, and in the human API surface, whatever row storage does.
Overreceipt tolerance is an explicit authority (`overreceiptTolerancePct`
paired with `authorityReason`), never an accident. Returns draw from
concrete receipts - a named receipt or oldest-first FIFO - and update each
receipt line's returned quantity, while three-way bill matching stays on
accepted-net-of-returns. `purchasing.listReceipts` reports
accepted/rejected/returned/remaining per receipt line and per order line.
Pinned by `modules/purchasing/src/receipts.test.ts` (rejection recording,
authority pairing, reorder-surviving addressing, receipt-linked returns)
and the standing equivalence floor in `receiving.test.ts`.

## N13 completion - exceptional year-end entries, posting eligibility, backdated corrections (delivered)

The year-end roll is now an explicit exceptional entry (`journal_entries.entry_kind
= 'year_end_close'`, migration 0051), not a manual entry that happens to zero
the P&L: at most one live roll exists per sealed year, and re-closing a
reopened year replaces the live roll - reversed inside the reopened December,
never mirrored into the current period - before the fresh roll lands, so
retained earnings is rolled once, not twice. `accounting.incomeStatement`
excludes the close family, so a sealed year keeps its operating history (an
all-time operating view) instead of silently reporting zero revenue. Generic
reversals are corrections: they post into the approved open period while
carrying the original business date in `business_at`. The posting service
validates every pre-resolved account id against posting eligibility - same
org, not archived - closing the cross-tenant and behind-the-chart posting
holes. Pinned by `modules/accounting/src/year-end.test.ts` (eligibility
refusals, correction provenance, roll survival of the P&L, double-close
refusal, replace-and-reclose with one live roll).

## N12 purchasing compensations - vendor payments undo through their own domain (delivered, ADR 0051 extension)

`purchasing.reverseVendorPayment` mirrors the payment entry in its original
currency, releases the bill's paid amount through the balance contract,
demotes a paid bill back to open (bill-state repair), and refuses a second
or replayed reversal at the business-operation level. `payBill` declares it
as its real inverse - the kernel types inverse input against actual output -
and settles bills through `documentBalance`, so a bill fully covered by
vendor credits is paid without a payment. The generic `accounting.reverseEntry`
refuses `vendor_payment` entries with named routing. Pinned by
`modules/purchasing/src/reversal.test.ts` (pay→reverse→pay consistency,
replay refusal, credit-aware outstanding) and a routing case in the
accounting reversal suite.

## N14 allocation model - bank reconciliation with remaining amounts and a real reconciled definition (delivered, ADR 0048 extension)

Migration 0050 introduces `bank_allocations` (tenant-isolated, backfilled
from existing single-claim matches) and retires the claim columns and their
unique indexes. A statement line is explained by explicit allocations that
share its sign and fit inside its amount: a payment - whole, partial split,
or grouped with other payments - a journal entry (transfers included), a
reviewed fee, or an FX difference. Claims are enforced transactionally by
row locks and remaining-amount budgets (`paymentRemaining`,
entry cash-effect budget), not unique indexes. `accounting.bankReconciliation`
reports per-line and per-period allocations and the unexplained difference;
reconciled means that difference is exactly zero. Pure math in
`packages/erp-core/src/bankrec.ts` pinned by property tests; live behavior
pinned by `bank-matching.test.ts` (equivalence floor) and `bankrec.test.ts`
(fees, FX, grouped settlements, the reconciled flip).

## N11 completion - one balance contract everywhere, locked money application (delivered)

Slice E built the pure contract and the payment gate; this slice closes the
remaining divergence the audit named:

- **Locked money application**: `recordPayment`, `payBill`,
  `reversePayment`, and `creditNote` read the document `FOR UPDATE` inside
  the capability transaction, so the outstanding verdict sees every
  committed movement. Two simultaneous payments that are each valid alone
  but not together serialize: exactly one commits, the loser is refused
  with the exact outstanding (`balance-reconciliation.test.ts` race case).
- **Cross-surface reconciliation**: `listInvoices`, `arAging`,
  `unrealizedFxExposure`, the accounting-module overdue signal producer,
  the accounting/dashboard/purchasing pages, and the customer portal all
  compute outstanding through `documentBalance` (web surfaces via the
  shared `server/balances.ts` helper) - credits reduce what is chased,
  over-allocation clamps at zero instead of hiding credit behind a
  negative, and the portal shows credited amounts explicitly.
- **Due-date collections basis**: `computeAging` buckets days past due
  (`dueAt ?? issuedAt`, explicit as-of `now`); not-yet-due invoices stay
  current. arAging, the analytics aging SQL, the dashboard overdue split,
  and overdue signals share the basis.
- Pinned by `n11-reconciliation.test.ts`: one seeded invoice (credited and
  partially paid) shows the identical outstanding from the pure contract,
  arAging, the analytics aging capability, the support invoice lookup, and
  the portal handler.

## Stock-ledger immutability - quantity truth is append-only (delivered, ADR 0052 extension)

Migration 0049 extends the commit-time immutability pattern to
`stock_movements`: corrections are compensating movements (production and
transfer reversals, cycle-count postings) - never edits to history. UPDATE,
DELETE, and TRUNCATE refuse outside the declared maintenance context;
`purgeTenantFinancials` now clears stock history alongside journal and
ledger rows; the runtime role holds the append-only privilege shape. Pinned
by `stock-guards.test.ts` (3 live-DB cases) plus the runtime-role and
RLS-conformance sweeps; inventory and seeded analytics/degradation suites
run on purge-through-maintenance teardowns.

## B02 client action identity - intentId adoption across UI surfaces (delivered)

Every mutating UI request now carries a client action identity, closing the
B02 adoption gap (the kernel receipts existed; most surfaces never sent an
id):

- `postApi` (the single UI/API seam) injects a fresh per-call `intentId`
  into any object body that lacks one; callers with one identity across
  several submissions of the same logical action pass their own and win
  (`api.test.ts` pins all three behaviors).
- Every mutating POST route extracts the optional `intentId` from its body
  and threads it into the actor context, so the kernel receipt store can
  replay a retried intent and refuse a conflicting reuse. Declared
  exceptions: SCIM (machine API, no client identity), invite claim
  (state-guarded CAS that answers retries honestly), chat and the messages
  agent reply (one actor context is shared across every step of an agent
  loop - a single request-scoped id would false-conflict; job-driven agent
  runs already key receipts by job id), notifications (idempotent read
  receipt on a conflict-protected table, not a domain write).
- Pinned by `GATES-INTENT.md`: postApi unit test, the route-threading sweep
  across 26 routes, the effect-receipts replay/conflict suite, and the repo
  verification gate.

## Remaining W0 work

- Revalidate and reproduce N12–N36 anchors on demand, prioritized by wave (I1/I2 items first).
- Pilot segment/workflow selection (W0.5).

## B03 - worker-kill fixture and external-effect reconciliation (delivered)

`worker-kill.test.ts` kills a worker mid-flight while it holds the lease and
pins what the surviving system owes, per kill window:

- **Killed after the effect and receipt, before the acknowledgement**: the
  replacement worker replays the stored receipt - exactly one effect and one
  audit row, the job completes done, and the revived worker's late
  acknowledgement is fenced by its stale fencing token.
- **Killed mid-execution, before the effect**: the replacement runs fresh and
  completes; when the corpse un-freezes it commits a duplicate effect but its
  acknowledgement is still fenced. The queue's honest promise is
  **at-least-once plus fencing** - mid-flight exactly-once requires
  capability-level idempotency, which external effects get from dedupe keys
  and idempotency-key headers.
- **External webhook whose acknowledgement died in transit**: the provider
  received exactly one call; the next worker pass converges the row to
  `unknown` (never a blind re-fire), the corpse's ack is fenced, and
  `reconcileOutboxMessage` settles it from the provider receipt exactly once.
  A duplicate enqueue of the same dedupe key collapses onto the settled row.

Feeding W1, in dependency order: least-privilege runtime role; B01 route
guards + bootstrap exception; B02 atomic effect/audit receipt (discharges
F01/F02); N09 commit-time ledger enforcement (delivered, ADR 0052); N11
unified document balance.
