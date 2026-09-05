# ChasteBusinessOS, Roadmap

## M0, Foundation (current sprint)
- [x] Monorepo scaffold: Turborepo, pnpm, TS strict, Next.js 15 web app
- [x] Postgres 16 + pgvector dev database (Docker `chaste-pgvector`, :5433)
- [x] `packages/db`: core schema, orgs, users, RBAC, event ledger, approvals,
      agent sessions/trajectory, org memory vectors
- [x] `packages/kernel`: capability contract, registry, governance pipeline,
      event ledger writer, agent loop skeleton + unit tests
- [x] `packages/ai`: NIM adapter (chat streaming, embeddings), model router,
      coding-agent detector
- [x] better-auth wired into web app with first-org bootstrap flow (M1 below)
- [x] CI: GitHub Actions runs migrations, typecheck, lint, unit tests,
      web build, and demo proofs (when NVIDIA secret present)

## M1, Trust spine (weeks 2–4)
- [x] Approval inbox UI (approve → execute under human authority; reject with audit)
- [x] Event Ledger viewer: hash chain, actor type, evidence payloads
- [x] Policy engine v1: per-org rules (`maxRiskAutonomous`, money thresholds) in DB
- [x] Onboarding: business description → org profile + seeded chart of accounts
      + embedded into org memory; owner role with full authority
- [x] better-auth wired (email/password) with domain-user mirroring
- [x] First vertical slice end-to-end (proven by `pnpm demo:slice`):
      create customer → invoice → GL posting → payment gated by policy →
      human approval → payment posted → trial balance proves books balance
- [x] Notification hooks beyond console (email/webhook, M2 below)

## M2, Accounting module GA (weeks 4–8)
- [x] Double-entry core in `erp-core` + property-based invariant tests
      (caught zero-total invoices and empty posting lines pre-release)
- [x] Chart of accounts, journal entries, reversals (UI + capability),
      period close/reopen (destructive-gated) with closed-period posting guard
- [x] AR subledger: aging report (pure function + property tests), outstanding
      tracking, overpayment guard; trial balance
- [x] Internal messaging: channels/DMs, agent as conversation participant
      (reads thread, acts via capabilities, replies in-context)
- [x] Streaming chat UX: token-level NDJSON streaming through the agent loop,
      tool-call activity chips, progressive rendering
- [x] Report pack: P&L + balance sheet (pure functions, property-tested
      accounting equation; corruption visibly flagged when unbalanced)
- [x] AP subledger: vendors, bills (DR expense / CR AP), bill payments
      (threshold-gated), AP aging; "pay in full" in the accounting UI
- [x] Webhook notification seam (NOTIFICATION_WEBHOOK_URL) for approvals/tickets
- [x] Email notifications behind the same NotificationSink interface
- [x] POS-lite: register sessions with float, instant cash/card sales
      (single atomic posting), drawer counting with honest variance flagging,
      closed-session guard; register history UI
- [x] CRM pipeline: deal lifecycle across 6 stages, kanban UI with weighted
      forecast (stage-probability model), reopen path for won/lost
- [x] Cash-basis view; formal year-end close (retained earnings roll)

## M3, CRM + Purchasing + POS-lite (weeks 8–12)
- Contacts/deals pipeline; vendor & purchase orders (3-way match)
- POS session model with cash-drawer reconciliation
- [x] Document ingestion: upload/paste → OCR (nemotron-parse) or text parse
      → doc_chunk org memory → deterministic expense-coding suggestions
      (`erp-core`, property-tested) → vendor bill through the governed path

## M4, HR + Inventory/Manufacturing lite (weeks 12–18)
- [x] Employees, leave, simple payroll run (gated): draft → approve → one
      balanced entry (DR expense / CR cash / CR withholding), prorated by
      approved unpaid leave; tamper-checked totals (ADR 0014)
- [x] Stock ledger (same append-only discipline as GL), reorder points,
      BOM-lite (defineBom / produceFromBom / bomReport with cycle rejection)

## M3.5, Agent transparency
- [x] Session replay UI: full trajectory viewer (user/assistant/tool-call/
      tool-result events in order) over persisted session events
- [x] Kernel emits tool_result events so replays show outcomes, not just calls

## M5, Creator Mode beta (weeks 18–22)
- [x] Capability scaffolding generator; proposal = diff + tests + risk doc
      (`creator.scaffoldCapability`)
- [x] Plugin distribution format with ed25519 signature verification
      (@chaste/plugin-kit, ADR 0018); marketplace listings + install flow
- [ ] Sandboxed dev container + branch-per-proposal workflow

## M6.5, Manufacturing module + full surfaces (current)
- [x] `modules/manufacturing` as its own governed module (ADR 0026): multi-level
      BOMs with per-component scrap, work orders (draft → release → partial
      completions → close), production runs with whole-run reversal, cost
      previews at moving-average prices, upstream lot traceability; writes go
      through the shared inventory ledger primitives only
- [x] Inventory depth: reservations with available-to-promise, cycle counts
      (snapshot → enter → post variances, drift-guarded), stock locations,
      lot balances, per-item movement history, valuation in the stock report
- [x] Tabbed UIs for Inventory and Manufacturing covering every capability;
      Purchasing gets its human surface (vendors, orders, receipts, bills,
      gated payments, AP aging)
- [x] Migration 0020: work orders, lots, locations, reservations, cycle count
      tables under standard RLS; 0021 fixes shadow-timestamp columns

## M6, Hardening for enterprise (ongoing)
- [x] RLS everywhere (46 tables, probe-tested under NOBYPASSRLS role;
      ADR 0017); SOC2-style control mapping doc
- [x] SSO/SAML connection storage + domain routing; SCIM 2.0 provisioning API
- [x] KV-cache hit-rate dashboards, trajectory compaction
- [x] Marketplace groundwork for community capabilities (signed manifests)
- [x] Trust-spine hardening (ADR 0020): atomic approval claiming (no double
      execution under concurrency), kernel-side verification of claimed
      approvals, declared `moneyAmount` on money capabilities (fail-closed),
      advisory-lock serialization of ledger chain appends, RLS wired into
      every capability transaction via `withOrgContext`, one shared posting
      service (`@chaste/module-accounting/posting`)
- [x] Durable capability-job queue (`jobs` table + FOR UPDATE SKIP LOCKED
      worker, `pnpm worker`); document OCR/ingest moves off the request path
- [x] Governance eval harness v1: golden agent trajectories asserted against
      scripted models in CI (`packages/kernel/src/eval.test.ts`)
- [x] Customer care agent (ADR 0025): draft-only support replies bound to one
      customer per thread, scoped read tools with zero model-controlled ids,
      escalation on the record; `pnpm demo:support` proves injection resistance
- [x] Structured JSON logging (`LOG_LEVEL`), model-call retry with backoff,
      boot-time tool-schema serializability + name-collision conformance,
      registry cached per process instead of per request
- [ ] Playwright e2e happy path (approvals inbox through posting)
- [ ] pino/OTel export behind the structured logger seam; per-org ledger
      chain heads + partitioning (ADR 0022); multi-currency phases 2-3
      (ADR 0021); sandboxed proposal runner (ADR 0023)
- [ ] Pen-test pass; per-org data residency notes

## M7 — Inventory integrity: books that see the warehouse (planned)
Plan and gate specs: `docs/REVENUE_SUITE_PLAN.md` (external inventory audit,
triaged against the codebase)
- [x] Inventory → GL closure: periodic valuation summary posting with
      property-tested stock-ledger ↔ GL reconciliation; drift-guarded
      (ADR 0033; retires ADR 0009's deferral)
- [x] Internal transfers: create/confirm with paired out/in legs, partial
      confirm, compensating inverse; value-neutral legs keep valuation drift-
      free (property-tested)
- [x] Product surface: item images, tags, barcode field + `lookupByBarcode`;
      update/restore with snapshot inverse; Products + Inventory UI with
      stock-term tooltips (receipt notes already carried by ledger note field)
- Demo proof: `pnpm demo:m7`

## M8 — Signals + reorder intelligence (planned)
- [x] Cross-module "Needs Attention" signal registry (ADR 0034): deterministic
      producers, one shape, feeding home dashboard, app overviews, routines,
      and the agent
- [x] Reorder math in `erp-core` (demand velocity, lead-time demand, safety
      stock, suggested qty) with property + golden tests
- [x] Governed reorder loop: signal → plan with visible arithmetic → draft POs
      → policy-gated approval (upgrades the `stock-reorder` advisory skill)
- Demo proof: `pnpm demo:m8`

## M9 — Quote-to-cash completed + CRM depth (✅ 2026-08-31, 15/15 gates — `GATES.md`)
- [x] Quote lifecycle: `quotes.expires_at`, expiry-refusing acceptance,
      `accounting.expireQuote` idempotent sweep, expired-quote signal (ADR 0034)
- [x] Sales orders + fulfillment: reservation-anchored confirm (oversell
      refused, backorder flag), delivery consumes reservations and invoices
      through the shared posting path, credit guard as fail-closed refusal
      with exact overshoot (ADR 0036)
- [x] CRM depth: `crm.convertLead`, deal source/owner/lostReason, tasks with
      due dates feeding overdue signals, deterministic duplicate detection
      (erp-core, property-tested) warning on createCustomer
- [x] Customer 360: `crm.customerTimeline` merges invoices, payments,
      quotes, deals, and tasks reverse-chronologically
- Demo proof: `pnpm demo:m9` — FULFILLMENT OK / CREDIT GUARD OK /
  EXPIRY GUARD OK / TIMELINE OK; live-DB suites green in modules/sales,
  modules/accounting (quotes), modules/crm

## M10 — Accounting & purchasing depth (✅ 2026-08-31, 21/21 gates — `GATES.md`)
Plan: `docs/BUSINESS_OS_PLAN.md` (eleven external module audits, triaged)
- [x] Cash flow statement (direct method, erp-core, property-tested: ties
      to the cash balance) + AR/AP credit notes (always-gated,
      reversal-style, immutable credited columns) — ADR 0037
- [x] Payment terms → due dates; customer/supplier statements with running
      balances; reminder drafting honoring opt-out, delivered over the
      messaging seam; supplier lead-time/on-time/fill-rate memory, price
      history, close-with-backorder flag, purchase returns
- [x] Money intelligence: duplicate-payment detection → orange signals,
      13-week cash forecast in erp-core (bucket conservation property)
- Demo proof: `pnpm demo:m10` — CASHFLOW TIES / CREDIT NOTE GATED /
  STATEMENTS RENDERED / REMINDER DRAFTED / SUPPLIER MEMORY OK /
  FORECAST RENDERED / DUPLICATE FLAGGED

## M11 — People, projects, expenses (✅ 2026-09-01, 19/19 gates — `GATES.md`)
- [x] HR structure (department/position/manager/emergency contacts),
      attendance via clockIn/clockOut with late flags, derived leave
      balance + calendar, chronic-lateness signals
- [x] Recruitment-lite: openings → applicants → staged pipeline → hire
      converts to a linked employee
- [x] Manufacturing planning-lite: BOM-explosion availability with the
      producible ceiling (`maxProducibleUnits`, property-tested), work
      centers, lead-time estimates from run history
- [x] Projects module (greenfield, standalone): kanban tasks/subtasks,
      assignment, due/priority/status; subset-org proof PROJECTS STANDALONE OK
- [x] Expenses depth: rules-first categories with override, receipts via
      documents seam, per-category policy limits → signals, duplicate-claim
      detection
- Demo proof: `pnpm demo:m11` — ATTENDANCE WATCH OK / PROJECTS STANDALONE OK /
  M11 ALL OK (hire → project → time → expense → approve)

## M12 — Understanding: analytics + helpdesk + documents (✅ 2026-09-01, 17/17 gates — `GATES.md`)
- [x] `analytics.explainChange`: deterministic decomposition (contributions
      sum to the delta, property-tested), capability over invoice lines
      with drill-to-transactions; `analytics.askYourBusiness` cited
      composition ending in a proposed governed action
- [x] Helpdesk depth: ticket number/priority/category/assignee/SLA, canned
      responses, KB articles, rules-first category drafts, SLA-breach signals
- [x] Documents: folders, business-record metadata, append-only version
      history, expiry signals (ADR 0039)
- Demo proof: `pnpm demo:m12` — DECOMPOSITION SUMS / ASK-ANSWER CITED /
  TICKETS DEEP OK / DOCUMENTS LAYER OK

## M13 — Retail & reach (✅ 2026-09-01, 11/11 gates — `GATES.md`, demand confirmed)
- [x] POS returns (always-gated full-sale reversal: refund entry, invoice
      credit, stock restored), shift summaries per register
- [x] Marketing-lite on confirmed demand: saved deterministic segments,
      campaigns with append-only send log, opt-out honored at send time —
      no tracking pixels, no journeys, no landing pages (ADR 0040)
- Demo proof: `pnpm demo:m13` — SHIFT SUMMARY OK / MARKETING LITE OK

## Standing principles (every milestone)
1. No feature ships unless it's operable by agent **and** human through the same path.
2. Every money/identity/destructive action has an approval gate and an inverse.
3. Ledger balance is a property-tested invariant, enforced at DB level.
4. If the agent can't do it honestly, it files a ticket, never improvises.
5. Each module is useful alone; modules compound when combined; cross-module
   effects degrade gracefully when a sibling module is disabled; the AI is the
   connective tissue that operates the whole — never a bypass around
   governance (enforced by composition conformance, ADR 0035).
