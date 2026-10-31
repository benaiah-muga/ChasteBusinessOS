# ADR 0089: Money approvals are versioned proposals and quote awards carry lines

Status: accepted

## Context

A purchase commitment is prepared, reviewed, and then executed. If the
requester changes the quantity, supplier, or price while an earlier version is
still pending, the older approval must not remain independently executable.
The previous approval row bound the payload hash but had no version or link to
the version it replaced.

Quote awards had a second gap. An RFQ stored one total and optional lead time,
so the winning award created a purchase order with one synthetic line for the
whole quote. The resulting order could not be received or reconciled line by
line.

## Decision

- For the two purchase commitment capabilities, a new approval from the same
  requester supersedes every pending approval for the same organization and
  capability. The new row gets the next version and a
  `supersedes_approval_id` link. The superseded row moves to `superseded` and
  can no longer be approved or executed.
- The approval payload hash remains the exact authority binding. Versioning
  changes which proposal is live; it does not weaken the hash check.
- Versioning is intentionally limited to `purchasing.createPurchaseOrder` and
  `purchasing.selectWinningQuote`. Other money capabilities keep independent
  pending approvals.
- Add `rfq_quote_lines` with position, description, quantity in thousandths,
  unit price, and optional SKU. `purchasing.recordQuote` accepts optional
  lines, requires their total to equal `amountMinor`, and replaces the prior
  lines on a requote.
- `purchasing.selectWinningQuote` copies the stored lines into the purchase
  order, preserving position and amount. A legacy quote without lines keeps
  the single synthetic line so existing records remain awardable.
- The quote UI still records a total, not line entry. Lines can be supplied
  through the capability API until the purchasing surface adds a line editor;
  the award path is ready for it.

## Consequences

A revised purchase proposal invalidates the earlier approval instead of
leaving two executable versions. A quote award can now produce a real
multi-line order, so receipt and remaining-quantity checks work line by line.
The approval inbox exposes the version and superseded link, and superseded
rows appear in history. The remaining gap is the human quote-line editor and
mandate-level cumulative limits, which remain separate work.
