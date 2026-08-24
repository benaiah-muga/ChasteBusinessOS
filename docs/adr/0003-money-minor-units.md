# ADR 0003, Money is integer minor units; quantities are thousandths

Date: 2026-08-21 · Status: accepted

## Context
Floating-point money causes silent rounding drift, unacceptable for books.

## Decision
All monetary values are safe integers in minor units (`*_minor`). Quantities
are integers in thousandths of a unit (`quantity: 1500` = 1.5 units); line
amounts compute as `round(quantity × unitPriceMinor / 1000)`. Parsing from
major strings happens only at UI edges (`parseMajorToMinor`).

## Consequences
- Sums and comparisons are exact.
- Reports and APIs must format at display edges only.
- Fractional pricing below minor-unit precision is impossible by design.
