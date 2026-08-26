# ADR 0030: OS navigation model and token-driven theme system

Date: 2026-08-25
Status: Accepted

## Context

Phase 1 of the UI/UX overhaul (branch `feat/os-experience`) set out to make
ChasteBusinessOS feel like a business operating system rather than an ERP
dashboard. The pre-existing shell exposed every destination in a five-group
sidebar (~16 links), pages were flat scrolls with no sense of "entering an
application", and all colors were hardcoded Tailwind utility classes, making a
multi-palette design system impossible without touching every file.

## Decision

**1. Rail + Apps Launcher replaces the sidebar.** The workspace edge is now a
56px rail: Home (monogram), Apps (⌘G), Search (⌘K), Approvals (badge), and at
the bottom notifications, the AI co-worker toggle, the theme menu, and the
account popover (which hosts the org switcher). Every business module is an
entry in a full-screen Apps Launcher (`_shell/apps.ts` is the single catalog
shared by the launcher and the command palette): type-to-filter, arrow-key grid
navigation, Enter to open, per-app hue-tinted tiles, and a Recent group backed
by localStorage. Module gating (`enabledModules`) filters the catalog, so the
launcher, palette, and rail always agree with kernel-level enforcement.

**2. Applications have frames and tabs.** `_shell/app-frame.tsx` renders the
breadcrumb (Home / App), a quiet description line, contextual actions, and a
tablist. The principle: Overview = understand, tabs = operate. Accounting is
the first application on this frame (Overview | Journal | Receivables |
Payables | Reports | Periods, tab state mirrored to the URL hash); other
modules migrate opportunistically. All previous Accounting functionality is
preserved — pay bill, mirror reversal, close period, year-end close, cash
basis, P&L, balance sheet — relocated, not removed.

**3. Two color scales carry the whole identity.** Every neutral routes through
`--color-stone-*` and every accent through `--color-maroon-*` (Tailwind v4
utilities compile to these variables, so runtime re-declaration re-skins the
entire app, including pages still written with raw utilities). Four themes —
Chaste (brick `#9B1313` / burgundy `#38000A`, default), Graphite, Verdant,
Meridian — re-declare the two ramps plus the canvas on `html[data-theme]`,
applied pre-paint by an inline script in the root layout. Semantic colors
(emerald/red/amber) never change: a failure is red in every theme. The theme
store is provider-free (`components/theme.tsx`) so any surface — rail menu,
command palette — can read or switch it.

**4. Dashboard and login follow the same grammar.** The dashboard is an open
composition (no card walls): financial pulse with a hand-built bar chart, a
"Needs you" triage queue where every item ends in a verb, working-capital
figures, pipeline shape, and the event ledger as a timeline. Login keeps the
split-screen concept but replaces AI-slop gradient blobs with a ledger-ruled
burgundy panel (`.ledger-rules`) and numbered proof points.

## Consequences

- New destinations must be added to `_shell/apps.ts`, not to a nav array; the
  launcher, palette, and rail pick them up automatically.
- `_shell/nav.ts` is deleted; nothing imports it.
- New themes are a data change: add a ramp pair + canvas in `globals.css` and
  a swatch in `theme.tsx`.
- Pages not yet on `AppFrame` keep their `PageHeader`; they are already
  theme-aware for free via the token scales.
- `next lint` (the web package's script) is broken under Next 16 — lint with
  `eslint .` from the repo root. Pre-existing, tracked separately.

## Verification

`pnpm typecheck`, `eslint` (0 errors), `pnpm test` (57/57) green; signup →
onboarding → dashboard → launcher → Accounting verified live against the dev
server at desktop and 390px widths, including theme switching and the
persistent chat dock.
