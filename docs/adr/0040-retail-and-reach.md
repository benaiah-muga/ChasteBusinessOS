# ADR 0040: Retail & reach

Date: 2026-09-01
Status: Accepted (M13, demand confirmed by the owner proceeding)

## Decision

- **POS returns are full-sale reversals at the register.**
  `pos.returnSale` mirrors the original sale entry exactly (reverseEntry
  mechanics), credits the invoice on an immutable column, and mirrors the
  sale's negative stock legs positively — the original sale is never
  edited. Always gates (moneyAmount → null). POS sales are paid at the
  register, so the refundable amount is total minus already-returned;
  partial credits belong to accounting.creditNote.
- **Shift summaries derive** from sessions, their invoices, and the
  counted-cash columns the close flow already maintains.
- **Marketing-lite is honest by omission**: segments are saved
  deterministic filters (lifetime-spend threshold), campaigns resolve
  recipients at send time, opt-out is honored at send time (never a
  pixel-level pretense), and the append-only send log IS the analytics.
  Transport is the send log itself — no email transport exists in-repo,
  and no tracking pixels, journeys, or landing pages by explicit
  non-goal.
