# ADR 0099: Connect workflows with durable links, not a second orchestration engine

Status: accepted (2026-10-24)

## Context

The expert review of ChasteBusinessOS made one point clearly: the product already
has substantial module capability, but a business owner experiences a workflow,
not a module. Four journeys were named as the priority:

1. business exception management across overdue receivables, low stock, delayed
   purchasing, unusual expenses, and overdue tasks;
2. quote-to-cash from opportunity and quote through order, availability,
   fulfilment, invoice, collection, and reconciliation;
3. replenishment-to-payment from demand and cash constraints through purchase,
   receipt, bill matching, and payment approval;
4. document-to-business-action from an uploaded or pasted document to a
   reviewed record that can affect the books.

The gaps were not missing features in the main. They were broken joins:

- an accepted quote became an invoice directly, skipping stock reservation,
  credit checks, delivery, and the sales order the rest of the system already
  models;
- a delivered sales order created an invoice, but the invoice did not point
  back to the order;
- a reviewed document could not become a vendor bill, and a bill could not
  point back to its source document;
- exception signals were live-only, so acknowledging or resolving one was
  forgotten on the next load;
- the advisory skills stopped at the quote, the purchase order, or the
  document instead of carrying the process to its verified end.

## Decision

Connect the existing records and capabilities. Do not add a workflow engine,
a second task queue, or a parallel authority path.

### Quote to cash

- `quote_lines.item_id` records the catalogue item selected by an optional SKU,
  so a quote can reserve real stock when it becomes an order.
- `sales.createOrderFromQuote` awards a sent quote into a draft sales order,
  copies its lines, sets `sales_orders.quote_id` and
  `quotes.converted_order_id`, and marks the quote accepted. It posts no
  revenue, reserves no stock, and performs no credit check.
- `sales.confirmOrder` remains the authority point for credit and stock. An
  order that cannot reserve stock is a backorder, not a silent promise.
- `sales.deliverOrder` creates the invoice and sets
  `invoices.sales_order_id`, so the invoice, payment, and collection remain
  traceable to the order and quote.
- `sales.cancelOrder` is the complete inverse while the order is untouched:
  it releases reservations and returns the source quote to sent with no
  converted order.

`accounting.acceptQuote` remains for deliberate invoice-first service work.
It is no longer the preferred path, and the skill and workspace say so. This
avoids a breaking contract change while removing the accidental use of the
invoice-first path for shipped goods.

### Document to business action

- `purchasing.createBill` accepts an optional `documentId`. The document must
  belong to the organization and must not already be linked. The bill and the
  document link are written in one transaction, so a partial promotion cannot
  exist.
- The reviewer sees the extracted text and coding suggestions, edits supplier,
  supplier reference, quantity, price, and account code, then records the
  bill. The document becomes evidence, not the book entry.
- Pasted text is projected into `parsed_markdown` at ingest and marked parsed,
  because no OCR is needed. Uploaded raw bytes and `raw_text` stay private, so
  the reviewer sees extracted content without the API exposing source
  material. A parsed document with open coding suggestions and no linked
  record raises a review signal after a short grace period. That signal closes
  when the document is linked.

### Business exceptions

- Signals remain deterministic, live detection. They are not mutated into
  workflow state.
- The inbox maps a stable signal id to an `operational_records` exception with
  a stable key (`signal:<id>`). Acknowledge, assign, resolve, and reopen all go
  through `operations.upsertRecord`, so the decision is revisioned, owned,
  audited, and reversible.
- A saved exception whose signal no longer fires stays visible as "no longer
  detected" until a person resolves it. A resolved condition that still fires
  stays visible and can be reopened.
- New producers cover delayed purchase orders, overdue supplier bills,
  unusually large expense claims against category history, and parsed
  documents awaiting review.

### Replenishment to payment

No new tables were needed: purchase orders, receipts, bill lines, and payment
runs already share stable ids. The missing connection was procedural, so the
`replenishment-to-payment` skill now requires cash forecast and payables
context before a purchase proposal, then carries the user through receiving,
three-way matching, and a reviewed payment run. Read-only planning still never
commits anything.

## Consequences

- The sales order is the continuity record for shipped revenue. A quote can be
  awarded once; a second award is refused until the order is cancelled.
- The quote's source lines are the authority for the order. The order is draft
  until a person or authorized agent confirms it.
- A document can be linked to exactly one business record. A mistaken link
  currently requires a documented correction rather than a silent relink;
  that is deliberate until a reversal path is designed.
- Exception acknowledgement is a business decision, not dismissal of the
  signal. Detection and human state remain separate so a resolved condition
  cannot hide a recurrence.
- No new background workflow or scheduler was introduced. The existing
  signals registry, operational records, governed capabilities, and workmate
  remain the only coordination surfaces.

## Verification

- `TestSalesQuoteBecomesOrderAndCancellationRestoresTheQuote` proves quote to
  order, stock-backed lines, invoice linkage, and quote restoration on cancel.
- `TestPurchasingBillsLinkReviewedDocumentOnce` proves the document link is
  transactional, tenant-scoped, and single-use.
- Signal tests prove purchasing delays, expense anomalies, and document review
  signals are deterministic and tenant-scoped.
- Inbox tests prove acknowledge, ownership, resolve, and stale-exception
  rendering through the governed record path.
- `TestWorkflowSkillsReferenceExecutableCapabilities` keeps the advisory
  playbooks tied to capabilities that actually exist.
