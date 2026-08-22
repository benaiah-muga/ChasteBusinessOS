import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildInvoiceEntryLines, buildPaymentEntryLines, computeInvoiceTotals } from "./invoice";
import { assertBalanced, UnbalancedEntryError } from "./posting";

const arbLine = () =>
  fc.record({
    quantity: fc.integer({ min: 1, max: 10_000 }),
    unitPriceMinor: fc.integer({ min: 0, max: 1_000_000 }),
    taxMinor: fc.integer({ min: 0, max: 100_000 }),
  });

const SEED = 20260822;
const opts = { seed: SEED, numRuns: 300 };

describe("double-entry invariants (property-based)", () => {
  it("every invoice posting balances, for any invoice", () => {
    const accounts = { ar: "1100", revenue: "4000", taxPayable: "2100" };
    fc.assert(
      fc.property(fc.array(arbLine(), { minLength: 1, maxLength: 20 }), (lines) => {
        let totals;
        try {
          totals = computeInvoiceTotals(lines);
        } catch (err) {
          // Zero-value invoices are rejected outright — also acceptable.
          expect((err as Error).message).toMatch(/non-zero total/);
          return;
        }
        expect(() => assertBalanced({ memo: "x", lines: buildInvoiceEntryLines(accounts, { totals }) })).not.toThrow();
      }),
      opts,
    );
  });

  it("zero-total invoices are rejected as degenerate", () => {
    expect(() =>
      computeInvoiceTotals([{ quantity: 1, unitPriceMinor: 0, taxMinor: 0 }]),
    ).toThrow(/non-zero total/);
  });

  it("every payment posting balances, for any amount", () => {
    const accounts = { cash: "1000", ar: "1100" };
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), (amountMinor) => {
        expect(() => assertBalanced({ memo: "x", lines: buildPaymentEntryLines(accounts, amountMinor) })).not.toThrow();
      }),
      opts,
    );
  });

  it("invoice total equals subtotal + tax always", () => {
    fc.assert(
      fc.property(fc.array(arbLine(), { minLength: 1, maxLength: 20 }), (lines) => {
        const t = computeInvoiceTotals(lines);
        expect(t.totalMinor).toBe(t.subtotalMinor + t.taxMinor);
      }),
      opts,
    );
  });
});

describe("balance enforcement", () => {
  it("rejects unbalanced entries", () => {
    expect(() =>
      assertBalanced({
        memo: "bad",
        lines: [
          { accountCode: "1000", debitMinor: 100, creditMinor: 0 },
          { accountCode: "4000", debitMinor: 0, creditMinor: 99 },
        ],
      }),
    ).toThrow(UnbalancedEntryError);
  });

  it("rejects single-line and double-sided lines", () => {
    expect(() =>
      assertBalanced({ memo: "solo", lines: [{ accountCode: "1000", debitMinor: 5, creditMinor: 5 }] }),
    ).toThrow();
    expect(() => assertBalanced({ memo: "one", lines: [{ accountCode: "1000", debitMinor: 5, creditMinor: 0 }] })).toThrow(
      UnbalancedEntryError,
    );
  });
});
