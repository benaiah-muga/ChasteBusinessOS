# ChasteBusinessOS — Roadmap

## M0 — Foundation (current sprint)
- [x] Monorepo scaffold: Turborepo, pnpm, TS strict, Next.js 15 web app
- [x] Postgres 16 + pgvector dev database (Docker `chaste-pgvector`, :5433)
- [x] `packages/db`: core schema — orgs, users, RBAC, event ledger, approvals,
      agent sessions/trajectory, org memory vectors
- [x] `packages/kernel`: capability contract, registry, governance pipeline,
      event ledger writer, agent loop skeleton + unit tests
- [x] `packages/ai`: NIM adapter (chat streaming, embeddings), model router,
      coding-agent detector
- [ ] better-auth wired into web app with first-org bootstrap flow
- [x] CI: GitHub Actions runs migrations, typecheck, lint, unit tests,
      web build, and demo proofs (when NVIDIA secret present)

## M1 — Trust spine (weeks 2–4)
- [x] Approval inbox UI (approve → execute under human authority; reject with audit)
- [x] Event Ledger viewer: hash chain, actor type, evidence payloads
- [x] Policy engine v1: per-org rules (`maxRiskAutonomous`, money thresholds) in DB
- [x] Onboarding: business description → org profile + seeded chart of accounts
      + embedded into org memory; owner role with full authority
- [x] better-auth wired (email/password) with domain-user mirroring
- [x] First vertical slice end-to-end (proven by `pnpm demo:slice`):
      create customer → invoice → GL posting → payment gated by policy →
      human approval → payment posted → trial balance proves books balance
- [ ] Notification hooks beyond console (email/webhook)
- [x] CI: GitHub Actions runs migrations, typecheck, lint, unit tests,
      web build, and demo proofs (when NVIDIA secret present)

## M2 — Accounting module GA (weeks 4–8)
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
- [x] POS-lite: register sessions with float, instant cash/card sales
      (single atomic posting), drawer counting with honest variance flagging,
      closed-session guard; register history UI
- [x] CRM pipeline: deal lifecycle across 6 stages, kanban UI with weighted
      forecast (stage-probability model), reopen path for won/lost
- [ ] Cash-basis view; formal year-end close (retained earnings roll)
- [ ] Email notifications behind the same NotificationSink interface

## M3 — CRM + Purchasing + POS-lite (weeks 8–12)
- Contacts/deals pipeline; vendor & purchase orders (3-way match)
- POS session model with cash-drawer reconciliation
- [x] Document ingestion: upload/paste → OCR (nemotron-parse) or text parse
      → doc_chunk org memory → deterministic expense-coding suggestions
      (`erp-core`, property-tested) → vendor bill through the governed path

## M4 — HR + Inventory/Manufacturing lite (weeks 12–18)
- [x] Employees, leave, simple payroll run (gated): draft → approve → one
      balanced entry (DR expense / CR cash / CR withholding), prorated by
      approved unpaid leave; tamper-checked totals (ADR 0014)
- Stock ledger (same append-only discipline as GL), reorder points, BOM-lite

## M3.5 — Agent transparency
- [x] Session replay UI: full trajectory viewer (user/assistant/tool-call/
      tool-result events in order) over persisted session events
- [x] Kernel emits tool_result events so replays show outcomes, not just calls

## M5 — Creator Mode beta (weeks 18–22)
- Sandboxed dev container + branch-per-proposal workflow
- Capability scaffolding generator; proposal = diff + tests + risk doc
- Plugin distribution format (npm/git), signature verification

## M6 — Hardening for enterprise (ongoing)
- RLS everywhere + pen-test pass; SOC2-style control mapping doc
- SSO/SAML, SCIM provisioning; per-org data residency notes
- Performance: KV-cache hit-rate dashboards, trajectory compaction
- Marketplace groundwork for community capabilities

## Standing principles (every milestone)
1. No feature ships unless it's operable by agent **and** human through the same path.
2. Every money/identity/destructive action has an approval gate and an inverse.
3. Ledger balance is a property-tested invariant, enforced at DB level.
4. If the agent can't do it honestly, it files a ticket — never improvises.
