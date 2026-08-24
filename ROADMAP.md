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

## Standing principles (every milestone)
1. No feature ships unless it's operable by agent **and** human through the same path.
2. Every money/identity/destructive action has an approval gate and an inverse.
3. Ledger balance is a property-tested invariant, enforced at DB level.
4. If the agent can't do it honestly, it files a ticket, never improvises.
