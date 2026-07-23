# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note**: GitHub Releases have not been created yet. The links below point to PRs/commits. Once v0.1.0 is tagged and a GitHub Release is published, those links will be updated to proper release URLs.

## [Unreleased]

### Changed

- Refresh README with current platform scope, modules, AI stack, and development workflow
- Replace em dash punctuation in README for clearer, more consistent formatting

### Added

- `CHANGELOG.md` to track release history

## [0.1.0] - 2026-07-22

Early alpha release. Not recommended for production use.

### Added

- **Foundation**: monorepo scaffold with Turborepo, TypeScript strict mode, Fastify API, Next.js web app, PostgreSQL + Drizzle, and kernel command/query bus
- **Business modules**: CRM, Accounting, Inventory, Purchasing, Manufacturing, HR, and Platform (RBAC, settings, marketplace, autonomy)
- **AI layer**: Mastra agents, Nvidia NIM provider support, workflow engine, domain specialists, and command/query tool wrappers
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

[Unreleased]: https://github.com/benaiah-muga/ChasteBusinessOS/compare/main...feat/ai-intelligence-layer
[0.1.0]: https://github.com/benaiah-muga/ChasteBusinessOS/pull/3
[0.0.1]: https://github.com/benaiah-muga/ChasteBusinessOS/commit/12c275c
