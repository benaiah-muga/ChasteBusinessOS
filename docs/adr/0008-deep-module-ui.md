# ADR 0008 — Deepening module UI depth

## Status
Accepted

## Context
Module landing screens in `apps/web` followed one shallow pattern: a tab bar with
a KPI row, one or two tables, and a single "add" form. Backend modules exposed a
minimal command surface (typically create + list), so the UI had no meaningful
operations to drive (no update, no delete, no status changes, no detail views, no
activity history). We want a template where a module is genuinely deep end-to-end:
rich list + detail + lifecycle + timeline, driven by real commands/queries, for the
same org-scoped, permissioned, audited bus humans and the AI both use.

## Decision
- **Deepen backend first.** Every UI capability maps to a real command/query with
  Zod input/output, a permission string, an outbox event (for writes), and an
  audit entry (automatic via the command bus). UI never reaches for tables.
- **Build CRM as the flagship template** — the first module to implement the full
  depth pattern (list filtering, detail page, edit, status transitions, soft
  delete, contacts, activity timeline). Later modules copy the structure.
- **Hand-written React workspaces for now.** We deliberately defer a declarative
  module-UI DSL (see ADR follow-ups / Phase 3) until the pattern is proven against
  a real module; the deep CRM surface is the proof.
- **Soft delete via a terminal status** for lifecycle entities so history is
  preserved and lists simply hide archived rows unless asked.
- **Detail screens as real routes** (`/crm/customers/[id]`) for deep-linking and
  shareability; quick create/edit stays in modals on the list/overview surface.

## Consequences
- The web app still imports only `api-client` + `ui-schema`; all depth is HTTP.
- New columns/entities (`crm_contacts`, `crm_interactions`) require migrations and
  cleanup/truncate updates — kept namespaced and cross-module-safe.
- Adding depth to a module is now a known, checklist-able pattern (ADR 0008 +
  `docs/module-development.md`), not ad-hoc per-module invention.
- Risk: hand-written React duplicates some rendering. Accepted; replaced by the
  DSL phase once the shape is stable.
