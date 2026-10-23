# ADR 0094: Approval plans, cross-record search, and wider entity resolution

Date: 2026-10-22
Status: Accepted

## Context

The approvals queue showed the payload, rationale, and related documents, but
a person still had to infer the accounting direction, the stock effect, and
what would reverse a decision. Trust in a governed action depends on seeing
the plan before approving it.

The command palette searched pages, not records. People knew a customer,
invoice, or document name and still had to open a workspace and search again.
The workmate had the same gap: it could list whole collections or guess an id.

Entity resolution covered customers, vendors, items, employees, and projects,
but writes also need invoices, supplier bills, goods receipts, and documents.

## Decision

1. **Show an execution plan on every approval.** The approvals card renders
   concrete steps for the common money and stock capabilities, the projected
   ledger direction, the inverse that can reverse the action, and the risk
   class. The plan is generated from the capability id and the stored payload,
   so it cannot drift from what the executor will run.

2. **Add permission-aware cross-record search.** `GET /api/search?q=` searches
   customers, suppliers, items, invoices, supplier bills, documents, and
   projects in one organization-scoped read. Each table is queried only when
   the signed user holds its read permission. Results carry a canonical id,
   title, subtitle, and workspace link.

3. **Surface records in the command palette.** The palette debounces the query,
   aborts stale reads, and renders a Records group before the workmate fallback.
   A record opens its owning workspace; the unmatched query still offers Ask
   Workmate.

4. **Expand entity resolution before writes.** `resolve_entity` now covers
   invoices by number or customer, supplier bills by number or supplier,
   goods receipts by number, and documents by title, in addition to the
   original five types. The same read permissions apply.

5. **Keep notification mark-read governed by permission.** `notifications.markRead`
   is in the reviewed capability catalog with its inverse, and the executor
   accepts a self-scoped agent call when the role grants `notifications.read`.
   No default role currently grants that permission, so the workmate remains
   read-only for notifications until an administrator grants it.

## Consequences

- Approval cards become a yes/no decision with a visible plan, not a payload
  inspection exercise. The plan is directional: exact posting amounts still
  come from the executor and receipt.
- Search adds one read endpoint and one palette request per debounced query.
  Permission filtering happens in the database read, not only in the browser.
- Search links use canonical ids and module query parameters. A workspace that
  later supports richer deep links can improve the destination without changing
  the API.
- `resolve_entity` grows one SQL branch per type. New entity types must be added
  with their permission and identifier fields, not as a generic table scan.
- Mark-read is a write with an inverse, so the audit ledger can explain it.
- Saved views outside CRM, notification preferences, session checkpoints, and
  attachment ingestion remain separate work.

## Alternatives considered

- **Compute exact journal lines in the browser.** Rejected: the posting logic
  lives in the capability kernel, and duplicating account selection would drift.
- **Use the workmate for cross-record search.** Rejected: a command palette
  needs deterministic latency and no model round trip.
- **Expose one generic SQL search.** Rejected: permissions, result shapes, and
  links differ by record type.
- **Mark notifications read from the notification feed handler.** Rejected:
  writes already have a governed capability and inverse.

## References

- [Tool-aware history ADR](0093-tool-aware-history-and-agent-operating-surfaces.md)
- [Capability manifest](../migration/capabilities.json)
- [Record search handler](../../apps/api/internal/httpapi/record_search_session.go)
- [Approvals page](../../apps/web-vite/src/components/ApprovalsPage.tsx)
- [Command palette](../../apps/web-vite/src/ui/command-palette.tsx)
