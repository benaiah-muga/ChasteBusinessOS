# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/), pre-1.0, minor bumps mark
milestones and breaking changes call them out explicitly.

Versioning continues from the v1 codebase (archived on the
[`v1-archive`](https://github.com/benaiah-muga/ChasteBusinessOS/releases/tag/v1-archive)
tag, which ended at 0.1.0); the v2 capability-kernel rewrite resumes the sequence.
The full v1 changelog is preserved at the bottom of this file.

## [Unreleased]

### Added
- **Retail & reach (M13, ADR 0040)**: `pos.returnSale` — always-gated
  full-sale reversal that refunds through a mirrored entry, credits the
  invoice, and restores stock; per-register shift summaries; marketing-lite
  with saved deterministic segments, campaigns, opt-out honored at send
  time, and the append-only send log as the analytics — no tracking pixels
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
  reservation-anchored orders — confirming checks the customer's credit
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
  specificity — the most specific matching pattern wins, ties resolve to
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



### Added
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
  now loads `.env` and actually runs — its import paths previously pointed
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

### Fixed
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

## [0.4.0], 2026-08-26

### Added
- **Tabbed app framework (`AppFrame`)**: every business app now opens into a
  shared frame — breadcrumb, app identity, underline tabs with live counts.
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
  metric/imperial units, date format, week start — persisted per device via
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
  opens with a deep ledger band — net income set as a cover figure over fine
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
  live checklist per organization — products, customers, vendors, team,
  email, website widget, Creator-mode agent — each item with a one-sentence
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
  `purchase_requests` and `rfqs` tables plus governed capabilities —
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
- **Full CRM surface**: "Pipeline" is now "CRM" with two tabs — Customers
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
  production lifecycle — work orders, multi-level BOMs with scrap, cost
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
- **Four designed color themes**: Chaste, Graphite, Verdant, Meridian —
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
- `_shell/nav.ts` (sidebar navigation tree) — superseded by the application
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
