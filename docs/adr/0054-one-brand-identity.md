# ADR 0054: One brand identity - warm paper, inked band, burnished gold

Date: 2026-09-19
Status: Accepted

## Context

The product launched with four selectable themes (Chaste brick, Graphite,
Verdant, Meridian) because no brand identity existed yet; the theme system
re-declared the `stone-*` neutral ramp and `maroon-*` accent ramp per theme
so every page re-skinned from tokens. In parallel, the auth gateway and setup
wizard grew a fixed visual identity of their own - warm paper (`#f4efe6`),
cream panels (`#fffdf7`), a near-black warm ink band (`#111416`), and a
burnished gold accent stepped from `#c19a32` - because that is where the
brand finally crystallized.

Running both systems at once produced seams: the gateway was branded while
the product inside still offered four palettes; keeping the gateway on light
tokens in dark mode required a hard pin (`.auth-surface`) that fought the
mode system; and the "accent" ramp name (`maroon-*`) no longer described the
color it would need to carry.

## Decision

1. **One brand, everywhere.** The gateway palette becomes the product
   palette. `stone-*` is re-pointed to warm paper greys anchored at the sand
   canvas (`#f4efe6`), the accent ramp is `gold-*` (stepped from `#c19a32`;
   the `maroon-*` name is retired via codemod), and the sand/cream/ink tokens
   stay as the paper surfaces and text tokens.
2. **The inked band is a brand constant.** The dashboard masthead, login
   hero, setup header, and support widget share `#111416` with paper text and
   a gold accent in **both** modes - the product reads as one object, and the
   gateway is no longer pinned against the mode system (the `.auth-surface`
   pin and its `body:has` canvas rules are removed; gateway pages are
   tokenized like everything else and follow light/dark properly).
3. **Primary actions are ink, not accent.** `.btn-primary` is the gateway's
   warm near-black button with paper text (inverting in dark mode); gold is
   for emphasis, links, active states and highlights - never a full-width
   fill, where it fails contrast with white text.
4. **Light/Dark/System stays; theme picking goes.** `data-theme` and the
   four-palette picker are removed from settings, the command palette, the
   rail menu, and the pre-paint bootstrap. `chaste-mode` (light/dark/system)
   is unchanged, and a `dark:` custom variant now follows `data-mode` so
   hand-tinted colors can flip inside the attribute-based mode system.

## Consequences

- Every existing page re-skins through tokens with no per-page churn; pages
  keep their layout and only the palette moved underneath them.
- Per-app tile hues remain: they are functional color-coding for app
  identity, not brand decoration.
- Semantic colors (emerald/red/amber/sky/violet) are untouched and still mean
  the same thing in both modes.
- Code that asserted `maroon-*` class strings (a handful of tests) was
  mechanically renamed to `gold-*`.
- A future brand change is again a token edit - the ramp architecture is
  unchanged; only the number of palettes went from four to one.
