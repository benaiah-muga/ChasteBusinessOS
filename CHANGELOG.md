# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note**: GitHub Releases have not been created yet. The links below point to PRs/commits. Once v0.1.0 is tagged and a GitHub Release is published, those links will be updated to proper release URLs.

## [Unreleased]

### Changed

- **AI stack**: remove Mastra; custom orchestrator + `AiProvider` + workflow engine only (see ADR 0006)
- Config: `mastra.*` observability renamed to `observability.*` (`CHASTE_OBSERVABILITY_ENABLED`; old env alias still accepted)
- Refresh README with current platform scope, modules, AI stack, and development workflow
- Replace em dash punctuation in README for clearer, more consistent formatting

### Removed

- `@mastra/*` dependencies and Mastra agents/tools/storage wrappers
- Mastra agent fallback path in chat orchestrator

### Fixed

- **Inbox once-only (R2/R3)**: confirm/cancel now resolve the canonical approval by its `toolCallId` (not the pending `id`), so approving/denying a multi-step or single-command plan updates the durable Inbox item and cross-surface "first-responder-wins" actually engages — no more dangling `pending` approvals
- **Autonomy audit gate**: `effectiveAutonomyForPlan` no longer lets a later step's `minAutonomyForAuto` mask an earlier `external`/`exec` confirm floor — the reported/audited autonomy for a plan is now the strictest step
- **Channel session re-homing**: rebinding a thread target to a new session now removes it from the old session's index, so deleting the old session can't clobber the fresh binding

### Added

- **Reliability — scheduler/email**: reminder delivery is now failure-atomic (a single `notifyUser` failure marks that reminder `failed` instead of dropping the whole batch); email outbox gains crash-recovery lease (rows stuck in `sending` past a lease window are reclaimed to `queued` and retried)
- **Single-command approvals mirror to the Inbox** — parity with multi-step plans, so a single external/write action is approvable from mobile/Slack and from unattended sessions
- **Deterministic scheduling parsers**: `parseScheduleFireAt` / `parseScheduleRange` accept an injected clock, enabling stable, timezone-robust unit tests
- **AI harness test suite**: easy / medium / complex humanlike chat scenarios across CRM, Accounting, Purchasing, Inventory, and HR (plan → confirm → execute, cross-step wiring, multi-turn sessions), plus RBAC permission-denial and prompt-injection guardrail coverage

- ADR 0006: custom AI orchestration
- ADR 0007: harness memory graph and self-development pipeline (spec decision)
- Product specs: agent harness, semantic memory, self-development, scheduling/comms, platform module
- Specs: portable modules, chat sessions/feedback, UI correctness, PWA/Tailscale access, model eval suite
- Expanded VISION / ARCHITECTURE / product-architecture-next for harness, gaps, self-dev, multi-branch, proactive agents
- **Horizon A platform**: multi-branch (list/create/update/set_active/grant), capability gap tickets, in-app notifications foundation
- **Horizon A platform (cont.)**: capability catalog (search/list) + placement recommender (`core.capability.gap.recommend`) mapping gaps to kernel / private cloud / local extension / marketplace
- **Agent harness (C5)**: `runFollowUpTurn` re-entry for deterministic follow-up execution, self-contained worker harness with `status: done|failed`, `firedAt`, and persisted `sessionId`
- **Scheduling & comms (C3/C6)**: calendar CRUD with natural-language event creation (block/schedule/book), email outbox with console adapter and worker flush, templated invite/reminder/digest/gap-ticket emails
- **Marketplace (S4)**: publish command gated on confirmed/resolved gap tickets, rejecting `platform_roadmap` placements
- **Platform UI**: calendar week view, reminders, notifications (read/unread), capability gap filing with catalog search + placement, branches page, and a top-bar branch switcher that appears when the org has multiple accessible branches
- **Chat**: session history API + top-bar continue/new chat, like/dislike feedback, auto titles
- **Safety**: `resource_link` / `gap_ticket` UiParts with server-side href allowlist verification
- **PWA**: installable web manifest + service worker registration
- **Evals**: expanded real-world scenario seed set for model readiness
- Passive memory inject foundation on chat turns
- Coding agent provider contract including optional Buzz adapter detection
- Lightweight prompt-injection guardrails in orchestrator
- `CHANGELOG.md` to track release history

## [0.1.0] - 2026-07-22

Early alpha release. Not recommended for production use.

### Added

- **Foundation**: monorepo scaffold with Turborepo, TypeScript strict mode, Fastify API, Next.js web app, PostgreSQL + Drizzle, and kernel command/query bus
- **Business modules**: CRM, Accounting, Inventory, Purchasing, Manufacturing, HR, and Platform (RBAC, settings, marketplace, autonomy)
- **AI layer**: custom orchestrator + workflow engine, Nvidia NIM via AiProvider, module specialist metadata
- **Conversation intelligence**: multi-turn memory, clarifying questions, multi-step planning, and proactive suggestions after successful actions
- **Infrastructure**: transactional outbox processor (`apps/worker`), persistent memory store, optional Langfuse observability
- **Platform services**: user management commands, auth resolver, org settings, user preferences, split RBAC permissions with safety guards
- **Web UI**: dashboard, module workspaces, workflows page, audit trail, RBAC admin, settings, marketplace, chat widget, and theme management
- **Testing**: AI orchestration E2E tests, RBAC E2E tests, user lifecycle E2E tests, and API integration coverage
- **CI**: GitHub Actions workflow for lint, typecheck, and test

### Changed

- Enhanced CRM and vendor forms, admin configuration defaults, and dashboard charts
- Updated UI components, styles, and theme tokens across the web application

## [0.0.1] - 2026-07-16

### Added

- Initial repository with project vision, architecture docs, and Apache 2.0 license

[Unreleased]: https://github.com/benaiah-muga/ChasteBusinessOS/compare/main...feat/agent-runtime-from-openworker
[0.1.0]: https://github.com/benaiah-muga/ChasteBusinessOS/pull/3
[0.0.1]: https://github.com/benaiah-muga/ChasteBusinessOS/commit/12c275c
