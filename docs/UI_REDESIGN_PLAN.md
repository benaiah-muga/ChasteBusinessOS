# UI Redesign, Implementation Plan

> Mission: eliminate AI-generated slop and bring the Chaste console to the polish
> bar of Linear/Stripe-class products. Branch: `feat/ui-redesign-design-system`.
> This document records the review findings (Phases 1–8) and the implementation
> contract (Phase 11). Design decision record: ADR 0015.

---

## Phase 1, Product understanding

- **Users**: small-business owners and their staff (bookkeepers, sales, front-desk
  POS operators) plus their **AI co-worker** which acts through the exact same
  surfaces. Multi-org users (bookkeepers with several clients).
- **Problem**: running a business's money, sales, people, and documents with an
  agent they can audit, every action is governed, gated, and reversible.
- **Primary workflow**: talk to the agent in the Console → agent proposes governed
  actions → human approves in Approvals → everything lands in the Event Ledger.
  Secondary direct workflows: accounting review (aging, P&L, bills), CRM pipeline,
  POS shifts, HR/payroll, document ingestion, team/RBAC admin.
- **Information that matters most**: *money state* (balances, aging, forecast),
  *what needs my authority* (approvals), *what the agent did* (ledger/sessions).
- **Most important actions**: approve/reject, pay bill, run payroll, ring a sale,
  move a deal, ingest a document, ask the agent.

Design implication: navigation must expose **workflow domains**, not a flat list
of 13 undifferentiated links. Approvals deserve a persistent, count-badged home.

## Phase 2–3, Review findings (visual + UX)

| # | Finding | Severity | Fix |
|---|---------|----------|-----|
| 1 | `globals.css` is one line, no tokens, no type scale, no focus system | high | Token layer (`@theme`) + component classes |
| 2 | Accent color is default Tailwind emerald; brand maroon absent | high | Maroon ramp as `primary`; semantic status colors separate |
| 3 | 13 flat nav links crammed into top bar; no active states; breaks on mobile | high | Grouped sidebar shell + mobile drawer |
| 4 | Every page hand-rolls buttons/inputs/badges → drift (3 button styles, 6 badge styles) | high | Single UI kit (`components/ui.tsx`) |
| 5 | Loading = "Loading…" text; jarring layout shift | medium | Skeletons matching final layout shape |
| 6 | Empty states are dead-end dashed boxes | medium | EmptyState with guidance + CTA |
| 7 | Feedback notices are bare `<p>` paragraphs; success/failure look identical across pages | medium | `Notice` component w/ tone icons + `role=status/alert` |
| 8 | Destructive actions unprotected (`window.confirm`, or none): reverse entry, close period, delete doc, void payroll | high | Accessible `ConfirmDialog` everywhere |
| 9 | No keyboard affordances anywhere | medium | ⌘K command palette, Enter-to-send chat, focus rings |
| 10 | Tables: inconsistent headers (mono uppercase), no numeric alignment discipline, weak hover | medium | `.data-table` system class + `num` cells |
| 11 | Money formatting re-implemented 4× with different rules (some drop cents) | medium | Shared `formatMoney` (minor units → `$1,234.56`, U+2212 minus) |
| 12 | Chat: both roles bubble-shaped; tool chips pulse forever then vanish (loses receipts); no stop; no suggestions; Creator checkbox unexplained | high | Asymmetric chat layout, persistent tool receipts, AbortController stop, suggested prompts, labeled Switch |
| 13 | CRM kanban: `grid-cols-6` squeezes to ~150px columns on laptops; ✕/→ glyphs unlabeled | medium | Horizontal scroll board w/ min-width columns, icon buttons w/ aria-labels |
| 14 | POS uses `window.confirm` to close a cash drawer; variance only visible after close | medium | ConfirmDialog + **live variance preview** while counting |
| 15 | Approvals payload shown as raw JSON wall; risk badges good but hierarchy flat | medium | PR-review card: header row, rationale quote, dark code block, clear approve/reject split |
| 16 | Proposals diff rendered as plain pre; evidence/risk as colored paragraphs | low | Line-tinted diff (+green/−red), callout components |
| 17 | Forms rely on placeholder-as-label (a11y failure); selects unstyled | medium | Label-above inputs, shared Input/Select classes, aria wiring |
| 18 | No responsive strategy below `md`: kanban/grid/table overflow, sidebar unusable on phones | high | Drawer nav, stacking grids, scrollable table shells |
| 19 | Focus outlines removed (`focus:outline-none`) without replacement in several spots | high | Global `focus-visible` ring token |
| 20 | Login is a floating gray card; zero brand presence at the most branded moment | medium | Split-screen brand panel + polished form |

## Phase 4, Product additions shipped

1. **⌘K command palette**, jump to any area; the ERP equivalent of muscle memory.
2. **Approvals badge**, pending-gate count always visible in sidebar (authority
   is the product's heart; it should never be out of sight).
3. **Persistent tool receipts in chat**, chips survive stream completion
   ("see the receipts" UX principle from ARCHITECTURE.md §8).
4. **Stop generation** in chat (AbortController).
5. **Suggested prompts** when the console is empty (kills blank-canvas anxiety).
6. **Live drawer-variance preview** while counting POS cash.
7. **Journal search filter** on Accounting.
8. **Copyable invite link** card on Team (was buried in a notice string).
9. **Relative timestamps** with absolute values on hover, everywhere.

Deferred (recorded for follow-ups, not silently dropped): drag-and-drop deal cards
(needs dnd lib + capability for reorder), dark mode toggle (tokens ready), TanStack
Query adoption for cache/refetch discipline.

## Phase 5, Design system

Brand: **dark maroon** accent. Warm stone neutrals pair with it (cool grays fight
maroon). Status hues stay conventional: green=success, amber=pending/warning,
red=danger/negative, blue=info, violet=AI-agent identity (kept distinct from CTA
maroon so "agent" never masquerades as "primary action").

Tokens live in `apps/web/src/app/globals.css`:

- `--color-maroon-{50…950}`, brand ramp; `maroon-700` primary, `800` hover.
- Semantic: canvas `#FAF9F8`, card white, line `stone-200`, ink `stone-900`.
- Type: refined system font stack (no network-dependent fonts; CI/offline safe),
  tabular numerals for all money/columns via `.tnum` / `tabular-nums`.
- Component classes (single source of truth, `@layer components`):
  `btn` (+`primary/secondary/danger/danger-secondary/ghost/sm`), `input`,
  `select`, `textarea`, `card`, `card-pad`, `label`, `badge` tones, `data-table`,
  `table-shell`, `skeleton`, `kbd`, `icon-btn`.
- Components in `src/components/ui.tsx`: Button, Card, Badge, Notice, EmptyState,
  Skeleton(+Text), StatCard, Dialog/ConfirmDialog, Switch, PageHeader.
- Icons: dependency-free inline SVG set (`components/icons.tsx`), lucide-style
  strokes, no icon-font, no new deps.

Rule going forward: **no page may hand-roll a button/badge/input again.**

## Phases 6–8, Interaction, accessibility, responsiveness contracts

- Motion: 150ms color transitions, modal/drawer enter animations, spinner on all
  async buttons; `prefers-reduced-motion` disables animation globally.
- A11y: visible `:focus-visible` rings (maroon), labels bound with htmlFor/id,
  dialogs: role=dialog, aria-modal, Escape/backdrop close, initial+restored focus;
  icon-only buttons carry aria-label; notices use role=status/alert; nav links use
  aria-current="page"; contrast ≥ 4.5:1 for text (maroon-700 on white ≈ 9:1).
- Responsive: sidebar → overlay drawer < lg; stat grids wrap 2/3/5-col; board
  scrolls horizontally with snap; master-detail pages (messages, sessions) become
  select-then-view stacks with back affordance; every table sits in a scroll shell.

## Phase 11, Implementation map

```
apps/web/src/
  app/globals.css                 ← tokens + component classes
  app/layout.tsx                  ← body tokens, selection, metadata
  app/login/page.tsx              ← split-screen redesign
  app/onboarding/page.tsx         ← branded setup flow
  app/(app)/layout.tsx            ← server: session/orgs/approvals-count → AppShell
  app/(app)/_shell/app-shell.tsx  ← client: sidebar, drawer, palette mount
  app/(app)/_shell/nav.ts         ← grouped nav config (shared w/ palette)
  app/(app)/_shell/command-palette.tsx
  components/ui.tsx               ← kit
  components/icons.tsx            ← icon set
  lib/format.ts                   ← cn, formatMoney, dates, timeAgo, initials
  (pages)                         ← all 14 reworked onto the kit
docs/UI_REDESIGN_PLAN.md          ← this file
docs/adr/0015-design-system-brand-shell.md
CHANGELOG.md                      ← [Unreleased] entry
```

Verification gate: `pnpm typecheck && pnpm lint && pnpm test && pnpm --filter web build`.

## Acceptance criteria

- [ ] Zero emerald/default-Tailwind accents remain; maroon owns CTAs/active states.
- [ ] No page defines its own button/input/badge styles.
- [ ] Every destructive action goes through ConfirmDialog.
- [ ] Every fetch surface has skeleton + empty + error/notice states.
- [ ] ⌘K navigates; Escape closes overlays; Tab order sane in dialogs.
- [ ] Usable at 375px width; no horizontal page scroll (board/table shells excepted).
- [ ] `pnpm typecheck && pnpm lint && pnpm test` green; web build green.
