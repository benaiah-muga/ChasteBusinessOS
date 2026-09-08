# ADR 0036: Sales-order fulfillment model

Date: 2026-08-31
Status: Accepted (M9.2)

## Context

Quotes convert straight to invoices, but there is no document between
"customer said yes" and "we invoiced": nothing reserves stock, nothing
tracks partial shipment, nothing checks whether the customer's open
receivables already exceed a sensible ceiling. The revenue-suite plan
called for sales orders as the contract between sales and inventory.

## Decision

**One order document, reservation-anchored.** `sales_orders` carries
status `draft → confirmed → delivered | cancelled` and a `backordered`
flag. Confirming a draft checks credit headroom, then reserves stock
through the existing reservation primitives (`stock_reservations`,
refType `sales_order`). Delivery consumes those reservations, writes the
outgoing leg through the shared stock writer, and raises an invoice for
exactly what shipped via the shared `insertInvoiceWithPosting` helper —
the same write path quote acceptance and POS use (ADR 0009's one-ledger
principle applied to revenue).

- **Backorders are a flag, not a document zoo.** `confirmOrder` with
  `allowBackorder` reserves what exists and flags the shortfall.
- **Credit guard is fail-closed refusal.** Over-limit confirmations are
  refused with an actionable message (open AR + order vs limit, exact
  overshoot). Deviation from the plan's "approval routing": business-logic
  refusals are not representable as policy approvals without a new rule
  type; a refusal the human can act on immediately is the honest v1.
- **Cancellation releases untouched reservations.** Partially delivered
  orders refuse cancellation — unwind through invoice reversal instead.
- **Module placement: `modules/sales`**, unrestricted like manufacturing:
  it imports inventory's sanctioned seam (stock writer, ATP helpers) and
  accounting's invoice writer by design. Capabilities stay `sales.*`.
- **Quote expiry (M9.1)**: `quotes.expires_at`; acceptance refuses past
  expiry; `accounting.expireQuote` sweeps lapsed sent quotes; the signal
  registry surfaces lapsed-but-unmarked quotes suggesting the governed
  decline.
- **One invoice per delivery call.** Multiple deliveries produce multiple
  invoices linked by memo/ref; netting them into one invoice is deferred
  until a customer asks for consolidated billing.

## Consequences

- Available-to-promise stays truthful: reservations, not hope.
- Books balance by construction — delivery reuses the audited posting path.
- The credit refusal is visible but manual; if approval routing is ever
  wanted, it needs a policy rule type for business-logic holds (future ADR).
- Service lines (no sku) skip reservation and delivery; they invoice only
  via full delivery of stock lines or future explicit invoicing.
