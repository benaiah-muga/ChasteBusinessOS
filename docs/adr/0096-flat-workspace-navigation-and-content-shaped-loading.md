# ADR 0096: Flat workspace navigation and content-shaped loading

Date: 2026-10-23
Status: Accepted

## Context

The rail exposed every module and then expanded a second level of sub-surfaces
inside it. That made the primary navigation tall, visually noisy, and unstable:
the rail changed height when a section opened, active state became ambiguous,
and the sub-surfaces competed with the module names for attention. Collapsing
the rail removed the labels entirely, so the structure did not survive the
compact mode either.

Loading had the same problem in the opposite direction. Several workspaces
rendered a blank card or a single line of text while their data loaded. Some
rendered error copy while the active organization was still resolving, which
looked like a permission failure and taught people to distrust a normal
startup.

## Decision

1. **The rail is flat.** Every rail entry is a top-level workspace. The rail
   has no chevrons, no expanding groups, and no nested links. `isNavItemActive`
   still highlights the owning workspace when a person is on one of its
   sub-routes.

2. **Sub-surfaces are discovered in context.** In-page tabs, local actions,
   the command palette, and direct links own the second level. The command
   palette continues to index every leaf so search remains a complete escape
   hatch. A future module switcher should live in the page header, not in the
   rail.

3. **Loading keeps the page identity.** `PageLoading` renders the page purpose,
   a small brand mark, and a content-shaped skeleton. It does not replace the
   page with a blank panel. Pages keep their own header and shell so the person
   can still orient, navigate away, or use the command palette.

4. **Scope precedes the request.** A workspace does not render permission-like
   errors while the active actor or organization is unresolved. It waits,
   shows a loading state, and only reports an error after a real request for a
   resolved scope fails.

5. **Empty states teach the next action.** A zero-data screen names the next
   step and gives one primary action. It does not repeat the same empty message
   in two panels, and it does not lead with an internal form when the product's
   primary workflow is customer-facing.

## Consequences

- The rail is shorter, calmer, and stable across modules and compact mode.
- Sub-surfaces must be reachable from the page they belong to. The command
  palette is the fallback, not the only path.
- Loading feels deliberate rather than broken, and startup no longer produces
  false red banners.
- Empty states carry product guidance and a clear first action.
- Any future rail grouping must remain one level deep. Nesting is a product
  regression, not a styling choice.

## References

- [Navigation model](../../apps/web-vite/src/shell/navigation.ts)
- [Workspace shell](../../apps/web-vite/src/App.tsx)
- [Loading primitive](../../apps/web-vite/src/ui/page-loading.tsx)
- [Support empty state](../../apps/web-vite/src/components/SupportPage.tsx)
- [Invoices workspace](../../apps/web-vite/src/components/AccountingInvoicesPage.tsx)
