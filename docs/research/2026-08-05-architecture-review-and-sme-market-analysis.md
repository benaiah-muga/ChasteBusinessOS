# ChasteBusinessOS — Architecture Review & SME Market Analysis

**Date:** 2026-08-05
**Reviewer:** Principal Software Architect review (independent, adversarial)
**Subject:** ChasteBusinessOS @ commit `31c40e3` (branch `feat/agent-runtime-from-openworker`)
**Scope:** Full monorepo — `apps/{api,web,worker}`, `packages/{kernel,db,ai-core,api-client,ui-schema,config}`, `modules/*`
**Method:** Static review of all source, ADRs, specs, tests, and build state; cross-checked against the project's own invariants in `AGENTS.md` and `ARCHITECTURE.md`. Web research on the SME ERP market (Odoo, ERPNext/Frappe) grounds the competitive analysis.

> This review is deliberately harsh. The codebase shows **genuine architectural talent** in its kernel and AI orchestration — and **dangerous gaps** in its data integrity and authentication that contradict its own stated invariants. Both are documented with file:line evidence.

---

## 0. Executive summary

ChasteBusinessOS is an **AI-native, modular business OS** with an unusually mature *conceptual* architecture for an alpha: a command/query bus with AI/manual parity, a risk-class taxonomy, autonomy gates, an Inbox-based human-attention queue with standing approval rules, conversation modes, prompt-injection guardrails, and a compaction strategy for long context. The documentation (ADRs, specs, AGENTS.md) is **above industry average** for a project this age.

However, the implementation has **two disqualifying reliability defects** for any claim of "trustworthy operations":

1. **No database transactions anywhere in the codebase** (`grep` for `db.transaction` / `.transaction(` returns zero hits). Every command handler writes business data, then an outbox event, then an audit row as **three independent autocommitted inserts**. This directly violates `AGENTS.md` invariant #5 ("Events after commit — use transactional outbox; do not dual-write carelessly") and the Vision's #3 principle ("Reliability over novelty — Transactional integrity and data consistency outrank autonomous cleverness"). A crash or connection blip between inserts produces silent inconsistency: unaudited mutations, phantom events, or orphaned audit rows.
2. **No per-request authentication.** `apps/api` binds a single bootstrap admin user into `app.sessionUser` at startup and runs **every** request as that user. `resolveUserByToken` exists in `packages/db/src/auth.ts` but is **never called** by the server. The entire RBAC, autonomy, and audit machinery therefore operates on one identity — the multi-tenant data model is, at the HTTP boundary, **single-user**. The web client sends no auth headers.

Surrounding these are a 3369-line platform "god module," an in-memory workflow store that loses data on restart, duplicated module wiring between API and worker (with **separate** in-memory state stores that break standing-rule consistency), and a hand-maintained 836-line SQL migration blob that can drift from the Drizzle schema.

**The AI orchestration layer is the strongest part of the codebase** and is the product's real differentiator. The market position (Apache-2.0, AI-native, TypeScript, command-bus-first) is defensible **if** the integrity and auth gaps are closed.

**Would an SME trust this with its entire operations today? No.** The project honestly labels itself "early alpha, not yet recommended for production workloads," and that label is correct. With the immediate fixes in §11, it becomes a *credible* alpha. The competitive analysis (§13) shows a realistic path to SME relevance that does **not** require competing with SAP/Oracle.

---

## 1. What is genuinely good (do not lose this)

Before the critique, the parts worth preserving:

- **Kernel command/query bus** (`packages/kernel/src/command.ts`, `query.ts`): clean, typed, enforces permission checks → Zod validation → handler → output validation → audit, in one place. The `executeCommand` flow is the single mutation surface and it is well-built. (DRY, single-responsibility.)
- **Autonomy + risk model** (`kernel/src/autonomy.ts`, `risk.ts`): orthogonal axes (configured autonomy × command-declared risk × min-autonomy-for-auto) combined with a "strictest gate wins" plan-level reducer (`effectiveAutonomyForPlan`). This is Staff-level safety engineering.
- **Inbox + standing rules** (`kernel/src/inbox.ts`): once-only resolution, idempotent by `(sessionId, toolCallId)`, "allow always" minted against a *scoped target* not a blanket command — the safety floor that makes `email.send → user@x.com always` safe. This is a thoughtful port of OpenWorker's design.
- **AI/manual parity is real**: tools wrap the same `executeCommand` path; AI never touches SQL directly. This invariant is upheld and tested.
- **Web boundary is clean**: `grep` confirms `apps/web/src` imports neither `@chaste/kernel`, `@chaste/db`, nor `@chaste/module`. The "frontend is an API client" invariant holds.
- **Documentation culture**: 9 ADRs, 8+ specs, AGENTS.md with non-negotiable invariants, skills. This is rare and valuable.
- **Typecheck is green** on the pure-TS packages (kernel, config, ui-schema verified).
- **Provider abstraction with timeout** (`ai-core/src/providers.ts`): 30s `AbortController` wall so a stalled NIM model can't hang the workspace forever — a real production concern handled correctly.
- **Prompt-injection guardrail** gated by autonomy (`shouldCheckInjection`) — reasonable, not paranoid-blocking-everything.
- **Compaction with honest fallback** (`ai-core/src/compaction.ts`): LLM summary, but a no-LLM `trimState` fallback "never silent drop" when the summarizer is down.

The talent in this codebase is concentrated in the **AI safety/control plane**. The weakness is concentrated in the **data plane and the HTTP/auth edge**.

---

## 2. Architecture

### Issue ARCH-1 — No per-request authentication; the API is single-user

- **Category:** Architecture / Reliability / Security
- **Severity:** Critical
- **Location:** `apps/api/src/app-context.ts:101-257` (single `sessionUser` bound at boot), `:259-308` (`actorFromSession`/`requestCtx`/`runCommand` all derive from `app.sessionUser`), `apps/api/src/server.ts` (no auth middleware), `packages/db/src/auth.ts:31` (`resolveUserByToken` — unused by server), `apps/web/src/lib/api.ts:14-18` (client sends no auth headers).
- **Explanation:** `createAppContext` resolves one user (the bootstrap admin) and stores it as `app.sessionUser`. Every route calls `runCommand(app, …)` → `requestCtx(app)` → `actorFromSession(app)` → `app.sessionUser`. There is no Fastify `preHandler`/hook that reads a token and resolves a different actor. `resolveUserByToken` exists but the server never invokes it. The web API client supports a `getHeaders()` callback but `getApiClient()` passes none. Result: **all HTTP requests execute as the bootstrap admin**, with admin permissions, regardless of who is at the keyboard.
- **Why this becomes expensive later:** The entire RBAC, autonomy, branch-scoping, audit `actorUserId`, and multi-tenant `organizationId` filtering are **dead weight at the edge** until this is fixed. Every "permission denied" path is untested in production because the single user has admin permissions. The moment real multi-user auth lands, a cascade of latent tenancy-leak bugs (queries omitting `organizationId` filters — see §6) surfaces. Building features on a single-user assumption also models concurrency wrong (`app.workflows`, `app.sessionUser` are mutable singletons shared across requests).
- **Recommended Architecture:** Introduce an `AuthService` that resolves an `Actor` per request from a credential (signed session cookie or `Authorization: Bearer <token>`). Add a Fastify `preHandler` that decorates `req.actor`. Replace `runCommand(app, name, input, reqId)` with `runCommand(app, name, input, req.actor, reqId)`. Remove the singleton `app.sessionUser`; keep only a `bootstrapAdminId` for first-run seeding. Cache resolved permissions per-request (TTL'd), not globally. The `Actor`/`RequestContext` types already support this; only the wiring is missing.
- **Migration Strategy:** (1) Add `req.actor` resolution as a no-op that still returns the admin (tests pass). (2) Wire `resolveUserByToken` behind a `preHandler`, defaulting to admin when no token (dev/legacy). (3) Add `/api/v1/auth/login` issuing a hashed-token session (`hashAuthToken` infra already exists). (4) Update the web client to attach the token via `getHeaders()`. (5) Flip the default to "require token" behind a config flag. (6) Add an E2E test that two users with different permissions get different results.
- **Example Refactor:**
  ```ts
  server.addHook("preHandler", async (req) => {
    const token = extractBearer(req);
    req.actor = token ? await resolveActor(app.db, token) : undefined;
    if (!req.actor) throw new ChasteError("UNAUTHORIZED", "Authentication required", 401);
  });
  server.post("/api/v1/commands/:name", async (req) => {
    const { name } = req.params as { name: string };
    const { input } = z.object({ input: z.unknown().default({}) }).parse(req.body ?? {});
    return runCommandAsActor(app, name, input, req.actor, req.id); // already exists
  });
  ```
- **Trade-offs:** Adds a DB hit per request for token+permission resolution; mitigate with a short-TTL in-process cache keyed by token digest. Strictly necessary — there is no simpler path to multi-user.

### Issue ARCH-2 — No database transactions; every command dual-writes

- **Category:** Architecture / Reliability (data integrity)
- **Severity:** Critical
- **Location:** `packages/kernel/src/command.ts:151-176` (handler runs, then `audit.write` is a separate call), `modules/crm/src/index.ts:182-208` (insert customer → insert interaction → `helpers.outbox.enqueue` — three autocommits), every module's create/update handlers, `packages/db/src/client.ts:7-13`. Confirmed: `grep -rn 'db.transaction|.transaction('` → **0 hits**.
- **Explanation:** `crm.customer.create` performs (1) `db.insert(crmCustomers).returning()`, (2) `db.insert(crmInteractions)`, (3) `helpers.outbox.enqueue(...)` (insert into `outbox_events`), then `executeCommand` calls (4) `helpers.audit.write(...)` (insert into `audit_log`). postgres.js auto-commits each statement — no shared transaction. If (2) fails → customer with no "created" interaction. If (3) fails → customer exists, no event published (silent desync). If (4) fails → **unaudited mutation**, violating the core auditability promise. `AGENTS.md` explicitly forbids this: *"Events after commit — use transactional outbox; do not dual-write carelessly."*
- **Why this becomes expensive later:** Invisible in dev (low traffic, no failures), catastrophic in production (partial writes under load, connection blips, constraint violations). Reconciliation requires outbox replay — which assumes the outbox row exists (it may not). Financial modules (`acc.journal.posted`) with non-atomic journal+event+audit are an accounting-integrity hazard. This is the single highest-priority fix for a product whose Vision principle #3 is "Reliability over novelty."
- **Recommended Architecture:** Thread a transaction through command execution. `CommandHelpers` exposes `tx` instead of bare `db`. Handler writes business data + outbox + audit **inside** `sql.begin(async tx => { … })`. The kernel's `executeCommand` owns the transaction boundary so modules don't reinvent it. The worker reads the outbox *after* commit (the row is only visible post-commit) — correct transactional-outbox semantics.
- **Migration Strategy:** (1) Extend `CommandHelpers` with `tx` and `audit.withTx(tx)`/`outbox.withTx(tx)`. (2) Wrap `def.handler(...)` in `sql.begin` inside `executeCommand`. (3) Update `PostgresAuditWriter`/`PostgresOutboxWriter` to accept an optional `tx`. (4) Update each module handler to use `helpers.tx`. (5) Add a chaos test: throw after the business insert and assert no row survives.
- **Example Refactor:**
  ```ts
  // kernel/src/command.ts — own the transaction boundary
  return await helpers.db.transaction(async (tx) => {
    const txHelpers = { audit: helpers.audit.withTx(tx), outbox: helpers.outbox.withTx(tx) };
    const data = await def.handler(parsed.data, ctx, txHelpers);
    const out = def.output.safeParse(data); if (!out.success) throw new ValidationError(...);
    await txHelpers.audit.write({ /* success */ });
    return { ok: true, data: out.data, command: name, requestId: ctx.requestId };
  });
  // failure path: audit the error OUTSIDE the rolled-back tx
  ```
- **Trade-offs:** Slightly longer lock holding; keep handlers fast. postgres.js `sql.begin` supports nested savepoints. The correctness gain is non-negotiable.


### Issue ARCH-3 — `modules/platform/src/index.ts` is a 3369-line god module

- **Category:** Architecture / Modularity / Bounded contexts
- **Severity:** High
- **Location:** `modules/platform/src/index.ts` (3369 lines, **63 command/query definitions**), `modules/platform/src/{email.ts, backup.ts}` (the only extracted files).
- **Explanation:** One module/file owns: RBAC (`core.role.*`, `core.user.*`), autonomy policy, marketplace (`core.marketplace.*`), module install/uninstall, branches (`core.branch.*`), capability gaps (`core.capability.gap.*`), notifications, reminders, follow-ups, calendar (`core.calendar.*`), email outbox (`core.email.*`), backups (`core.backup.*`), org settings, user preferences, **and** business-partner master data (`core.bpartner.*`). That is **≥8 distinct bounded contexts** in one file — the opposite of the project's own "bounded contexts" and "feature isolation" guidance.
- **Why this becomes expensive later:** Merge conflicts on every cross-cutting change; no team can own a slice; tests are one giant E2E file (`e2e-platform.test.ts` is 1135 lines); adding a platform capability means editing a 3k-line file; reviewers can't hold it in their head ("Can another engineer understand this in 5 minutes?" → no).
- **Recommended Architecture:** Split into cohesive modules, each its own package: `modules/identity` (users, roles, invites), `modules/tenancy` (orgs, branches, access), `modules/autonomy-policy`, `modules/scheduling` (calendar, reminders, follow-ups), `modules/comms` (email, notifications), `modules/backup`, `modules/marketplace` (fill the empty stub), `modules/master-data` (business partners). `platform` becomes a thin aggregator. Each gets its own migration slice and test file.
- **Migration Strategy:** Extract one sub-domain at a time behind the existing command names (no API change). Start with `business-partners` (smallest), then `scheduling`, then `identity`. Keep `createPlatformModule` as a facade until all are extracted, then delete it.
- **Example Refactor:** `modules/master-data/src/index.ts` exports `createBusinessPartnerModule(db): BusinessModule` with the 5 `core.bpartner.*` commands; `app-context.ts` registers it instead of relying on platform.
- **Trade-offs:** More packages to navigate; mitigated by the existing module pattern. The win is ownership and testability.

### Issue ARCH-4 — Duplicated module wiring between API and worker with divergent state stores

- **Category:** Architecture / Coupling / Correctness
- **Severity:** High
- **Location:** `apps/api/src/app-context.ts:146-199` (registers 8 modules + creates `InboxStore`, `WakeStore`, `InMemorySkillStore`), `apps/worker/src/harness.ts:59-103` (registers the **same** 8 modules + creates **separate** `InboxStore`, `WakeStore`, `InMemorySkillStore`).
- **Explanation:** Both hosts independently construct registries and register all eight modules in the same order — adding a module means editing two files (they will drift). Worse, each creates its own `InboxStore`, `WakeStore`, `InMemorySkillStore`. The Inbox holds **standing approval rules** (`allow always` → `email.send → user@x.com`). A rule minted through the API's Inbox is **invisible** to the worker's follow-up harness, which uses a different Inbox. A user who approves "always" via the UI will be **re-prompted** when the same command runs from a scheduled follow-up — a silent inconsistency in the autonomy/safety system the product centers on.
- **Why this becomes expensive later:** Two sources of truth for "what modules are installed" and "what standing rules exist." Every behavioral fix must be applied twice. The in-memory stores also prevent horizontal scaling (ARCH-5) and survival of process restarts.
- **Recommended Architecture:** Extract a single `createRuntime(cfg, db)` factory (new `packages/runtime` or in `ai-core`) that builds registries + modules + stores **once**. Both `apps/api` and `apps/worker` consume it. Replace the in-memory stores with their Postgres-backed counterparts — the schema for `pending_approvals`, `ai_wakes`, `ai_skills` already exists per the code comments — so state is shared and durable across processes.
- **Migration Strategy:** (1) Create `createRuntime` and have `app-context` delegate to it. (2) Point the worker at the same factory. (3) Implement `PostgresInboxStore`/`PostgresWakeStore`/`PostgresSkillStore` against the existing tables; swap via the interface. (4) Delete the duplicated registration blocks.
- **Trade-offs:** A shared factory reduces host-specific customization; keep host-specific bits (Fastify vs. worker loop) as thin adapters. The durability win is essential for the autonomy guarantees to be real.


### Issue ARCH-5 — Workflows stored in an in-memory `Map`; DB tables exist but are unused

- **Category:** Architecture / Reliability / Scalability
- **Severity:** High
- **Location:** `apps/api/src/app-context.ts:255` (`workflows: new Map()`), `apps/api/src/server.ts:575-626` (workflow CRUD reads/writes `app.workflows`), `packages/db/src/schema.ts:944-980` (`workflow_definitions` and `workflow_runs` tables — **never written to by the server**).
- **Explanation:** `POST /api/v1/workflows` does `app.workflows.set(input.id, input)`; `GET /:id` does `app.workflows.get(id)`. This is a process-local `Map`. An API restart **loses every workflow**. The schema already has `workflow_definitions`/`workflow_runs` tables with proper indexes — they are dead. Two API instances (horizontal scale) see **different** workflow sets.
- **Why this becomes expensive later:** Silent data loss on redeploy is a trust killer for an "operating system for your business." A user who builds a "Get Paid" automation via NL and returns the next day finds it gone. The schema/usage mismatch also misleads contributors.
- **Recommended Architecture:** Persist workflows to `workflow_definitions`; runs to `workflow_runs`. Add `core.workflow.*` commands (create/list/get/run) so AI and humans use the bus. The engine (`ai-core/src/workflows/engine.ts`) already executes from a `WorkflowDefinition` — just source it from the DB.
- **Migration Strategy:** (1) Add `workflow.list/get/create` queries/commands backed by the tables. (2) Re-point the server endpoints at the commands (or delete the bespoke endpoints in favor of generic routes). (3) Add an integration test asserting a workflow survives a context rebuild.
- **Trade-offs:** None of substance — this is a "finish what was started" task.

### Issue ARCH-6 — Dead/abandoned modules and duplicate command-name definitions

- **Category:** Architecture / Code quality (dead code, DRY)
- **Severity:** Medium
- **Location:** `modules/core-system/src/index.ts` (defines `core.modules.list`, **not registered** in `app-context.ts`), `modules/marketplace/` (empty `src/` dir, no `index.ts`), `modules/demo-crm/src/index.ts` (defines `crm.customer.create`/`crm.customer.list` — **duplicate names** of the real `modules/crm`), `modules/platform/src/index.ts` (also defines `core.modules.list` — duplicate of core-system).
- **Explanation:** `core-system` is documented in the README ("Always-on system queries") but is never registered; the platform module defines the same `core.modules.list` query. `demo-crm` redefines `crm.customer.*` — registering both `crm` and `demo-crm` would make `createCommandRegistry.register` throw `Command already registered` at boot. `modules/marketplace` is an empty scaffold. These are landmines and doc/code drift.
- **Why this becomes expensive later:** A contributor following the README will look for `core-system` and find it isn't wired. Registering `demo-crm` for a demo will crash the server. Dead scaffolding rots and confuses onboarding.
- **Recommended Architecture:** Register `core-system` (and remove the duplicate `core.modules.list` from platform) **or** delete it and update the README. Delete `demo-crm` or rename its commands to a `demo.` namespace. Delete the empty `modules/marketplace` or fill it (belongs to the ARCH-3 split).
- **Migration Strategy:** One PR to remove dead code, one to fix the README. Add a boot-time test asserting no duplicate command names across **all** modules (not just registered ones).
- **Trade-offs:** Deleting demo-crm loses a contributor reference; keep it as a `docs/` example instead of a live module.

### Issue ARCH-7 — Hand-maintained 836-line SQL migration blob diverges from Drizzle schema

- **Category:** Architecture / Reliability (schema management)
- **Severity:** Medium
- **Location:** `packages/db/src/migrate.ts` (836-line `const sql` using `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN IF NOT EXISTS`), `packages/db/src/schema.ts` (Drizzle source of truth for types), `package.json` `db:generate` (exists but is not the migration path).
- **Explanation:** Migrations are a single idempotent SQL string — not versioned, no down path, no migration-history table. The Drizzle `schema.ts` is the type source of truth but the **actual DDL** is hand-written and can drift: adding a column requires editing **both** files. There is no `schema_migrations` table tracking applied versions, so "is this DB up to date?" is unanswerable.
- **Why this becomes expensive later:** Schema drift between types and DDL causes runtime errors (`column does not exist`) that pass typecheck. No versioning means no safe rollback and no ordered application in CI. For a product that must support self-hosters with their own DBs, this is a serious operability gap.
- **Recommended Architecture:** Adopt Drizzle's generated migration workflow as the source of truth: edit `schema.ts`, run `pnpm db:generate` to produce versioned SQL files in `packages/db/src/migrations/`, apply via Drizzle's migrator with a `__drizzle_migrations` history table. Keep `migrate.ts` as a thin runner. This makes `schema.ts` the single source of truth (DRY) and gives ordered, reviewable, reversible migrations.
- **Migration Strategy:** (1) Generate the baseline migration from the current schema. (2) Verify the generated SQL matches the hand-written blob (diff and reconcile). (3) Cut over `db:migrate` to the Drizzle migrator. (4) Archive the old blob.
- **Trade-offs:** Drizzle migrations are less "magically idempotent" than `IF NOT EXISTS` everywhere; that's a feature (explicit, ordered, reviewable).


### Issue ARCH-8 — Bespoke REST routes duplicate the generic command/query surface

- **Category:** Architecture / Consistency (DRY)
- **Severity:** Medium
- **Location:** `apps/api/src/server.ts:93-148` (business-partners CRUD), `:224-270` (CRM convenience routes), `:537-559` (settings/preferences), vs the generic `:150-160` (`POST /api/v1/commands/:name`, `/queries/:name`).
- **Explanation:** `AGENTS.md` says *"API route only if intentionally public; prefer generic command/query routes when possible."* In practice there are ~30 bespoke REST endpoints that each thin-wrap a command/query. This creates two surfaces for every operation and doubles validation responsibility (the bespoke route re-parses with its own Zod, then the command re-parses).
- **Why this becomes expensive later:** Every new command sparks a debate: bespoke route or generic? Drift between the two (bespoke route accepts `search` as a raw string, generic requires `{input}`). More routes = more HTTP surface to secure/version/document.
- **Recommended Architecture:** Keep a **small** set of bespoke routes only where they add real value (file uploads, streaming, signed webhooks like the Buzz bridge). For everything else, expose the generic `/commands/:name` and `/queries/:name` and let the web client + AI use them uniformly. If DX demands typed REST, **generate** the bespoke routes from the command/query registry metadata (a route generator) so there's one source of truth.
- **Migration Strategy:** Migrate the web client to the generic routes first (the api-client already has the types), then delete redundant bespoke routes. Keep a route generator as a later optimization.
- **Trade-offs:** Generic routes are slightly less ergonomic for ad-hoc curl; acceptable for a product whose primary clients are the web app + AI.

### Issue ARCH-9 — Worker is a naive poll loop with no concurrency safety or dead-letter queue

- **Category:** Architecture / Reliability / Scalability
- **Severity:** Medium
- **Location:** `apps/worker/src/index.ts:136-178` (`listUnprocessed(50)` → process → `markProcessed`), `packages/db/src/adapters.ts:53-60` (`listUnprocessed` has no `FOR UPDATE SKIP LOCKED`), `apps/worker/src/index.ts:175-177` (comment: *"Always mark processed — failed events are logged, not re-queued. For production: add a dead-letter queue"*).
- **Explanation:** Two worker processes polling `listUnprocessed` will **both** fetch the same 50 rows and double-process them (handlers are "idempotent by contract" — asserted, not enforced; side effects like email send are not safely idempotent). Failed events are marked processed and dropped — **data loss** acknowledged in a comment. No `error_count`, no DLQ, no exponential backoff beyond `retryDelayMs * attempt`. Redis/BullMQ is in the stack list and docker-compose but **unused**.
- **Why this becomes expensive later:** Horizontal worker scaling is broken until `SKIP LOCKED` is added. Lost events mean a customer-created notification silently never sends. The "idempotent by contract" claim is load-bearing and untested.
- **Recommended Architecture:** Add `FOR UPDATE SKIP LOCKED` to `listUnprocessed` (claim-then-process-then-ack). Add `attempts` and `last_error` columns to `outbox_events`; route `attempts >= maxRetries` to a `dead_letter_events` table. Introduce BullMQ for scheduled/follow-up jobs (the docker-compose Redis is already there) so the poll loop isn't doing both event drain *and* reminder firing in one `tick()`.
- **Migration Strategy:** (1) `SKIP LOCKED` + claim column — small, high-value. (2) DLQ table + retry counter. (3) Move reminders/follow-ups to BullMQ scheduled jobs. (4) Keep the outbox drain on a short poll (or Postgres `LISTEN/NOTIFY`).
- **Trade-offs:** `SKIP LOCKED` needs Postgres ≥9.5 (fine — pg16 in use). BullMQ adds an operational dependency — justified at scale, optional early.


---

## 3. Code quality

### Issue CQ-1 — DTO schemas duplicated between modules and `api-client` (DRY violation)

- **Category:** Code quality / DRY
- **Severity:** Medium
- **Location:** `modules/crm/src/index.ts:8-36` (`customerSchema`, `contactSchema`, `interactionSchema`) redefined in `packages/api-client/src/index.ts:28-59`. `packages/api-client/src/index.ts:61-130` also re-declares `MessagingThreadSummary`, `EmailOutboxRow`, `BackupRow` as plain TS types (not Zod), drifting from the server's actual output schemas.
- **Explanation:** Output schemas live in modules (server-side) and are re-typed by hand in `api-client` (client-side). The two drift: a new server field won't surface on the client until someone updates both. Worse, `api-client` types many DTOs as plain `type` aliases with no Zod schema, so the client cannot *validate* responses — it only trusts them.
- **Why this becomes expensive later:** Silent client/server contract drift → runtime `undefined` field bugs that typecheck passes. Every module author must know to update a second package.
- **Recommended Architecture:** Define canonical Zod output schemas **once** in a shared `@chaste/contracts` package (or expand `@chaste/api-client` to import modules' exported schemas). Modules export their output schemas; `api-client` re-exports and `parse`s responses. The "frontend is an API client" invariant is preserved (contracts has no DB/kernel imports — only Zod).
- **Migration Strategy:** (1) Have each module export its output Zod schemas. (2) Move them into `@chaste/api-client` (or a new `@chaste/contracts`). (3) Replace hand-typed DTOs with `z.infer<typeof …>`. (4) Parse responses client-side.
- **Trade-offs:** A contracts package is one more node; it's the right place for boundary types (Hexagonal "port" types).

### Issue CQ-2 — Query/path params use `as` type assertions instead of Zod

- **Category:** Code quality / Anti-pattern (violates own invariant)
- **Severity:** Medium
- **Location:** `apps/api/src/server.ts:95-99` (`req.query as { search?: string; … }`), `:226-230`, and every `req.params as { id: string }` (`:128, :132, :146, :257, :261, :600`).
- **Explanation:** `AGENTS.md` invariant #4: *"Zod validates intent and payloads at boundaries (HTTP, commands, chat UI parts)."* The HTTP boundary validates **bodies** with Zod but casts **query and path params** with `as`. A malformed `?type=<script>` passes straight through (only saved by the command's own Zod). Path params aren't UUID-validated at the edge.
- **Why this becomes expensive later:** Inconsistent validation surface; easy to ship a route that trusts `req.query` and passes garbage to a query expecting typed input. Type assertions silence the compiler — a renamed query param won't error.
- **Recommended Architecture:** Use Fastify schema validation or a small `z.object({ … }).parse(req.query)` helper applied uniformly. Validate path params (`z.string().uuid()`). One `parseQuery`/`parseParams` helper, used everywhere. Add a lint rule banning `req.query as` / `req.params as`.
- **Migration Strategy:** Add helpers; convert routes incrementally; add the lint rule.
- **Trade-offs:** Minor per-route verbosity; large correctness/consistency win.

### Issue CQ-3 — Magic values not config-driven

- **Category:** Code quality / Magic values
- **Severity:** Low
- **Location:** `packages/db/src/client.ts:10-11` (`max: 10` pool), `packages/ai-core/src/providers.ts:78` (`max_tokens: 1024`), `:37` (`AI_TIMEOUT_MS = 30_000`), `packages/ai-core/src/orchestrator.ts:828` (`AGENT_TOOL_MAX_ITERATIONS = 3`), `apps/api/src/server.ts:629` (audit limit `100`), `apps/worker/src/index.ts:25-27` (poll `5_000`, batch `50`, retries `3`).
- **Explanation:** Operational knobs are hard-coded. A DB pool of 10 is fine for dev, wrong for a 200-user SME. `max_tokens: 1024` will truncate complex multi-step plans and compaction summaries. The 30s AI timeout and 3-iteration tool loop are reasonable defaults but should be tunable per-deployment.
- **Why this becomes expensive later:** Every tuning change is a code change + redeploy instead of an env var. Self-hosters can't right-size without forking.
- **Recommended Architecture:** Move these into `@chaste/config` (`db.poolMax`, `ai.maxTokens`, `ai.timeoutMs`, `ai.toolMaxIterations`, `worker.pollMs`, `worker.batchSize`, `audit.defaultLimit`). Keep code defaults, override via env.
- **Migration Strategy:** Add config fields (current values as defaults); reference them at call sites.
- **Trade-offs:** Slightly larger config surface; justified for an operable product.


### Issue CQ-4 — `row!` non-null assertions throughout handlers

- **Category:** Code quality / Code smell (runtime safety)
- **Severity:** Low
- **Location:** `modules/crm/src/index.ts:195` (`row!.id`), `:208`, and pervasive across every module's `.returning()` calls.
- **Explanation:** `.returning()` returns `T[]`; `const [row] = await … .returning()` gives `row | undefined`, then `row!.id` asserts non-null. If the insert returns nothing (possible with `onConflict do nothing`, or a driver quirk), this throws an opaque `cannot read 'id' of undefined` instead of a typed `NotFoundError`. `noUncheckedIndexedAccess` is already enabled in `tsconfig.base.json` — honor it with a helper, not `!`.
- **Why this becomes expensive later:** Error messages that don't name the failing operation; defensive code scattered ad hoc.
- **Recommended Architecture:** A `returningOne(query, commandName)` helper that throws `NotFoundError` with the command name if empty. Centralizes the pattern and the diagnostic.
- **Migration Strategy:** Add the helper in `@chaste/db`; migrate handlers incrementally.
- **Trade-offs:** One helper to learn; much better failure diagnostics.

### Issue CQ-5 — `console.log`/`console.error` as the observability layer

- **Category:** Code quality / Observability
- **Severity:** Medium
- **Location:** `apps/worker/src/index.ts` (15 uses), `packages/kernel/src/outbox.ts:78-179` (every `builtinHandler` is a `console.log(JSON.stringify(...))`), `modules/platform/src/{index.ts,email.ts}` (2), `apps/worker/src/{cli-restore.ts,buzz.ts}`.
- **Explanation:** No structured logging library, no log levels beyond Fastify's built-in `server.log`, no metrics (no Prometheus/OpenTelemetry), no tracing beyond optional Langfuse for LLM calls only. The README's "Observable stack" bullet overstates reality: observability is LLM-call tracing + ad-hoc `console.log` JSON lines. The `builtinHandlers` only log — they don't *do* anything (notifications, webhooks are stubs).
- **Why this becomes expensive later:** In production you cannot filter by level, correlate a request across API→worker→LLM, or alert on error rate. For a product selling auditability and reliability, thin observability undercuts the claim.
- **Recommended Architecture:** Adopt `pino` (Fastify already uses it internally) as the process logger with child loggers carrying `requestId`/`organizationId`/`actorUserId`. Add OpenTelemetry traces for command execution + outbox processing. Replace `builtinHandlers`' `console.log` with real dispatch (the `notifications` table already exists) and a `pino` log. Expose `/metrics` for Prometheus.
- **Migration Strategy:** (1) Swap `console.log` → child logger. (2) Wire OpenTelemetry for the command bus span. (3) Make `builtinHandlers` actually notify. (4) Add a metrics endpoint.
- **Trade-offs:** pino is already transitively present via Fastify; OpenTelemetry is opt-in.


---

## 4. Scalability

### Issue SC-1 — Single shared DB pool, hard-coded to 10; no read/write split

- **Category:** Scalability / Database access
- **Severity:** Medium
- **Location:** `packages/db/src/client.ts:7-13` (`postgres(…, { max: 10 })`), one `Db` instance per process shared across all requests + the worker's follow-up harness.
- **Explanation:** One connection pool of 10 for the entire API process. No `pool_max`/`pool_min`/`idle_timeout` config. No read replica support. Under concurrent SME load (a few dozen users + AI turns issuing multiple queries each), 10 connections saturate and requests queue.
- **Why this becomes expensive later:** Connection starvation manifests as random latency spikes and `too many clients` errors under load — the worst kind of production bug (intermittent, load-dependent).
- **Recommended Architecture:** Make pool size configurable (`DB_POOL_MAX`, default scaled to CPU). Support a read-only `Db` for queries (Postgres replicas) and a primary `Db` for commands. Document `pgbouncer` in transaction-pooling mode for self-hosters.
- **Migration Strategy:** Config field → reference at `createDb`. Add a `createReadOnlyDb` for query handlers later.
- **Trade-offs:** Read replicas add operational complexity (replication lag); optional, behind a config flag.

### Issue SC-2 — No caching layer; Redis configured but unused

- **Category:** Scalability / Caching
- **Severity:** Medium
- **Location:** `packages/config/src/index.ts:29` (`redisUrl` parsed but never consumed), `apps/api/src/app-context.ts:127` (permissions resolved once at boot into `sessionUser` — part of the single-user problem).
- **Explanation:** No caching anywhere: module manifests, command/query metadata, permission sets, and frequently-read settings are re-fetched or re-resolved. Redis is in docker-compose and parsed in config but **no code imports a Redis client**. Permissions are "cached" only because they're read once for the single admin — which disappears the moment per-request auth (ARCH-1) lands, at which point every request re-resolves permissions from the DB (2 joins).
- **Why this becomes expensive later:** After ARCH-1, permission resolution becomes a per-request DB hit. Without caching, that's meaningful overhead at scale.
- **Recommended Architecture:** A `PermissionCache` (TTL 30-60s, invalidated on role change via an outbox event) in front of `resolveUserPermissions`. Cache module/manifest metadata in-process (immutable per boot). Use Redis for cross-process session/inbox state (ties into ARCH-4's Postgres-backed stores).
- **Migration Strategy:** (1) In-process `PermissionCache` with TTL + outbox-driven invalidation. (2) Later, Redis-backed shared cache for multi-instance.
- **Trade-offs:** Cache invalidation correctness (role-change events must invalidate); worth it.


