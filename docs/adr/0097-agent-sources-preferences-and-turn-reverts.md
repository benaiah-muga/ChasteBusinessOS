# ADR 0097: Agent sources, notification preferences, and turn reverts

Date: 2026-10-23
Status: Accepted

## Context

The workmate could read history and revert one action, but it could not accept
the record a person was looking at, could not mark its own notification read,
and could not reverse a turn that changed several things. Notification
delivery was all-or-nothing per person, and repeat filtering work was lost
between visits.

## Decision

1. **Sources are explicit and permission-checked.** A chat turn accepts up to
   five `{type,id,title}` attachments from the same search surface as the
   command palette. The server validates type, UUID, title, and duplicates,
   persists the attachments on the user event, and appends the exact ids to
   the model goal. The ids are clues, not authorization: every later read and
   write still goes through the capability kernel.

2. **The composer search is the only source picker.** It uses the existing
   permission-aware `GET /api/search`, so a person cannot attach a record they
   cannot read. A PDF or image is first ingested into Documents, then attached
   as a document source. The chat does not accept arbitrary raw file bytes as
   model context.

3. **Turn reverts are planned before execution.** A turn revert loads every
   successful write-bearing tool result with the same `turnId`, skips reads,
   requires a declared inverse for every write, and executes the inverses in
   reverse order with the same human authority and deterministic intent keys as
   single-action reverts. If any action is unsupported, nothing is executed and
   the response names the unsupported capabilities. If one inverse needs
   approval, execution stops and reports the partial outcome instead of
   pretending the turn is fully reverted.

4. **Turn ids are stamped on every persisted turn event.** User, tool, ask,
   final, stopped, and steering events carry the same `turnId`. Old events
   without a turn id remain eligible for single-action reverts only.

5. **Notification preferences are per person and per kind.** A
   `notification_preferences` table stores muted kinds for one user in one
   organization. The feed and unread count exclude muted kinds; the audit rows
   stay. Approval authority is independent: muting an approval notification
   never removes the approval from the inbox. Email delivery continues to use
   workspace SMTP settings and is not silently changed by in-app preferences.

6. **Mark-read is self-scoped but governed.** `notifications.markRead` remains
   a capability with its restore inverse. It is exposed directly for
   notification requests, is discoverable in capability search, and can be
   undone from a turn revert.

7. **Saved views are personal first.** Invoices, Inventory, and Agent sessions
   store named filter states per organization in browser storage. CRM keeps
   its server-backed shared views. A future shared view service should replace
   the browser store without changing the bar's interaction.

## Consequences

- A person can point at the invoice or document they mean without pasting raw
  IDs, and the model still cannot use a source outside the person's access.
- A whole turn can be corrected in one action when all writes are declared
  reversible; mixed or irreversible turns fail closed and tell the person
  which capabilities blocked them.
- Muted notifications disappear from the personal feed but remain auditable,
  and approvals remain authoritative.
- Saved views are immediate and private but do not sync across devices yet.
  That limitation is visible in the product copy and should be removed by a
  shared view service.

## References

- [Chat session](../../apps/api/internal/httpapi/chat_session.go)
- [Session revert](../../apps/api/internal/httpapi/session_revert.go)
- [Notification preferences](../../apps/api/internal/httpapi/notification_preferences.go)
- [Saved view bar](../../apps/web-vite/src/ui/saved-view-bar.tsx)
- [Composer sources](../../apps/web-vite/src/components/ChatPage.tsx)
