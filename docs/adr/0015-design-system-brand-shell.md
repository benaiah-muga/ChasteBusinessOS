# 0015, Design system, maroon brand accent, and sidebar shell

Date: 2026-08-22 · Status: Accepted · Supersedes: none · Related: UI_REDESIGN_PLAN.md

## Context

The console was functional but visually generic, the classic AI-generated
default: a one-line `globals.css`, default Tailwind emerald accents, thirteen
undifferentiated nav links in a top bar, and every page hand-rolling its own
buttons/badges/tables with drift between them. The brand's dark-maroon identity
existed nowhere. Destructive actions ran through `window.confirm` or nothing at
all; loading states were the string "Loading…".

An ERP is dense, trust-critical software. Its UI must make three things
instantly legible: where money stands, what waits on your authority, and what
the agent did. The old navigation made none of those primary.

## Decision

1. **Brand accent = dark maroon** (`--color-maroon-*` ramp, primary `700`,
   hover `800`). Warm stone neutrals pair with it; cool grays fight oxblood.
   Status hues stay conventional (green success / amber pending / red danger /
   blue info), and **violet is reserved for agent/AI identity** so "the agent"
   never masquerades as a primary call-to-action.

2. **Tokens before components.** All color/typography decisions live in
   Tailwind v4 `@theme` tokens (`globals.css`). Repeated patterns compile to
   component classes (`btn*`, `input`, `card`, `badge-*`, `data-table`) with a
   single kit module (`components/ui.tsx`). Rule: no page defines its own
   control styles. This keeps us dependency-free while leaving a clean seam to
   adopt shadcn/ui primitives later behind the same class APIs.

3. **Grouped sidebar shell** organized by workflow domain, Workspace
   (Console/Messages/**Approvals**), Money, Grow, People, Agent, with a mobile
   drawer. Approvals carries a live pending-count badge computed server-side in
   `(app)/layout.tsx` under the same authority filter as the API route:
   authority is the product's heart and should never be out of sight.

4. **⌘K command palette** for keyboard-first navigation across all areas.

5. **System font stack**, no webfont downloads, CI/offline builds stay hermetic;
   modern system fonts are indistinguishable at ERP densities. Tabular numerals
   for all money columns via `.num`.

6. **Accessibility floor**: visible `:focus-visible` rings, labeled inputs,
   `aria-current` nav, `role=status/alert` notices, focus-trapped dialogs
   (Escape/backdrop close, focus restore), icon-only buttons carry
   `aria-label`, contrast ≥ 4.5:1, `prefers-reduced-motion` honored.

7. **Every destructive/money action goes through ConfirmDialog** with explicit
   amounts and consequences stated in copy.

## Alternatives considered

- *shadcn/ui + Radix now*: best-practice primitives, but adds several deps for
  patterns we could own in ~400 lines given our simple dialog/menu needs; revisit
  if we need comboboxes/virtualized pickers.
- *Emerald kept as accent*: rejected, brand color exists to be used; two accents
  would split recognition.
- *Top-bar nav retained*: rejected after mapping user goals, approvals visibility
  alone justifies the sidebar badge.

## Consequences

- New pages must consume the kit (`components/ui.tsx`) and shared formatting
  (`lib/format.ts`: `formatMoney`, `timeAgo`, `statusTone`); lint review should
  reject hand-rolled controls.
- Dark mode becomes cheap: swap token values; no component changes (future work).
- The migration meta repair (0011 chain fork) shipped alongside this change;
  documented in CHANGELOG Fixed.
