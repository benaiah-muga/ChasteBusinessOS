# ADR 0091: Brand system, command-first shell, and an inbox for human attention

Date: 2026-10-21
Status: Accepted

## Context

The React and Go migration left the product with a flat rail of 28 links, a green-led palette that no longer matched the logo and campaign identity, mixed page typography, and no mobile navigation. The prior Next.js console had a grouped shell and a command palette; the Vite product lost both.

Two backend surfaces had no human surface. `GET /api/signals` produced a cross-module needs-attention feed that only the dashboard consumed in fragments. The Creator workflow told people to connect a coding agent, while `GET` and `POST /api/ai-connections` already supported an OpenCode 2 connection with governed MCP tools.

The chat surface had a working stream, steering, clarifications, proposal cards, and token accounting, but no conversation starters, commands, history, context, or session framing. It read as a test harness rather than a workmate.

The brand image and logo define a clear system: near-black, warm paper, and burnished gold, with an interlocking mark. This is not a modifier on the previous green theme; it is the identity.

## Decision

1. **Adopt the image's palette as product tokens.** Ink `#171613`, paper `#f4efe5`, surface `#fffdf8`, gold `#c19a32`, and a warm hairline `#e5dccb`. Primary actions are ink, gold is emphasis, and the gold-on-dark step is `#e2c98f`. The four-palette theme system stays retired.

2. **Use the real mark everywhere and make loading a brand moment.** The source logo becomes a transparent mark plus a gold variant for dark surfaces. A custom orbit loader uses the mark and a gold ring. The favicon and touch icon come from the same source.

3. **Adopt shadcn conventions without the shadcn look.** Radix primitives, `class-variance-authority`, `clsx`, and `cmdk` form a component layer in `src/ui/`. Components use the product tokens and custom CSS, not the default Tailwind palette. This follows the seam left by ADR 0015 and avoids a second styling system.

4. **Make the shell command-first.** The rail is grouped by workflow, collapsible, searchable through a command palette, and backed by a mobile drawer. A Create menu and `⌘K` palette turn the workmate into the universal quick-create path. The top bar carries breadcrumbs, governance status, Create, organization switching, notifications, and account actions.

5. **Add Inbox as the primary triage surface.** It combines `/api/signals` and `/api/approvals`, ranks them, filters and searches them, and gives each item an owning-workspace action plus an "ask Workmate" path. The dedicated Approvals route remains for authority decisions; Inbox is the broader attention queue.

6. **Treat Workmate as an agent session, not a text box.** Add a welcome state, grouped starters, slash commands, a session context card, context and token feedback, copy transcript, and a confirmed new conversation. Adopt the AI Elements conversation patterns without pasting a chatbot template.

7. **Surface the OpenCode 2 runtime.** Settings > AI & automation now lists coding-agent connections, connects a local OpenCode 2 server, stores the password encrypted through the existing API, sets a default, and disconnects. The copy explains that Chaste exposes governed MCP tools and that approvals still stop for a person.

8. **Remove implementation language from customer copy.** "Go workspace", "Go payment runs", and similar labels become product language. A formatter humanizes capability identifiers in notifications.

## Consequences

- The product reads as one identity across login, shell, chat, portal, and print.
- Every new page should use the `src/ui` primitives and the token layer. Hand-rolling controls becomes a review issue rather than a local choice.
- Inbox becomes the default place to answer "what needs me?" and the dashboard links into it. Signals still have no dismiss or assign state; those are follow-up backend work.
- The live approval badge is suppressed on Inbox and Approvals to avoid duplicate reads; tests count requests.
- The shell is keyboard-first and accessible, but the rail still renders all groups expanded on first use. Saved collapse state is a follow-up.
- OpenCode 2 connection can fail when no local server is running. The UI treats that as a recoverable form error, not a broken settings page.
- A future dark mode is a token change, not a component rewrite.

## Alternatives considered

- **Keep the green palette and add gold accents.** Rejected: the image and logo are unambiguous, and two competing identities made the product feel assembled.
- **Adopt Tailwind and the default shadcn theme.** Rejected: 10,000 lines of existing CSS and a distinctive brand would be overwritten by defaults. Radix plus custom CSS keeps the primitives and the identity.
- **Copy the shadcn chatbot block.** Rejected: the block is recognizable and does not carry Chaste's governance, proposal cards, or token accounting.
- **Make Inbox the only approvals surface.** Rejected: authority decisions benefit from a focused route with the full evidence and history.
- **Leave OpenCode as an environment-only integration.** Rejected: users were told to connect an agent with no control surface.

## References

- [Brand and experience direction](../design/2026-10-brand-and-experience.md)
- [OpenCode 2 docs](https://opencode.ai/v2/docs/)
- [shadcn/ui AI Elements](https://ui.shadcn.com/docs/ai-elements)
- [AI Elements chatbot example](https://elements.ai-sdk.dev/examples/chatbot)
