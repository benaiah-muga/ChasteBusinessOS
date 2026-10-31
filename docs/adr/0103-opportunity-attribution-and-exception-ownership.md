# ADR 0103: Opportunity attribution and exception ownership stay explicit

Status: accepted (2026-10-29)

## Context

The workflow continuity slice connected quote, order, delivery, invoice, and
collection, but two joins were still missing or unsafe:

- A quote could not say which CRM opportunity it came from. The top of
  quote-to-cash was still a customer-level guess, and the deal pipeline could
  not be reconciled to the revenue documents.
- An exception could be owned, but only by taking it for yourself. The
  governed record accepts any user UUID, and the inbox had no way to assign a
  colleague or show ownership beyond "assigned to you".

Both gaps are about the same product property: a workflow record must name the
real business object and the real person responsible without letting a caller
invent either relationship.

## Decision

### Quote attribution

- `quotes.deal_id` is a nullable reference to `deals`, set once when the quote
  is created.
- `accounting.createQuote` accepts an optional `dealId`. The deal must belong
  to the same organization. If the deal has a customer, the quote customer must
  match it; a mismatch is a business refusal, not a silent reassignment.
- Quote reads return `dealId` and `dealTitle` through a left join, so the sales
  workspace can show the opportunity without a second permission-sensitive
  lookup.
- Awarding a quote does **not** move the deal. Stage changes remain an explicit
  `crm.moveDealStage` action. The quote-to-cash skill instructs the actor to
  move the linked deal to won only after the order is confirmed, because a
  quote is an offer and an order confirmation is the commitment.
- The customer remains required on the quote. A deal without a customer can be
  linked, but the user still chooses the billing customer.

### Exception ownership

- `operations.upsertRecord` now refuses an `ownerUserId` who is not a member of
  the organization. This closes the gap where an agent or caller could assign a
  record to a user UUID from another tenant.
- The inbox assigns through the same governed record path. It lists organization
  members, shows the owner's name, preserves the owner through acknowledge and
  resolve actions, and offers an "Mine" queue.
- Assignment acknowledges the exception. Resolving or reopening it does not
  clear ownership.
- There is no separate assignment table. The operational record remains the one
  durable case, and every assignment is a revision in its audit history.

## Consequences

- A quote has at most one source opportunity. Reporting can rely on the link
  without parsing memos or matching customers by time window.
- Editing a deal's customer after a quote exists does not rewrite the quote;
  the quote keeps the customer and deal it was written against.
- Deal stage remains a human or agent decision through the governed CRM
  capability. Automatic "won" on quote award was rejected because it would
  overstate commitment and would bypass CRM audit semantics.
- Cross-tenant assignment is now a typed 422 refusal. Existing self-assignment
  and Workmate assignment continue through the same path.
- The inbox needs `iam` team-read visibility to offer the member list. Without
  it, assignment is hidden rather than failing the whole inbox.

## Verification

- `TestGoAccountingQuotesAttachDealAttribution` proves the stored link, the
  read projection, the customer-mismatch refusal, and foreign-deal isolation.
- Quote parser tests prove `dealId` validation.
- The Vite quote workspace tests prove the opportunity selector, customer
  prefill, payload, and attributed quote display.
- `TestOperationalRecordsPersistDeduplicateAndCard` proves member ownership and
  the foreign-owner refusal.
- Inbox tests prove assignment to a colleague, owner display, and the Mine
  filter.
