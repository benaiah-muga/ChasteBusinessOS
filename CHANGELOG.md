# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Coding-agent reuse (`CHASTE_AI_PROVIDER=auto`)** — Chaste detects coding
  agents already installed on the host (Claude Code, Codex, OpenCode, Gemini,
  Grok, Cline, Antigravity, Pi, and 19 more) and reuses their model + endpoint +
  credential as an `AiProvider`, so operators bring their own subscription
  instead of configuring a second API key. Add an `AnthropicMessagesProvider`,
  a data-driven agent registry in `@chaste/ai-core` (`coding-agents.ts`), and a
  `prefer` override (`CHASTE_AI_PREFER_CODING_AGENT`). Agents are completion
  backends only — no elevated privileges; OAuth-only agents (Cursor, Copilot,
  Devin, …) are reported as installed for the self-dev handoff, not reused.
  Docs: `docs/specs/coding-agent-reuse.md`, ADR 0013.

- **Shared durable runtime (`@chaste/runtime`)** — a single `createRuntime(config, db)`
  factory builds the command/query registries, registers every shipped module once,
  and wires Postgres-backed stores (`pending_approvals`, `ai_wakes`, `ai_skills`).
  Both the API and the worker consume it, eliminating process-local store drift so
  standing rules / wakes / skills minted over HTTP are honored by scheduled
  follow-ups (ARCH-4, SC-4).
- **Per-request bearer-token authentication** — the API resolves the acting user from
  an `Authorization: Bearer` token per request instead of a process-wide session
  singleton (with bootstrap-admin fallback for dev/legacy). Adds `POST /api/v1/auth/login`
  and a token-scoped `GET /api/v1/session`. Request-scoped `runCommandAsAuth` /
  `runQueryAsAuth` execute under the request principal while sharing the per-request
  audit/outbox transaction (ARCH-1).
- **Persisted workflows** — AI-built workflows and their runs now survive restarts,
  stored in `workflow_definitions` / `workflow_runs` and reached exclusively via the
  command/query bus (`core.workflow.create` / `get` / `list`), which humans and AI share
  (ARCH-5).
- **Command-bus transactional outbox** — business writes, outbox enqueues, and audit
  events commit in one DB transaction via `createCommandHelpers`; success audit is
  in-transaction and failure audit is written out-of-transaction (ARCH-2).
- **Org-scoped API keys** (`core.apikey.*`) — first-class machine credentials with
  their own permission scopes (subset of the catalog, validated at creation),
  hash-at-rest secrets, and an independent revoke / rotate / expire lifecycle.
  Authenticate with `X-Api-Key: <secret>`; audit attributes command execution to
  the `api_key` actor (`actorKind: "api_key"`).
- **Durable outbox delivery (ARCH-9/REL-2)** — the worker now claims events with
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

- **Command/query execution** — the kernel `InboxStore` and ai-core `WakeStore` /
  `SkillStore` became async interfaces with separate in-memory and Postgres
  implementations (ARCH-4, SC-4).
- **Module boot integrity** — removed the dead `core-system` and `demo-crm` modules and
  added a boot-time registry integrity test that fails on duplicate command/query names
  or missing platform queries (ARCH-6).
- **Platform module decomposition (ARCH-3)** — the platform "god module" is being split
  into bounded-context packages: `business-partner master data` (`core.bpartner.*`),
  `scheduling` (`core.reminder.*`, `core.followup.*`, `core.calendar.*`), and `identity`
  (`core.rbac.*`, `core.role.*`, `core.user.*`) now live in
  `@chaste/module-master-data`, `@chaste/module-scheduling`, and
  `@chaste/module-identity`. Command/query names and permissions are unchanged;
  ownership and contract tests moved with the code. `platform` shrinks and will keep
  shedding bounded contexts toward a thin aggregator.
- **Chat confirmation cards** — only the live confirmation renders after a turn; stale
  cards from a previous confirmation are pruned.
- **AI orchestration robustness (natural clarification)** — the R10 recognition guard
  discards an LLM-materialized plan when a deterministic intent is recognized but a
  required field is missing (e.g. `Create customer in Nairobi`), parking a focused
  clarification instead of a confirm with invented values; clarify probes now preserve
  trailing context (city, amount) so the answer merges correctly; the learned-context
  memory block and LLM prompt forbid copying past-execution values into new plans.
- **Postgres e2e self-cleanup** — `apps/api/src/e2e.test.ts` deletes the customers,
  invoices, memories, and chat sessions it creates, so test runs no longer pollute the
  shared dev database.

### Security (2026-08-08 audit remediation)

- **F1 — no more anonymous admin bypass in production.** The "no token ⇒
  bootstrap admin" fallback is now a dev-only flag (`CHASTE_ALLOW_ANON_ADMIN`);
  production forces it off at config load (fail closed) and the prod Compose
  sets it explicitly. Bootstrap admin is now authenticatable: first boot mints a
  hashed-at-rest credential (`CHASTE_ADMIN_TOKEN` or a one-time generated token
  printed in dev only).
- **F2 — workflow `condition` steps no longer execute code.** `new Function`
  was replaced by a restricted predicate interpreter (`evaluateCondition`,
  tokenizer + recursive-descent parser with no function calls / global access),
  so a stored or LLM-injected condition can at worst evaluate to `false`.
  `lookupPath` also rejects prototype-key traversal (`__proto__`/`constructor`).
- **F3 — workflow build/execute and the two remaining list routes run under the
  authenticated caller** (`requestCtxForAuth`), not the bootstrap admin — org
  ownership and audit attribution match the requester.
- **F4 — chat sessions are ownership-checked** (`DbSession.userId`); loading or
  continuing another user's session (incl. pending planned actions) is denied.
- **F5 — bearer tokens expire.** `users.token_expires_at` is set on
  invite/create (`CHASTE_SESSION_TOKEN_TTL`, default 30 days) and enforced in
  `resolveUserByToken`; the previously-dead TTL config is now live.
- **F7 — `core.user.create` stores tokens hashed at rest** (SHA-256), matching
  `core.user.invite`; the legacy plaintext lookup remains only as a migration
  fallback for pre-hash rows.
- **F6 — rate limiting at the HTTP edge** — dependency-free fixed-window
  limiters (`apps/api/src/rate-limit.ts`): `/auth/login` 10 req/15s per IP,
  `/ai/chat` 30 req/15s per IP plus 120 req/min per authenticated user;
  throttled responses carry `retry-after` and `429 RATE_LIMITED`.
- **F8 — the external risk floor is now live** — `core.email.send` /
  `core.email.enqueue_template` declare `riskClass: "external"` (target-bound
  per `to`), and `core.backup.restore` declares `riskClass: "exec"`; all three
  require `full_autonomous` to auto-run, so standing rules can no longer send
  email or restore backups under `guarded_auto`.
- **F9 — CORS allow-list** — the API now accepts only the configured
  `webOrigin` instead of reflecting any `Origin` header; non-browser
  (no-Origin) callers are unaffected.

### Security (2026-08-08 — F10–F24 remediation)

- **F10 — infra fails closed.** Prod Compose requires `CHASTE_SESSION_SECRET`,
  `POSTGRES_PASSWORD`, and `REDIS_PASSWORD` (`:?` — no shipped defaults);
  `CHASTE_BOOTSTRAP` defaults to `false` (first boot requires
  `CHASTE_ADMIN_TOKEN`); Redis runs with mandatory auth; all runtime images
  (`api`, `web`, `worker`, `migrate`) run as the non-root `node` user.
- **F12 — audit log hygiene.** The command bus redacts sensitive free-text
  inputs (`body`, `note`, `goal`, `salary`, credentials, …) before writing
  `input_summary` (`kernel/src/redact.ts`); the worker no longer logs
  follow-up `goal` text.
- **F13 — role permissions are catalog-validated.** `core.role.create/update`
  reject any permission not in `PERMISSION_CATALOG` — including `*` — so a role
  can never silently grant more than the platform defines.
- **F14 — backup restore is org-bound.** `core.backup.restore` refuses a
  manifest whose `organizationId` differs from the caller's org.
- **F15 — client-side token hygiene.** The web client clears the stored bearer
  token on any 401 so an expired/revoked credential drops back to login.
- **F16 — audit reads are permissioned.** `/api/v1/audit` now goes through the
  `core.audit.list` query (requires `core.rbac.read`) instead of a direct
  store call available to any authenticated user.
- **F18 — Buzz webhook anti-replay.** Signed webhooks carry a unix-seconds `ts`
  covered by the HMAC; payloads older than 5 minutes are rejected.
- **F20 — legacy web forms authenticate.** `CreateVendorForm`,
  `CreateProductForm`, and `HrActions` route through `apiFetch` (Bearer
  attached) instead of raw `fetch` — no more "executes as the admin".
- **F21 — security headers.** `next.config.mjs` adds CSP (with connect-src for
  the API origin), `nosniff`, `DENY` framing, `Referrer-Policy: no-referrer`,
  HSTS, and a restrictive `Permissions-Policy`.
- **F23 — CI least-privilege.** `ci.yml` scopes `GITHUB_TOKEN` to
  `contents: read` and adds a non-blocking `pnpm audit` step.
- **F24 — reminders honor their channel.** `channel: email|both` now enqueues
  an outbound email through the email outbox (delivered by the worker), instead
  of being stored and never sent.
- **Private overlay mesh (ADR 0012)** — opt-in `--profile mesh` adds a Headscale
  control plane (`deploy/mesh/config.yaml` + `acl.json`) and Tailscale sidecars
  for `api`/`web`/`worker`; host port publication can be disabled (`API_BIND=` /
  `WEB_BIND=`) so services are reachable only over the tailnet.

### Fixed

- **Stale chat confirm cards** — approving/answering one confirmation no longer leaves
  a second duplicate card visible in the composer.

## [0.1.0] - 2026-08-05

First tagged release. Early alpha — not recommended for production workloads.

### Added

- **Messaging module**: internal messaging (`modules/messaging`) with send/read
  commands, unread counts, and a full web UI at `/messaging`.
- **Buzz bridge**: signed outbound webhook delivery from the worker
  (HMAC-SHA256 `X-Chaste-Signature`) plus a validated inbound webhook endpoint
  on the API — external messaging with zero configured cost in a stock install.
- **Email delivery**: transactional email outbox with pluggable adapters —
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
  `businessPartnerId` FK — one identity per party, multiple roles (customer AND
  vendor, employee AND contact). Platform module owns `core.bpartner.create`,
  `.update`, `.delete` (archive), `.list`, `.get` with Zod schemas, outbox
  events, and audit. New permissions: `core.bpartner.manage`, `core.bpartner.read`.
- **Directory UI**: new `/directory` page (nav: "Directory") listing all business
  partners with type filter, search, KPI strip, create/edit modal, and archive
  confirmation — the single place to manage parties across the org.
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
  "first-responder-wins" actually engages — no more dangling `pending` approvals.
- **Autonomy audit gate**: `effectiveAutonomyForPlan` no longer lets a later
  step's `minAutonomyForAuto` mask an earlier `external`/`exec` confirm floor —
  the reported/audited autonomy for a plan is now the strictest step.
- **Channel session re-homing**: rebinding a thread target to a new session now
  removes it from the old session's index, so deleting the old session can't
  clobber the fresh binding.
- **Scheduler/email reliability**: a single `notifyUser` failure marks that
  reminder `failed` instead of dropping the whole batch; email outbox gains a
  crash-recovery lease (rows stuck in `sending` past a lease window are reclaimed
  to `queued` and retried).
- **Single-command approvals mirror to the Inbox** — parity with multi-step plans,
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
