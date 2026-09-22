# M14 plan - UX depth and trust

Drivers: the March 2026 user review. Verbatim pain points: the floating AI
bar and dropdowns feel generic, the display-currency setting silently does
nothing, a human toggling a module was asked to approve their own action and
then dead-locked the org with "module iam is disabled", settings are shallow,
messages have no CRUD, there is no quick-create pattern, services are
half-modeled, AI settings are a read-only env dump, and documents have no
creation surface at all. UX is the highest priority of this run.

Everything here goes through the standing rules: capabilities for state,
append-only ledger, property tests for money, CHANGELOG entries, ADRs for
design decisions.

## Phase 1 - Trust and foundations (fixes)

> Status: 1.1, 1.2, 1.3, 1.5 and 1.6 shipped (ADR 0055, migration 0055).
> 1.4 audit pending the route inventory; 1.6 next.

### 1.1 Actor-aware authority (ADR 0055) - SHIPPED

Today `DefaultPolicyEngine` gates `identity`/`destructive` for every actor,
so a permitted human must approve their own click in the Approvals inbox
(`packages/kernel/src/policy.ts:33-39`).

New rule, confirmed with the product owner:

- A human actor holding the capability's permission executes directly, under
  their own authority, fully audited. No self-approval round trip.
- Agent actors keep every gate they have today: identity/destructive always
  require approval; money above the org threshold requires approval; null
  `moneyAmount` fails closed.
- Orgs can opt into "maker-checker" (strict mode) from Settings, which
  re-imposes dual control for humans on identity/destructive. Default off.
  Implemented as a per-org policy flag the `OrgPolicyEngine` reads.

Kernel changes stay small: the hard-gate branch checks `ctx.actor.type`
plus the org flag; conformance tests pin all four combinations (human x
strict, human x relaxed, agent, system).

### 1.2 Actor attribution ("whose agent did this")

- `Actor` gains optional `agentName` and `onBehalfOfUserId`; the chat loop
  fills both from the signed-in principal and the session's model ref.
- Ledger rows persist `sessionId` alongside actor type/id; approvals rows
  always record the requester user id, also for agent-raised requests.
- Approvals inbox and event ledger viewer render actor chips: "You (human)",
  "Workmate (agent, on behalf of Benaiah, session #abc)". Agent-raised
  approvals become visually distinct from human-raised ones.

### 1.3 Module switchboard deadlock (fix + hardening)

Root-caused defect chain (verified in code):

1. `MODULE_CATALOG` omits `iam`, `routines`, `signals` while the kernel
   treats them as gateable modules.
2. GET /api/modules materializes a NULL enabledModules row as the catalog
   list, so the UI baseline never contains iam.
3. The UI saves the full set; the POST zod enum even rejects "iam".
4. `iam.setModules` replaces the set wholesale: one toggle click disables
   iam, routines, signals forever.
5. Both the capability and its inverse are tagged `module: "iam"`, and the
   executor's module check has no exemption, so re-enabling is impossible
   through any kernel path. The error surfaces raw with no recovery hint.

Fixes:

- Protected modules: `iam`, `signals`, `routines` (and any future platform
  spine) are always enabled; the executor skips the gate for them and the
  catalog renders them as locked-on with an explanation.
- The POST schema accepts the full registered module set; the UI sends
  toggles of catalog modules only and the server unionizes with protected
  ids, so no save path can ever drop them again.
- Kernel-level regression tests: disabling every catalog module leaves the
  protected set enabled; `iam.setModules` stays executable.
- Friendly errors: the "disabled" error class gets a recovery hint pointing
  admins at the real state, and `mapError` learns the disabled pattern.

Related: with 1.1, module changes by a permitted human no longer detour
through the Approvals inbox at all.

### 1.4 Capability coverage audit - DONE

Swept every route handler and server action for direct DB writes outside the
kernel (`db.insert`/`db.update`/`db.delete` across `apps/web/src/app/api`).
Result: all business surfaces (accounting, sales, purchasing, inventory,
manufacturing, POS, CRM, HR, marketing, projects, documents, support,
messaging, iam, routines) funnel through `executor.execute`. The flagged
writes resolve to four deliberate platform seams:

1. `api/chat`: agent session row creation/update - trajectory bookkeeping,
   the same class as session_events (the ledger records the actions, not
   the conversation storage).
2. `api/import`: onboarding bulk customer/product import - a guarded bulk
   seam with its own permission/validation layer (import-boundaries,
   write-guards). Row-per-capability calls would flood the ledger with
   hundreds of entries for one user action. Future: a single governed
   `crm.importCustomers`/`inventory.importItems` capability wrapping the
   batch with one audit entry.
3. `api/scim/v2/*`: SCIM 2.0 provisioning - identity lifecycle protocol
   surface governed by ADR 0053, not business-domain state.
4. `api/support/public`: the customer-care widget's inbound channel -
   ADR 0025 containment (zero model-controlled ids, draft-only replies).
5. `api/docs/[id]/workspace` + `server/doc-templates` (Phase 4): draft
   autosave, presence and soft locks written directly under RLS (ADR 0056),
   and one-time built-in template seeding. Both are ephemeral workspace or
   provisioning state; publishing/restoring versions stay governed.

One genuine bypass found and fixed: internal-chat escalation wrote support
tickets with a raw insert. It now executes `support.createTicket` through
the executor, so escalations carry the same permission check and ledger
entry as every other ticket.

### 1.5 Display currency (shipped first, user-blocking)

The Settings picker wrote a localStorage pref that zero pages consumed;
`formatMoney` hardcoded `$`.

- Single source of truth: `lib/format.ts` keeps the active presentation
  currency (code, symbol, decimal digits from `currencyMinorUnits`).
  `lib/money.ts` is the client store: org base currency is the default,
  the device pref ("Organization default" or an explicit code) overrides
  presentation only. No FX conversion ever; stored minor units are sacred.
- Pages call `useMoneySync()` once at their root, so every formatter
  (`formatMoney`, `formatMoneyWhole`, `toMinor`) resolves live; 196 call
  sites stay untouched.
- UGX and other zero-decimal currencies render and parse correctly
  (USh 80,000, not USh 80,000.00).

### 1.6 UI primitives and the AI bar

- `Select`, `ComboBox` (searchable), `DropdownMenu` primitives in
  `components/ui.tsx`: token-driven, keyboard-navigable, typed options;
  then an adoption sweep replacing every raw `<select>`.
- Floating AI bar: hover zone along the bottom edge (dwell delay to avoid
  accidents), stays open while the pointer is over it, hides on leave;
  "always show / hover reveal / hidden" setting plus the existing keyboard
  shortcuts keep working.

## Phase 2 - Quick-create and settings depth

> Status: 2.1 core shipped (system + customer/product/vendor + palette +
> inline triggers in sales, purchasing, CRM). 2.2 core shipped (module
> settings table + governed setModuleConfig/setOrgPolicy + Modules and
> Governance tabs + inventory defaults consumed by the product form).
> Remaining 2.2: org profile editing, notifications prefs, more module
> settings panels as their consumers land.

### 2.1 Quick-create system (Odoo-style) - CORE SHIPPED

- One `QuickCreate` modal primitive + a per-entity form registry; entities
  register once (form spec, submit capability, post-submit behaviors).
- Buttons behave like Odoo: "Create", "Create and new", "Create and close".
- Inline "+" triggers next to customer/product/vendor pickers everywhere
  (new order, quote, PO, deal, invoice, POS), plus a command-palette entry.
- First adopters: product, customer, vendor, employee; the pattern is the
  contract, so every later entity is a registration, not a feature.

### 2.2 Settings overhaul

- Information architecture: General/org profile and branding, Display,
  Modules (switchboard + per-module settings), AI, Governance, Team and
  roles, Notifications.
- Module-specific settings: generic per-module storage (jsonb keyed by
  module) with a Zod schema per module registered beside its capabilities;
  read/write through governed `iam.setModuleConfig` style capabilities;
  each module renders its settings panel inside Settings > Modules.
- Governance tab (first real policy UI): max autonomous risk, money
  thresholds, maker-checker strict mode, per-pattern rules.

## Phase 3 - Messaging CRUD, services, AI settings

> Status: all three shipped. 3.1 messaging lifecycle (twelve capabilities,
> migration 0057). 3.2 services (items.kind, migration 0058; service-line
> invoicing; POS bypass) plus the test-fixture advisory lock that fixed
> parallel-suite DB contention. 3.3 AI settings (per-org credentials
> encrypted at rest, model routing, test-connection, chat + channels agent
> consumption, memory manager with governed deletion, kernel secret-class
> ledger redaction; migration 0059). Remaining: one-line resolveOrgClient
> swaps in support-agent, routines, summarize, OCR.

### 3.1 Messaging - SHIPPED

Conversations: rename (channels), archive, leave, delete (soft), member
management. Messages: edit own within a window, delete own (tombstone).
All of it as `messaging.*` capabilities with inverses, so the agent gets
the same powers; UI catches up to the module.

### 3.2 Services as first-class citizens

Service lines already exist implicitly (nullable itemId in sales/purchasing
with "service line" guards). Make them explicit:

- Item kind: goods vs service (service = never stock-tracked, no valuation,
  service revenue account default).
- Sales: service lines invoice directly (deliverOrder currently refuses
  them); POS sells services; quotes/orders stay uniform.
- Reporting: revenue split goods vs services.

### 3.3 Settings > AI (full per-org config, confirmed)

- Per-org provider + API key: encrypted at rest, secret-class capability,
  write-only from the browser, masked display, test-connection button;
  server env stays the fallback.
- Model routing per role (primary/fast/reasoning/embeddings/OCR).
- Autonomy controls wired to the policy engine (this is the missing policy
  editor, shared with 2.2 Governance).
- Org memory manager (view, search, delete embeddings).
- Routines management UI over the existing routines module.

## Phase 4 - Documents

> Status: shipped (migrations 0060-0061). Editor with Tiptap: toolbar,
> debounced autosave to the RLS-guarded draft workspace (ADR 0056), presence
> heartbeat + soft locks via /api/docs/[id]/workspace, publish/restore as
> governed append-only versions, side-by-side compare, .docx export,
> print-styled PDF, AI assist panel (selection rewrites, continue-drafting,
> grounded document Q&A) over resolveOrgClient, Harper spell check in a
> library-spawned worker with device-local dictionary and a Settings writing
> aids toggle, built-in + custom templates with placeholder fill-in (AI
> prefill from org memory), org print branding (iam.setOrgBranding) and the
> /print/invoice/[orderId] branded layout. Fixed a latent drizzle bug while
> testing: correlated count subqueries rendered unqualified columns and
> always returned 0 (also broke the M12 open-suggestions count).
> Deferred, recorded deliberately: Harper on natural-language textarea
> inputs (v1 covers the editor; needs a mirrored-backdrop primitive),
> Yjs CRDT co-editing (storage shape already compatible), images in .docx
> export. Also noted: `pnpm db:generate` is unusable while drizzle meta
> snapshots lag the hand-written migrations (0046+); new migrations are
> hand-written with journal entries, matching repo precedent.

Confirmed approach: Tiptap editor, `docx` export, print-styled PDF.

- Editor: formatting toolbar, headings, lists, tables, images; documents
  stored as JSON + HTML in the existing append-only version history.
- Realtime: debounced autosave to a server draft with an offline browser
  buffer and a "Saved" indicator; live presence; soft editing locks.
  Storage shaped so Yjs CRDT co-editing can arrive later without migration.
  (ADR: drafts are ephemeral workspace state written outside the ledger
  under RLS; publishing/restoring versions, templates and AI actions are
  governed capabilities. Keystroke noise must not flood the hash chain.)
- Versioning UI: version list with summaries, side-by-side compare first,
  restore-as-new-version (never destructive).
- Templates: parameterized Tiptap documents ({{customer.name}} style
  placeholders resolved through a fill-in form) plus server-rendered,
  org-branded invoice/quote print layouts (logo, colors, layout variants).
- AI in documents (confirmed scope): selection-based assist actions
  (improve, grammar, tone, shorten/expand, translate), continue-drafting,
  generate-from-template grounded in org context, chat-with-document Q&A
  over existing doc_chunk embeddings. Ghost-text autocomplete and agentic
  full-document drafting are deferred.
- Harper spell check: harper.js WASM in a shared Web Worker (no Rust in the
  container, no server load), lazy-loaded, debounced ~400ms; wavy underlines
  with a suggestion popover offering Harper's replacement candidates plus
  ignore and add-to-dictionary (device-local list v1). Enabled by default in
  the editor and on natural-language inputs via the Phase 2 text primitives;
  structured fields (SKUs, amounts, emails, barcodes) opt out; a "writing
  aids" toggle lives in Settings.

## Verification

Per phase: `pnpm typecheck && pnpm lint && pnpm test`, plus the demo proofs
(a change that breaks a demo is not done). Phase 1 adds kernel tests for the
policy matrix and protected modules; money presentation adds unit tests for
decimal handling (UGX/KES/USD). Every user-visible change gets a CHANGELOG
entry; ADRs: 0055 (actor-aware authority), drafts-outside-ledger, protected
modules if it earns one.
