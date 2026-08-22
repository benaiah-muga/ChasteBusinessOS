# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [SemVer](https://semver.org/) — pre-1.0, minor bumps mark
milestones and breaking changes call them out explicitly.

## [Unreleased]

### Added
- Capability conformance system: `assertWellFormedCapability` rejects
  malformed capabilities at registration; `registry.validateAll()` runs at
  boot (missing inverse targets are fatal, missing inverses are warnings).
  6 new kernel tests.
- `docs/adr/` — architecture decision records with index.
- Webhook notification seam (`NOTIFICATION_WEBHOOK_URL`) for approval
  requests and filed tickets.

### Fixed
- Inverse declarations completed for `accounting.createInvoice` and
  `purchasing.createBill`; removed a dishonest self-inverse on
  `crm.moveDealStage`.
- POS drawer math: `expected_cash_minor` NULL default made cash sales
  invisible to reconciliation (`NULL + x = NULL`); column now defaults 0.

## [0.3.0] — 2026-08-22

### Added
- POS-lite (`modules/pos`): register sessions with opening float,
  atomic cash/card sale capability (invoice + payment + GL posting),
  drawer counting with variance flagging, closed-session guard,
  `/pos` console with register history.
- CRM pipeline depth: deals across six stages, weighted forecast by stage
  probability, `/crm` kanban with advance/lose/reopen actions.
- Session replay UI (`/sessions`): full trajectory viewer over persisted
  session events — user/assistant/tool-call/tool-result in order.
- Kernel loop emits `tool_result` events so replays show outcomes.
- Report pack: P&L + balance sheet as pure functions in `erp-core`
  (property-tested accounting equation) with UI cards on `/accounting`.
- AP subledger (`modules/purchasing`): vendors, bills with per-line expense
  coding, threshold-gated bill payments, AP aging, pay-in-full UI action.
- Internal messaging: channels/DMs, agent participation via capabilities,
  auto-reply in agent-enabled conversations.
- Streaming chat UX: token-level NDJSON streaming from the model through the
  kernel loop, tool-call activity chips, progressive rendering.

### Fixed
- Policy engine: money risk is now threshold-governed instead of blanket-
  capped by autonomy rank (an $11.50 coffee sale previously required
  sign-off). See ADR 0005.
- Property tests surfaced and fixed a double-negated revenue sign in the
  balance sheet computation.

## [0.2.0] — 2026-08-21

### Added
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

## [0.1.0] — 2026-08-21

### Added
- Monorepo scaffold: Turborepo + pnpm, TypeScript strict, Next.js 15 app.
- `packages/kernel`: governed capability pipeline (validate → authorize →
  policy gate → execute → audit), hash-chained event ledger, streaming-capable
  agent loop, honest-gap ticket filing.
- `packages/db`: Postgres schema with pgvector-backed org memory.
- `packages/ai`: NVIDIA NIM adapter with tool-call protocol preservation,
  embeddings, coding-agent detection.
- Live proof demos (`pnpm demo:*`) as executable specifications.
