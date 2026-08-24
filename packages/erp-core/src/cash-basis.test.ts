import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { computeCashBasis, type CashBasisEntry } from "./cash-basis";

const CASH = new Set(["1000"]);

const accountTypes = ["asset", "liability", "equity", "income", "expense"] as const;

const arbLine = fc
  .record({
    accountCode: fc.constantFrom("1000", "1100", "4000", "6000", "3000"),
    accountType: fc.constantFrom(...accountTypes),
    debitMinor: fc.integer({ min: 0, max: 1_000_000 }),
    creditMinor: fc.integer({ min: 0, max: 1_000_000 }),
  })
  .map((l) => l as CashBasisEntry["lines"][number]);

/** Entries are balanced like real postings; unbalanced input is out of scope. */
const arbBalancedEntry = fc
  .tuple(fc.integer({ min: 1, max: 5000 }), arbLine, arbLine)
  .filter(([, a, b]) => a.accountCode !== b.accountCode)
  .map(([amt, a, b]): CashBasisEntry => ({
    occurredAt: new Date("2025-06-15T00:00:00Z"),
    lines: [
      { ...a, debitMinor: amt, creditMinor: 0 },
      { ...b, debitMinor: 0, creditMinor: amt },
    ],
  }));

describe("computeCashBasis", () => {
  it("net cash always equals cashIn − cashOut (identity by construction)", () => {
    const prop = fc.property(fc.array(arbBalancedEntry, { maxLength: 40 }), (entries) => {
      const s = computeCashBasis(entries, CASH);
      return s.netCashMinor === s.cashInMinor - s.cashOutMinor;
    });
    expect(fc.assert(prop)).toBeUndefined();
  });

  it("net cash equals the change in cash-account balance across entries", () => {
    const prop = fc.property(fc.array(arbBalancedEntry, { maxLength: 40 }), (entries) => {
      let delta = 0;
      for (const e of entries)
        for (const l of e.lines)
          if (CASH.has(l.accountCode)) delta += l.debitMinor - l.creditMinor;
      const s = computeCashBasis(entries, CASH);
      return s.netCashMinor === delta;
    });
    expect(fc.assert(prop)).toBeUndefined();
  });

  it("window filtering excludes entries outside [from, to)", () => {
    const inside: CashBasisEntry = {
      occurredAt: new Date("2025-06-15T00:00:00Z"),
      lines: [
        { accountCode: "1000", accountType: "asset", debitMinor: 100, creditMinor: 0 },
        { accountCode: "4000", accountType: "income", debitMinor: 0, creditMinor: 100 },
      ],
    };
    const before = { ...inside, occurredAt: new Date("2025-01-01T00:00:00Z") };
    const after = { ...inside, occurredAt: new Date("2026-01-01T00:00:00Z") };
    const all = computeCashBasis([before, inside, after], CASH);
    const june = computeCashBasis(
      [before, inside, after],
      CASH,
      { from: new Date("2025-06-01T00:00:00Z"), to: new Date("2025-07-01T00:00:00Z") },
    );
    expect(all.cashInMinor).toBe(300);
    expect(june.cashInMinor).toBe(100);
  });

  it("credit sales (no cash leg) never inflate cash-basis income", () => {
    const creditSale: CashBasisEntry = {
      occurredAt: new Date("2025-06-15T00:00:00Z"),
      lines: [
        { accountCode: "1100", accountType: "asset", debitMinor: 900, creditMinor: 0 },
        { accountCode: "4000", accountType: "income", debitMinor: 0, creditMinor: 900 },
      ],
    };
    const s = computeCashBasis([creditSale], CASH);
    expect(s.netCashMinor).toBe(0);
    expect(s.accrualRevenueMinor).toBe(900);
    expect(s.uncollectedMinor).toBe(900);
  });

  it("refunds net against inflows rather than double-counting gross flows", () => {
    const sale: CashBasisEntry = {
      occurredAt: new Date("2025-06-15T00:00:00Z"),
      lines: [
        { accountCode: "1000", accountType: "asset", debitMinor: 500, creditMinor: 0 },
        { accountCode: "4000", accountType: "income", debitMinor: 0, creditMinor: 500 },
      ],
    };
    const refund: CashBasisEntry = {
      occurredAt: new Date("2025-06-20T00:00:00Z"),
      lines: [
        { accountCode: "6000", accountType: "expense", debitMinor: 200, creditMinor: 0 },
        { accountCode: "1000", accountType: "asset", debitMinor: 0, creditMinor: 200 },
      ],
    };
    const s = computeCashBasis([sale, refund], CASH);
    expect(s.netCashMinor).toBe(300);
  });
});
