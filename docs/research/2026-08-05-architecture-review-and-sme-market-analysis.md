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


### Issue SC-3 — ~7 tenant tables lack an `organization_id` index

- **Category:** Scalability / Database indexing
- **Severity:** Low-Medium
- **Location:** `packages/db/src/schema.ts` — 42 tables carry `organization_id`; 35 org-index definitions (12 unique). The gap (~7 tables) means some tenant tables do sequential scans filtered by org.
- **Explanation:** Most tenant tables are indexed by `organization_id` (good), but not all. As any single tenant's data grows, an unindexed org filter becomes a full scan across **all tenants'** rows — both a performance and a tenancy-isolation smell.
- **Why this becomes expensive later:** Latency grows with total system rows, not per-tenant rows. The fix is cheap now and expensive later (online `CREATE INDEX CONCURRENTLY` on a big table).
- **Recommended Architecture:** Audit every `pgTable` with `organization_id`; ensure a composite index `(organization_id, <common filter>)`. Add a CI test asserting no tenant table lacks an org index.
- **Migration Strategy:** One PR adding the missing indexes + the CI assertion.
- **Trade-offs:** Marginal write-time cost; essential for multi-tenant scale.

### Issue SC-4 — In-memory runtime stores block horizontal scaling

- **Category:** Scalability / Statelessness
- **Severity:** High (ties to ARCH-4/5)
- **Location:** `apps/api/src/app-context.ts:197-199,255` (`InboxStore`, `WakeStore`, `InMemorySkillStore`, `workflows: Map`).
- **Explanation:** The API process holds session-adjacent state (inbox approvals, self-wakes, skills, workflows) in process memory. A second API instance has none of it. Load-balancing across >1 API replica is broken for any feature that touches these stores — a hard ceiling on scale and a single point of failure.
- **Why this becomes expensive later:** The product cannot run more than one API replica safely.
- **Recommended Architecture:** Move all of these to Postgres (tables exist) or Redis. The kernel interfaces (`InboxStore`, `WakeStore`, `SkillStore`) are already abstract — only the implementations need swapping. Same fix as ARCH-4.
- **Migration Strategy:** Implement `PostgresInboxStore`/`PostgresWakeStore`/`PostgresSkillStore`; swap; keep in-memory versions for tests.
- **Trade-offs:** One more DB round-trip per inbox/wake op; acceptable and correct.


---

## 5. Reliability

### Issue REL-1 — No retry/circuit-breaker on AI provider beyond a 30s timeout

- **Category:** Reliability / Resilience
- **Severity:** Medium
- **Location:** `packages/ai-core/src/providers.ts:62-90` (single `fetch` with `AbortController` timeout; on non-2xx it throws the body text; no retry, no backoff, no circuit breaker).
- **Explanation:** A transient 503 from the LLM gateway fails the user's turn immediately. The orchestrator's compaction path catches summarizer failures gracefully (`orchestrator.ts:309`), but the main chat turn does not degrade — it surfaces a raw error. No retry for idempotent completions.
- **Why this becomes expensive later:** LLM gateways (NIM, OpenAI) have real outage/transient-error rates. Without retry, every blip is a user-visible failure of the product's primary interface (chat).
- **Recommended Architecture:** Wrap `complete()` with exponential-backoff retry (2-3 attempts) for transient HTTP statuses (429/5xx) and network errors; a circuit breaker that short-circuits to `NoneProvider` (rule-based) after N consecutive failures so the UI stays responsive during an outage. Log+trace each attempt.
- **Migration Strategy:** Add a `retryingComplete` wrapper in `providers.ts`; wire into `createAiProvider`. Keep the timeout.
- **Trade-offs:** Retries add latency on failure; bound total wait. Worth it for the primary interface.

### Issue REL-2 — Failed outbox events are silently dropped (data loss)

- **Category:** Reliability / Fault tolerance
- **Severity:** High (ties to ARCH-9)
- **Location:** `apps/worker/src/index.ts:160-177` (after retries exhausted, `await outbox.markProcessed(event.id)` regardless of success — the failed event is gone).
- **Explanation:** A permanently-failing event (e.g. an email send whose provider rejects the payload) is marked processed and disappears. No DLQ, no `failed_events` table, no operator alert. For a product whose value prop includes "notifications, webhooks, schedule fires," silent loss of an event is a silent failure of a business commitment.
- **Why this becomes expensive later:** An SME's "invoice overdue" reminder that fails to send is a real cash-flow impact discovered too late.
- **Recommended Architecture:** Add `attempts` and `last_error` to `outbox_events`; after `maxRetries`, set `status='dead'` (or move to `dead_letter_events`) and emit a `core.notification` for the org admin. Provide a `core.outbox.replay` command for operators.
- **Migration Strategy:** (1) Add columns + DLQ table. (2) Worker dead-letters instead of mark-processed. (3) Surface dead-lettered events in UI/audit.
- **Trade-offs:** Requires operator tooling to replay; that's correct — failures should be visible, not hidden.

### Issue REL-3 — Audit endpoint is hardcoded to 100 rows, no pagination

- **Category:** Reliability / Auditability
- **Severity:** Medium
- **Location:** `apps/api/src/server.ts:628-640` (`app.audit.list(orgId, 100)`), `packages/db/src/adapters.ts:28-35` (`list(organizationId, limit = 100)` — no cursor, no offset, no time filter).
- **Explanation:** The audit trail — the product's core trust mechanism — returns only the 100 most recent entries. An operator investigating "what happened last Tuesday" cannot page back. No filter by action/actor/success/time-range. For an auditability-first product this is inadequate.
- **Why this becomes expensive later:** Compliance (and plain incident response) requires queryable, paginated, filterable audit history. A 100-row window is a demo, not an audit log.
- **Recommended Architecture:** Keyset (cursor) pagination on `(occurred_at, id)`; filters by `actorUserId`, `action`, `success`, time range; a `core.audit.query` command with permission `core.audit.read`. Add append-only audit export (CSV/JSONL) for compliance.
- **Migration Strategy:** (1) Add cursor + filters to `PostgresAuditWriter.list`. (2) Expose a `core.audit.query` query + paginated UI. (3) Add an export endpoint.
- **Trade-offs:** Keyset pagination is slightly more complex than offset; it's correct under concurrent inserts.


---

## 6. Performance

### Issue PERF-1 — Multi-step in-memory state copies in the orchestrator

- **Category:** Performance / Memory
- **Severity:** Low
- **Location:** `packages/ai-core/src/orchestrator.ts:1010-1013` (`session = { ...input.session, messages: [...input.session.messages] }`) and repeated session spread/copy on each turn; compaction `estimateTokens` iterates all messages per trigger.
- **Explanation:** The orchestrator defensively clones the session and message array on every turn and re-estimates token counts by walking the whole history. With long chat histories (the compaction subsystem explicitly targets long context), this is repeated O(n) work and allocation per turn.
- **Why this becomes expensive later:** Long-running sessions with hundreds of messages become slower and heavier per turn. Minor at SME volumes, but the chat hot path should be efficient.
- **Recommended Architecture:** Reserve copying for the boundaries (persist/save) rather than per-turn; make `estimateTokens` incremental (track a running token delta on append) instead of rescanning; memoize the compaction trigger check unless a message was appended.
- **Migration Strategy:** (1) Memoize token estimate with an append-delta. (2) Avoid full array clone every turn; clone only when mutating. (3) Add a micro-benchmark guard.
- **Trade-offs:** Slightly more careful state mutation; no API change.

### Issue PERF-2 — `max_tokens: 1024` caps generation; risks truncated plans

- **Category:** Performance / Correctness
- **Severity:** Medium
- **Location:** `packages/ai-core/src/providers.ts:78` (`max_tokens: 1024`).
- **Explanation:** A hard 1024-token output cap for all completions. Complex multi-step plans, compaction summaries, and long explanations (which this product intentionally produces via the harness) can exceed 1024 output tokens, truncating mid-JSON or mid-plan — a silent correctness risk for tool calls and plans.
- **Why this becomes expensive later:** Truncated tool-call JSON breaks the bounded tool loop; truncated summaries lose business context.
- **Recommended Architecture:** Make `max_tokens` configurable per call purpose (plan/summary/chat) with a sane default (2K-4K) and provider-agnostic truncation handling (validate returned tool-call JSON; retry with a raised cap or explicit error on truncation).
- **Migration Strategy:** Config field (`ai.maxTokens`) + per-call override; detect `finish_reason: 'length'` (when the provider exposes it) and handle explicitly.
- **Trade-offs:** Longer generations cost more tokens and latency; bound per purpose.


---

## 7. Developer experience

### Issue DX-1 — Tests are E2E-heavy; six modules have no dedicated unit tests

- **Category:** DX / Testing
- **Severity:** Medium
- **Location:** Coverage is dominated by E2E: `orchestrator.e2e.test.ts` (2128), `e2e-platform.test.ts` (1135), `e2e-lifecycle.test.ts` (850). `modules/{accounting,inventory,purchasing,hr,manufacturing,crm}` have **no** dedicated `*.test.ts` — only covered indirectly through API E2E suites (`apps/api/src/e2e-*.test.ts`).
- **Explanation:** A 2128-line E2E and a 1135-line E2E are hard to read, slow, and flaky-sensitive (they spin up Postgres). Core business rules (CRM lifecycle `TRANSITIONS` in `modules/crm/src/index.ts:56-66`, accounting journal posting) lack fast unit tests. The kernel IS well unit-tested (command, autonomy, risk, inbox) — the modules are not.
- **Why this becomes expensive later:** Slow, brittle tests get skipped; module logic regressions surface only in full E2E. Fast unit tests on pure logic (state machines, validation, mapping) catch the same bugs in milliseconds.
- **Recommended Architecture:** Extract pure/predictable module logic (lifecycle transition maps, schedule parsers, template renderers) into testable functions and unit-test them. Keep E2E as a thin smoke layer. Add a module-contract test per module (AGENTS.md asks for "Contract test for the command") validating registered commands/queries/schemas/permissions.
- **Migration Strategy:** (1) Add `modules/crm/src/index.test.ts` covering transitions + a contract test. (2) Repeat per module. (3) Add a shared helper asserting every module's commands have Zod schemas + permissions + audit coverage.
- **Trade-offs:** More test files; faster feedback and a safety net for the ARCH-3 module split.

### Issue DX-2 — Excellent docs; but code/doc drift and untracked tech debt

- **Category:** DX / Documentation
- **Severity:** Low
- **Location:** Documentation culture is strong, but: `core-system` is documented but unregistered (ARCH-6); README lists stub modules; there is **one** `TODO/FIXME` in the entire source tree (debt lives in prose comments like "For production: add a dead-letter queue").
- **Explanation:** A `grep TODO` count of 1 in an alpha is a red flag: either astonishingly complete or debt is undocumented. Given the proven gaps (ARCH-2 transactions, ARCH-1 auth), debt is being left in prose comments rather than as trackable work items.
- **Why this becomes expensive later:** Debt that isn't tracked never gets scheduled, and its cost compounds silently.
- **Recommended Architecture:** Add a `docs/tech-debt.md` backlog seeded from this review; adopt `TODO(owner)` conventions; run `grep` CI to fail on unbudgeted TODOs; keep README/ADRs in sync with reality (register or delete core-system).
- **Migration Strategy:** Seed the backlog; fix README/core-system drift; add a doc-sync step to the module checklist.
- **Trade-offs:** Minimal; improves trust in the docs.

### Issue DX-3 — Good DX where it matters: green typecheck, clean boundary

- **Category:** DX / Positive
- **Severity:** n/a
- **Location:** `tsconfig.base.json` (strict + `noUncheckedIndexedAccess`), `pnpm typecheck` green on kernel/config/ui-schema (verified), clean `apps/web` boundary, `vitest.workspace.ts` present.
- **Explanation:** Monorepo conventions are sound and typecheck is clean. The "web never imports kernel/db" invariant holds. Genuine onboarding strengths.
- **Recommended Architecture:** Formalize the boundary with ESLint import restrictions (`import/no-restricted-paths`) so the convention can't silently break — enforcement beats convention.
- **Migration Strategy:** Add the ESLint rule.
- **Trade-offs:** None — enforcement beats convention.


---

## 8. AI-specific design

This is the strongest area of the codebase. The orchestration is thoughtful and materially better than "LLM + a few tools." Findings below are refinements, not rewrites.

### Issue AI-1 — Text-only provider; tools parsed from JSON instead of native function calling

- **Category:** AI / Tool abstraction / Reliability
- **Severity:** Medium
- **Location:** `packages/ai-core/src/providers.ts` (interface is `complete() -> text`), `packages/ai-core/src/orchestrator.ts:805-816` (tools surfaced in the prompt; the model returns `{"toolCall":{...}}` embedded in JSON, parsed and executed in a bounded loop).
- **Explanation:** The provider is text-only (OpenWorker-style): tool calls are emitted inside the assistant's text as JSON and parsed by the orchestrator. No native OpenAI `tools`/`tool_calls`. This works, but parsing tool-call JSON out of free text is strictly less reliable than structured tool calls: malformed JSON can abort a turn, and it burns output tokens duplicating tool schemas in the prompt every turn.
- **Why this becomes expensive later:** As tool count grows (63 platform commands + others), the per-turn prompt catalog expands and parsing fragility increases. Native function calling gives the model a hard schema and the platform a hard parse.
- **Recommended Architecture:** Add an optional `completeWithTools(req, tools)` to `AiProvider` that maps to native `tool_calls` when supported (OpenAI-compatible), falling back to the text+JSON path for providers that don't (Ollama/NIM variants). Keep the bounded loop. Generate OpenAI tool JSON from the Zod input schemas already in the registries.
- **Migration Strategy:** (1) Provider capability flag (`supportsFunctionCalling`). (2) Implement native path for `openai`/`openai_compatible`. (3) Keep text path as fallback. (4) Eval both paths on the golden-dialogue suite.
- **Trade-offs:** More provider surface; justified by reliability. The bounded-loop cap (`AGENT_TOOL_MAX_ITERATIONS`) stays regardless.

### Issue AI-2 — No streaming; single-shot completions only

- **Category:** AI / Streaming / UX
- **Severity:** Medium
- **Location:** `packages/ai-core/src/providers.ts` (`complete()` returns a full text blob; no `stream`), despite VISION naming streaming as a goal and the ChatWidget expecting turn-based responses.
- **Explanation:** Every AI turn waits for the *entire* completion. For an AI-primary product, long generations (multi-step plans, long explanations) create a dead screen. This undercuts the "AI-native" pitch.
- **Why this becomes expensive later:** Retrofitting streaming into a text-only abstraction touches providers, orchestrator, API routes, and the web client — the harder the orchestration grows, the costlier the retrofit.
- **Recommended Architecture:** Add `stream(req): AsyncIterable<Delta>` to `AiProvider` (SSE from API to web). Keep `complete()` as a convenience. The orchestrator emits token deltas while still validating tool calls.
- **Migration Strategy:** (1) Implement `stream` in `OpenAiCompatibleProvider`. (2) Expose `POST /api/v1/ai/chat?stream=1` as SSE. (3) Render deltas in ChatWidget. (4) Keep non-stream path for tests.
- **Trade-offs:** More moving parts; big UX win for an AI-first product.

### Issue AI-3 — Prompt/tool catalog grows per turn; context budget pressure

- **Category:** AI / Context management
- **Severity:** Medium
- **Location:** `packages/ai-core/src/orchestrator.ts:830-844` (`agentToolList`), skill catalog text injected per turn (`skills.ts`), compaction (`compaction.ts`).
- **Explanation:** The agent tool catalog + skill catalog + system prompt are injected into every turn. With 60+ commands and growing, the static context grows, pushing more turns into compaction — and the tool catalog isn't included in the compaction budget.
- **Why this becomes expensive later:** Token cost and latency scale with catalog breadth. The catalog should be *selective* (relevant-tools-only) rather than exhaustive.
- **Recommended Architecture:** Implement **selective tool routing**: pre-filter the tool catalog by the session's specialist tags + a cheap relevance classifier, exposing only plausible tools (the `specialists()` registry is designed for this). Budget the tool catalog in the compaction token estimate.
- **Migration Strategy:** (1) Route by `specialist.toolTags` per session turn. (2) Add a relevance prefilter. (3) Include catalog size in `estimateTokens`. (4) Eval p95 context under budget.
- **Trade-offs:** Risk of hiding a needed tool; keep a "search tools" escape and conservative filtering. The gap-ticket flow already mitigates "tool not found."


### Issue AI-4 — Model routing (support vs plan vs customize) is roadmap, not implemented

- **Category:** AI / Model routing
- **Severity:** Low
- **Location:** `apps/api/src/app-context.ts:151` (single `provider` for everything), `docs/product-architecture-next.md:642` (multi-model routing is Horizon C).
- **Explanation:** One provider/model serves chat, planning, workflow-building, and compaction. The docs acknowledge this is future work; the `AiProvider` abstraction already permits multiple instances but isn't used that way.
- **Why this becomes expensive later:** Fine to defer, but the `createRuntime` refactor (ARCH-4) should accept a *set* of providers keyed by role so routing slots in without re-plumbing.
- **Recommended Architecture:** Inject `{ support, plan, compact, customize }: AiProvider` (all default to one) in `createRuntime`; wire selection at call sites as routing becomes available.
- **Migration Strategy:** Change `OrchestratorDeps`/runtime shape to accept role-keyed providers; keep defaults.
- **Trade-offs:** Slightly larger wiring now; avoids a painful retrofit later.

### Issue AI-5 — Memory recall is "active tool" only; passive recall not fully wired

- **Category:** AI / RAG / Memory design
- **Severity:** Low-Medium
- **Location:** `packages/ai-core/src/memory.ts` (`DbMemoryStore`), `apps/api/src/app-context.ts:167` (memoryStore created), ARCHITECTURE.md:129-137 (describes passive recall + consolidation).
- **Explanation:** The docs describe a rich memory design (ambient cosine recall, side-agent relevance, consolidation worker jobs). In practice `DbMemoryStore` exists but the worker runs no consolidation job and recall is driven by explicit `memory.search`/`session.search` tools. The "human-like memory without token-burning tool spam" pitch is partially realized.
- **Why this becomes expensive later:** The differentiating memory story isn't demonstrable end-to-end; docs/implementation drift erodes trust.
- **Recommended Architecture:** Wire the pieces that exist: (1) a worker job for ambient consolidation/staleness; (2) a passive-recall context hook in the orchestrator that injects a small budgeted memory block (bounded, merged with compaction); (3) golden-dialogue evals with a p95 memory-token budget assertion.
- **Migration Strategy:** Land passive recall as a scoped, budgeted inject (behind a flag), then the consolidation job, then evals.
- **Trade-offs:** Token/context cost of injected memory; mitigated by the p95 budget the docs already propose.

### Issue AI-6 — Positive: safety design is exemplary

- **Category:** AI / Hallucination / Safety (recognition, not a defect)
- **Severity:** n/a
- **Location:** `packages/kernel/src/autonomy.ts`, `risk.ts`, `inbox.ts`; `packages/ai-core/src/orchestrator.ts` (standing rules, skill-save approval, prompt-injection gate).
- **Explanation:** This is the standout element. The combination of (a) risk-class taxonomy, (b) `minAutonomyForAuto` per command, (c) "strictest step wins" plan gating that correctly avoids re-raising gates, (d) scoped standing rules so "allow always" binds to a *target* not a command, (e) skill-save requiring human approval with no self-grant path, and (f) injection checks gated by autonomy is **Staff-level safety engineering**. It is the product's defensible moat.
- **Recommended Architecture:** Protect and formalize this. Add contract tests that a malicious "allow always" can never generalize beyond its target; add an eval that gate behavior stays stable under adversarial prompts; keep a public infra/rules doc.
- **Migration Strategy:** Convert the existing `e2e`/`orchestrator.e2e.test.ts` safety scenarios into a dedicated, fast safety suite so the moat is regression-proof.
- **Trade-offs:** None — this should be preserved and hardened.

---

## 9. Overall, Maintainability, Scalability, Technical Debt scores

Scored against the project's own stated ambitions (production-grade, auditability-first, SME scale, 5-year maintenance).

| Dimension | Score | Rationale |
|---|---|---|
| **Overall Architecture** | **5.5 / 10** | Beautiful AI control plane and clean kernel; undermined by two critical defects (no transactions, no auth), an in-memory data plane, and a god module. Strong bones, weak plumbing. |
| **Maintainability** | **5.0 / 10** | Kernel + docs excellent; platform god module (3369 lines, 63 commands), duplicated wiring, duplicated DTO schemas, and hand-written migrations hurt. |
| **Scalability** | **3.5 / 10** | In-memory stores and in-memory workflows block horizontal scale; single pool, no caching, no `SKIP LOCKED`; the data model is correctly multi-tenant but the runtime is single-instance. |
| **Technical Debt** | **6.0 / 10** (lower = more debt) | Debt is real but *young* and concentrated; the highest-priority items are small, well-scoped fixes (transactions, auth wiring, workflow persistence). Not laid down yet as an unmovable mess — this is the best time to fix. |

> Scoring note: these are low because the two Critical defects (ARCH-1 auth, ARCH-2 transactions) each independently block "production / enterprise customer" readiness. The strong kernel and AI safety layer are the reason it isn't lower.


---

## 10. Top 20 refactoring priorities

Ranked by (impact × urgency) ÷ effort. Critical first.

1. **Add DB transactions to the command bus** (ARCH-2) — wrap handler + outbox + audit in one `sql.begin`. *Highest ROI item in the codebase.*
2. **Implement per-request authentication** (ARCH-1) — `preHandler` resolving `Actor` from a token; remove the `app.sessionUser` singleton; wire `resolveUserByToken` + web token attach.
3. **Persist workflows to PostgreSQL** (ARCH-5) — replace `app.workflows: Map` with the existing `workflow_definitions`/`workflow_runs` tables + `core.workflow.*` commands.
4. **Extract `createRuntime(cfg, db)` shared factory** (ARCH-4) — de-duplicate API/worker wiring; share one set of stores.
5. **Postgres-backed `InboxStore`/`WakeStore`/`SkillStore`** (ARCH-4/SC-4) — makes standing rules durable + shared, enables horizontal scale.
6. **Split the platform god module into bounded contexts** (ARCH-3) — start with business-partners, then scheduling, then identity.
7. **`FOR UPDATE SKIP LOCKED` + claim column + DLQ** for the outbox worker (ARCH-9/REL-2) — stop double-processing and silent data loss.
8. **Adopt generated/versioned Drizzle migrations** (ARCH-7) — single source of truth for schema.
9. **Shared Zod DTO/contracts package** (CQ-1) — kill client/server schema drift.
10. **Zod-validate query/path params at the HTTP boundary** (CQ-2) — honor invariant #4 uniformly.
11. **Config-driven magic values** (CQ-3) — pool size, `max_tokens`, timeouts, worker knobs, audit limit.
12. **Structured logging (pino) + OpenTelemetry + `/metrics`** (CQ-5) — replace `console.log` observability; make `builtinHandlers` actually notify.
13. **Paginated, filterable audit query** (REL-3) — cursor pagination + `core.audit.query` + export.
14. **Retry + circuit-breaker for the AI provider** (REL-1).
15. **Make `max_tokens` configurable and handle truncation** (PERF-2).
16. **Add module unit/contract tests** for the six untested modules (DX-1).
17. **Native function-calling provider path** (AI-1) with text fallback.
18. **Streaming chat (SSE)** for the AI-primary UX (AI-2).
19. **Selective tool catalog routing + include catalog in compaction budget** (AI-3).
20. **Clean up dead modules & duplicate command names** (ARCH-6) + add a duplicate-name boot test.

---

## 11. Roadmap

### Immediate (today — do not ship past this)
- **DB transactions** in the command bus (ARCH-2). Nothing else matters until mutations are atomic.
- **Per-request authentication** (ARCH-1). Token-based, web client attach, 2-user E2E proof.
- **Persist workflows** (ARCH-5). Stop losing the product's own automations on restart.
- Add a **duplicate-command-name boot test** and remove dead modules (ARCH-6).

### Short-term (this sprint)
- **`createRuntime` factory** + **Postgres-backed stores** (ARCH-4/SC-4) — unifies API/worker, fixes standing-rule sharing.
- **Outbox `SKIP LOCKED` + DLQ** (ARCH-9/REL-2).
- **Versioned Drizzle migrations** (ARCH-7).
- **Shared contracts package** (CQ-1) + **Zod query params** (CQ-2).

### Medium-term (next quarter)
- **Split the platform module** (ARCH-3).
- **Structured logging + OTel metrics + real event handlers** (CQ-5).
- **Paginated audit** (REL-3) + **AI provider retry/circuit breaker** (REL-1).
- **Module unit/contract tests** (DX-1) across all modules.
- **Config-driven knobs** (CQ-3) and **missing tenant indexes** (SC-3).

### Long-term (future evolution)
- **Native function calling** (AI-1) and **streaming** (AI-2) for a first-class AI UX.
- **Role-keyed model routing** (AI-4) + **passive memory recall + consolidation worker** (AI-5).
- **Read replicas, permission/Redis caching** (SC-1/SC-2), BullMQ scheduled jobs (ARCH-9).
- **Generated REST routes** from the registry (ARCH-8) and any remaining bespoke-route reduction.


---

# Part II — Market research: would an SME trust this with its entire operations?

## 12. The core question, answered honestly

**Would a small-to-medium enterprise trust ChasteBusinessOS with its entire operations today? No.** Three reasons, in order of weight:

1. **Data integrity is not guaranteed.** No database transactions (ARCH-2) means partial writes are possible: a customer inserted but no event published, a journal posted but no audit row. An SME that runs its *books* on software cannot tolerate "sometimes the audit trail is incomplete" — that's disqualifying for accounting, and accounting is the #1 reason SMEs buy business software.
2. **There is no authentication.** Every request runs as the single seeded admin (ARCH-1). An SME with 5 employees cannot onboard 5 distinct users with distinct roles today, even though the RBAC data model exists. It *looks* multi-user and isn't.
3. **State does not survive restarts.** Workflows (ARCH-5) and approvals/wakes/skills (SC-4) live in process memory. A redeploy silently destroys user work. For a tool positioned as an "operating system for your business," losing work on restart is a fundamental trust breaker.

On top of these blockers, the breadth is thin: what exists is a credible **skeleton** (CRM with status lifecycle, basic inventory/stock, basic journals+invoices, purchase orders, HR employees+payroll-preparation, manufacturing BOMs) — but a skeleton. Most SME ERP purchases are decided on **accounting depth, tax, and reporting**, which are the weakest areas here.

**The encouraging half:** the honest labeling ("early alpha, not yet recommended for production") is exactly right, and the *decision-relevant* differentiators — Apache-2.0 licensing, an AI harness with genuine safety engineering, a clean command-bus model, and a modern TypeScript stack — are real and defensible. Nothing about the trust gap is unfixable; all three blockers are well-scoped engineering tasks in §11's immediate bucket. If the team fixes transactions + auth + persistence, the answer flips to **"yes, for a pilot tenant in a non-accounting-critical workflow"** within a quarter, and is on a credible path to **"yes, for full ops"** in 2-3 quarters with the module depth work in §15.

### What "SME" means here (segmentation)

Not all SMEs are the same, and Chaste must pick its lane:

- **Micro (1-10)** — need one integrated tool, extreme simplicity, low cost. Odoo Community / Zoho One target these. Chaste's AI-first "describe your business" pitch is a *strong* wedge here — but these users cannot debug anything, so reliability is non-negotiable.
- **Small (11-50)** — need real accounting + inventory + a few integrations; care about price; are willing to self-host. ERPNext and Odoo Community live here.
- **Mid (50-250)** — need multi-branch, approvals, depth, integrations, and support/SLA; start buying NetSuite/Dynamics/SAP B1 at the top. Chaste's multi-branch and autonomy features gesture at this tier.

Recommended wedge: **micro-to-small, multi-location, operations-heavy** businesses that are currently on spreadsheets + QuickBooks + a point CRM solution — and are **AI-curious**. That is the underserved seam, and it is where "AI-native operating system" has the most lift over "ERP with a chat window."


## 13. Competitive landscape — where Chaste sits

### Odoo (the incumbent to beat)
- **Profile:** Founded 2005, Belgium; open-core (Community = LGPLv3, Enterprise = proprietary); Python. **$5.26B valuation / $527M raise (2024)**. 40k+ modules/marketplace, huge partner ecosystem, per-user SaaS pricing, on-prem + cloud.
- **Strengths:** unmatched modular breadth (no module Chaste currently has is deeper than Odoo's), mature POS/e-commerce/manufacturing, a massive marketplace + partner channel, 19 release generations of battle-testing.
- **Weakness (Chaste's opening):** **AI is bolted on, not architectural.** Odoo added an AI assistant; it is not an "AI-first" system where every action flows through a validated, auditable, *explainable* command bus. Odoo's customizability requires a partner/agency and often custom Python modules — the exact "agency bottleneck" Chaste's vision targets. Open-core licensing means the best apps live behind the Enterprise paywall.

### ERPNext / Frappe (the closest open-source comparator)
- **Profile:** Founded 2008, India; **GPL-3.0**; Python/Frappe framework on MariaDB. Full ERP + verticals (manufacturing, retail/POS, healthcare, education, agriculture, nonprofit). Self-host + hosted (frappe.cloud). Gartner FrontRunner/Pacesetter listing.
- **Strengths:** genuinely free open-source (no open-core paywall for core ERP), a clean Doctype/framework app model with an app store, strong accounting, active community in developing markets, low total cost.
- **Weakness (Chaste's opening):** also **not AI-native** (AI is optional add-ons), Python/MariaDB (older stack), framework lock-in (Frappe's own conventions; harder to host polyglot services), and GPL copyleft — which deters some commercial forks and SaaS wrappers. ERPNext is Chaste's **most direct fair comparison** and should be the benchmark for "what must Chaste match in core ERP breadth."

### The rest
- **Zoho One** — cheap integrated SaaS bundle ($ per user/app); strong SMB presence; closed, per-app pricing complexity.
- **NetSuite / Dynamics 365 / SAP Business One (mid-market)** — deep, but expensive, heavy implementation, out of reach for price-sensitive SMEs; Chaste explicitly does not compete here and should not.
- **QuickBooks / Xero** — win on **accounting simplicity**; they are accounting-first, not operations-OS. Chaste should *integrate* or be *better* here, not ignore it; many SMEs' comfort zone is these tools.

### The honest competitive scorecard (SME target)

| Capability | Odoo | ERPNext | Chaste (today) | Chaste (target) |
|---|---|---|---|---|
| Modular app breadth | ★★★★★ | ★★★★ | ★★ | ★★★★ |
| Accounting/tax depth | ★★★★ | ★★★★ | ★★ | ★★★ |
| AI-native operating model | ★★ | ★★ | ★★★★★ | ★★★★★ |
| Explainability & audit of AI | ★ | ★ | ★★★★★ | ★★★★★ |
| License friendliness (commercial) | ★★ (open-core) | ★ (GPL) | ★★★★★ (Apache-2.0) | ★★★★★ |
| Self-host operability | ★★★★ | ★★★★ | ★★ (hand-written migrations, no auth) | ★★★★ |
| Modern stack / extensibility | ★★ (Python) | ★★ (Python) | ★★★★ (TS/Node) | ★★★★★ |
| Ecosystem/marketplace | ★★★★★ | ★★★ | ☆ (stub) | ★★★ |

**The defensible position:** Chaste cannot win on breadth (Odoo's 17-year head start) or on accounting depth (yet). It **can** win on the one axis the others structurally cannot easily copy: **AI as the primary, permissioned, auditable operating surface**, plus **Apache-2.0** (a real commercial-fork advantage over GPL ERPNext and open-core Odoo). "An operating system you *talk to*, that never lies about what it did, and you can legally embed and fork" is a unique, coherent pitch. It is currently the *only* product making that claim seriously.


## 14. Gaps worth filling to make SMEs trust it — ranked by SME buying impact

These are product gaps (not the §11 engineering debt). They matter for SME adoption. We are **not** aiming at SAP; these are the "most pressing business needs with flexibility and simplicity."

### Tier A — do these before any sales conversation (blocking credibility)
1. **Dependable authentication & multi-user onboarding.** SMEs need "add my accountant, my warehouse lead, my salesperson" in minutes, with roles. Currently impossible (ARCH-1). This is table stakes.
2. **Accounting with real statements.** Every SME accountant expects at minimum: **Trial Balance, P&L, Balance Sheet, cash-flow, VAT/tax handling, and (in most markets) tax-format exports**. Today's accounting is journals + invoices — a demo. Accounting is the *entry* module for SME ERP; without statements there is no sale.
3. **Backups with tested restore.** The `backup.ts`/restore exists but needs a documented, *tested* restore procedure and scheduling. SMEs ask "if I lose everything, can I get it back?" before trusting anything. (The `cli-restore.ts` exists — make it a first-class, documented, tested capability.)
4. **Data import from Excel/CSV.** The #1 "I'm switching to you" moment is migrating spreadsheets. The roadmap calls this "onboarding by data" — it must be **early**, with dry-run + human-confirm semantics (which the autonomy/Inbox machinery is already perfect for).

### Tier B — strong SME differentiators, leverage what exists
5. **AI-assisted document handling** (attachments: invoices, receipts, contracts; "extract line items from this file and file it"). SMEs drown in paper/PDFs/emails; an AI that reads and files is a *killer* feature and unique vs Odoo/ERPNext. It also exercises the injection-guardrail and explainability moat.
6. **Email/calendar with real providers** (Google/Microsoft). The internal calendar/email exist (scheduling-and-comms) but are isolated; SMEs live in Gmail/Outlook. Bidirectional sync is expected.
7. **Payments/gateway integration** (Stripe/bank feeds) — "where's my cash?" is the #1 owner question. Get Paid / reconcile out of a feed.
8. **Multi-currency** — trivial for a growing SME, currently absent.
9. **Mobile-responsive PWA** — SME owners run ops from their phone. The roadmap lists PWA; move it up the stack.
10. **Localization on day one** — multi-language UI and market-specific tax/date/number formats. Most SME markets outside the US need this immediately; Odoo/ERPNext both handle it; Chaste is ASCII-only today.

### Tier C — "simplicity + flexibility" plays that match the brand
11. **Templates/presets per industry** ("Retail — light", "Field services", "Distribution"). Configure the module set + a starter chart of accounts in one guided flow — the "describe your business, it configures the platform" vision made *tangible*.
12. **Cross-module outcome workflows** ("Get Paid", "Replenish low stock", "Hire to Payroll") as prebuilt, auditable workflows — the product-architecture doc already lists these (Horizon C); they are the "flexibility with simplicity" sweet spot.
13. **Reports as composition** — NL → validated report from a component catalog. The AGENTS.md forbids inventing analytics without a query path; turn that honesty into a *feature* (lineage on every number). This is a genuine differentiator.
14. **A real marketplace** (fill the empty `modules/marketplace` stub). The Apache-2.0 + module-contract story is what makes a marketplace possible *without* the open-core paywall Odoo uses. This is the long game and the most defensible moat.

### Deliberate non-goals (agreed with the brief)
- Do **not** chase SAP/Oracle/NetSuite depth.
- Do **not** build a BI-tool replacement (Power BI/Metabase) first — compose *operational* reports.
- Do **not** add intercompany/consolidation accounting yet — that's a mid-market feature with steep cost.
- **Do** prioritize depth in a *few* "must-work-before-trust" modules (accounting, inventory) over breadth across many shallow ones.

### What this means for the product narrative
The market does not need "another ERP with a chatbot." The *credible* narrative is:

> **"Chaste is the business OS that operates itself — configurable in plain language, every action permissioned and auditable, free to fork, and built so a 10-person company can run on it without an IT department or an agency."**

That story is only *believable* once transactions + auth + persistence are real (Part I). Sell the AI moat, match Odoo on the accounting/inventory essentials, and win on the ability to legally embed it (Apache-2.0) and on operational trust (explainable AI actions).

---

## 15. Final verdict

- **Architecture:** strong cores (kernel, AI safety), weak edges (data plane, auth, HTTP). **5.5/10.**
- **Would an SME trust it with entire operations today?** **No** — blocked by missing transactions, missing auth, and in-memory state.
- **Can it get there?** **Yes, and credibly.** The three blockers are small, well-scoped fixes (§11 immediate). The deeper product gaps (accounting statements, import, attachments, payments) are a quarter or two of module depth work (§14).
- **Is the strategy viable?** **Yes, with focus.** Competing head-on with Odoo/ERPNext on breadth is a losing battle. Competing on **Apache-2.0 + AI-native, permissioned, auditable operation** — and on a *few* relentless-depth modules — is a winnable, differentiated position for micro-to-small, multi-location SMBs. The AI safety layer is the product's genuine moat; protect it, harden it, and sell it.

**The single most important sentence in this review:** *The architecture is ready to become trustworthy; the data plane is not yet trustworthy. Fix transactions, fix authentication, persist the state — and the gap between "impressive alpha" and "an SME's new operating system" closes faster than the market expects.*


