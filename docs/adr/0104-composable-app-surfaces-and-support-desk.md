# ADR 0104: Composable app surfaces and the Customer Support desk

Date: 2026-10-30
Status: Accepted

## Context

The support module had capabilities, a widget, canned replies, articles, and a
working inbox, but its human surface was one generic page with four in-page
buttons. The global rail remained the only durable navigation, every module
invented its own sub-navigation, and there was no URL for a conversation. A
person could not send a colleague a link to the thread they were discussing.

ChasteDesk, the standalone support desk, already embodied the experience we
wanted: a warm, dense queue, a thread with the customer's message in view, a
context panel with the ticket and customer facts, a visible handoff reason, and
a composer that makes the human release step obvious. The goal was not to copy
its sidebar. The goal was to make that experience an app inside ChasteBOS: the
desk's sidebar becomes the app's horizontal tabs, while the global rail stays
flat and keeps pointing at the app.

The support module also had three correctness gaps that the new surface made
visible:

- The conversation list carried only name, subject, status, and a preview, so a
  queue could not show priority, SLA, assignee, ticket number, or channel
  without reading every thread.
- `support.lookupOrderStatus` parsed into `SupportReadConversationInput`, the
  same type as `support.readConversation`. The executor's type switch matched
  the read case first and returned the transcript instead of invoice context.
  The public widget path called the function directly, so it never hit this.
- The composer's quick-reply read set its loading state inside an effect that
  depended on that state, so React cleaned up and aborted the read before it
  could finish.

## Decision

### 1. Apps own their internal navigation

Add a small app registry in `apps/web-vite/src/shell/apps.ts`. An app declares
its module id, base path, icon, and a list of tabs with URLs. The shell keeps
the flat global rail from ADR 0096, while each app renders horizontal tabs that
are real links, with `aria-current` and browser history.

The Customer Support app is the first entry:

- `/support` is the app entry and opens the inbox.
- `/support/inbox` is the queue.
- `/support/inbox/<conversation-id>` is a deep link to a thread.
- `/support/overview`, `/support/knowledge`, `/support/channels`, and
  `/support/settings` are the other tab surfaces. Settings uses the shared
  settings workspace from ADR 0105.

The app is still module-gated by the existing support switchboard. A workspace
without customer care sees an honest not-installed state, not a broken desk.

The first pass also gave the app a second business-app header below the global
top bar. That duplicated the app identity already in the breadcrumb and cost a
full row of vertical space. The shell now exposes a support action slot in the
top bar, and the app portals its live waiting status and New conversation action
into it. The app keeps ownership of the action and its state, while the shell
keeps ownership of the chrome. The horizontal tabs start directly below the top
bar. The global Create launcher is replaced on support routes so there is still
one primary action. The waiting count hides below 1280px, and the action becomes
icon-only below 1120px.

### 2. The inbox is a three-pane desk

The desk uses three independent scroll regions:

- **Queue**: status filters, text search, assignment, priority, SLA, and sort
  controls, with ticket number, priority, assignee, and SLA on each row.
- **Thread**: the handoff reason above the transcript, the conversation
  header, the messages, and a composer. The handoff card stays visible while
  the transcript scrolls.
- **Context**: the customer, full subject, ticket fields, the customer's own
  invoice balance, earlier conversations, conversation metadata, and the
  system and agent activity already on the thread.

Below 1320px the context panel becomes a dialog opened from the thread. Below
980px the queue and thread become a single-pane mobile flow with a back action.
The floating Workmate dock is hidden on support routes because a fixed dock
would cover the full-height composer; Workmate remains in the global rail.

### 3. The read contract carries triage context, not inferred UI facts

`support.listConversations` now returns ticket number, priority, category,
assignee id and name, SLA due time, channel, customer email, and created and
updated times alongside the existing fields. `support.readConversation` gains
the same staff-facing fields, including the customer email that used to be
stripped on the client.

The legacy agent-facing projection of `support.readConversation` is unchanged:
when no transcript limit is supplied, the output still has the original five
header fields and three message fields. The full-detail projection is requested
by the staff client and by the existing `/api/support?id=` route.

The context panel reads the customer's own invoices through the governed
`support.lookupOrderStatus` capability, not through a new endpoint. It shows the
outstanding balance and up to three invoice rows, and it says "No invoices on
record" when there are none. It does not invent plan, region, tags, or
first-response timers because those fields do not exist in the support schema.

### 4. Human authority stays explicit

The copilot drafts into the composer, never into the thread. The draft is
labeled as AI-generated until a person edits or sends it. A staff reply is sent
with `support.postMessage` from `staff`; logging what the customer said uses the
same capability from `customer` and says so. Escalation requires a written
reason, writes that reason to the thread, and moves the conversation out of the
automatic queue. Resolve and reopen are reversible and audited.

Every support write from the app goes through `support.*` capabilities.
Approval-pending outcomes stay pending, the exact saved action is recoverable
after a reload, and a failed write leaves the typed reply in place. Creating a
brand-new customer uses the shared `crm.createCustomer` capability instead of
inventing a second customer master.

### 5. The app is inside ChasteBOS, not beside it

The app uses the shared session, active organization, capability kernel,
approval path, audit ledger, CRM customer options, team read, and accounting
invoice reads. It does not have its own auth, data store, or agent runtime.
That is the difference between a composable app and an isolated one.

### 6. Seed scripts are governed, idempotent, and clearly demo-only

`scripts/seed-support-desk.ts` creates the Northwind demo desk through the same
capability executor a person uses: customers, conversations, messages, ticket
fields, an escalation, two resolutions, canned replies, knowledge articles, and
internal tickets. It reuses demo customers by email, replaces only their
conversations, and leaves invoices and other business records alone. Timestamps
are backdated after the governed writes so the queue looks like a working desk.
The one unbound website-widget escalation is inserted directly because the
public widget start is not a staff capability; it reproduces the shape the
public route creates. The seed creates demo widget settings only when the
workspace has none, so an existing embed token, auto-reply choice, or greeting
is never overwritten. `--billing` optionally creates one unpaid invoice when
Accounting is enabled.

## Consequences

- A new business app is a registry entry plus its routes, not another global
  rail item. The command palette and the flat rail stay intact.
- Support is independently useful for inbound work: the queue, thread, ticket
  fields, knowledge, channels, and billing context work from `/support`, and
  the queue and thread have shareable URLs. Starting a conversation with a new
  customer still uses the shared CRM write path.
- The support read contract is wider. The frontend strict schemas, the API
  tests, and the Go integration assertions must move together. The legacy
  agent projection is the compatibility boundary.
- The billing context depends on `support.read` and on invoices existing. It
  degrades to "No invoices on record" or a visible failure, never to a made-up
  figure.
- The customer picker read now accepts `support.read` as well as `crm.read` or
  `pos.sell`, so a support-only role can start a conversation with an existing
  customer. Creating a brand-new customer still uses the CRM write path; a
  support-only role needs a customer to exist first, or the widget can start an
  unbound thread.
- Assignment to another teammate still uses the shared team read, which needs
  `iam.read`. A support-only role can always assign to itself or unassign. The
  next iteration should add a support-scoped member read so full assignment
  does not depend on the identity module.
- The global rail still shows modules that a restricted workspace has not
  installed. Module-aware rail filtering and an app focus mode are the next
  composability step.
- The support schema still has no internal notes, tags, snooze, first-response
  timer, or resolution timer. The app does not fake them. Adding any of those is
  a schema and capability change, not a CSS change.
- The app includes unbound website widget conversations so an auto-reply
  handoff reaches a person, but binding a visitor to a verified customer still
  needs a governed bind capability and an explicit identity check. That is the
  next support-specific slice.

## Verification

- `src/apps/support/support-model.test.ts` covers routes, filters, sorting, SLA
  state, handoff parsing, attention ranking, money formatting, and pending
  action copy.
- `src/apps/support/SupportApp.test.tsx` covers the app tabs, deep links,
  queue filters, staff and customer messages, copilot drafts, quick replies,
  resolve, escalation, ticket edits, new conversations, unbound widget threads, module-disabled state,
  retry recovery, failed writes, knowledge, and channel settings.
- `apps/api/internal/capability/support_test.go` pins the order-lookup and
  conversation-read parse distinction.
- The Go support integration tests assert the new queue fields and the
  unchanged legacy detail projection.
- A browser run at 1440x1000 and 390x844 verified the three-pane desk, the
  horizontal tabs, the context panel, the mobile thread, and zero console or
  request errors.

## References

- [ChasteDesk reference](https://github.com/benaiah-muga/ChasteDesk)
- [Flat workspace navigation](../../docs/adr/0096-flat-workspace-navigation-and-content-shaped-loading.md)
- [Customer care agent](../../docs/adr/0025-customer-care-agent.md)
- [Brand shell and inbox](../../docs/adr/0091-brand-system-command-shell-and-inbox.md)
- [App registry](../../apps/web-vite/src/shell/apps.ts)
- [Support app](../../apps/web-vite/src/apps/support/SupportApp.tsx)
- [Support seed](../../scripts/seed-support-desk.ts)
