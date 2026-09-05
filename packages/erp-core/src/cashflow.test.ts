import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildCashFlowStatement, cashBalanceFromEntries, classifyCashEntry, type CashFlowEntry, type CashFlowLine } from "./cashflow.js";

/**
 * The direct-method statement is only trustworthy if it ties. These
 * properties encode the guarantees: balanced entries conserve cash exactly,
 * buckets conserve, closing chains from opening, and the derived closing
 * equals an independent recomputation of the cash balance.
 */

const CASH = ["1000"];
const COUNTERS: Array<{ code: string; type: CashFlowLine["accountType"] }> = [
  { code: "1100", type: "asset" },
  { code: "1200", type: "asset" },
  { code: "2000", type: "liability" },
  { code: "2100", type: "liability" },
  { code: "4000", type: "income" },
  { code: "5000", type: "expense" },
  { code: "3000", type: "equity" },
  { code: "1500", type: "asset" }, // equipment — investing
];

const arbEntry = fc
  .tuple(fc.nat(COUNTERS.length - 1), fc.integer({ min: 1, max: 1_000_000 }), fc.boolean(), fc.nat(30))
  .map(([pick, amount, cashDebit, day]) => {
    const counter = COUNTERS[pick]!;
    const cashLine: CashFlowLine = {
      accountCode: "1000",
      accountType: "asset",
      debitMinor: cashDebit ? amount : 0,
      creditMinor: cashDebit ? 0 : amount,
    };
    const counterLine: CashFlowLine = {
      accountCode: counter.code,
      accountType: counter.type,
      debitMinor: cashDebit ? 0 : amount,
      creditMinor: cashDebit ? amount : 0,
    };
    return { occurredAt: new Date(Date.UTC(2026, 0, 1 + day)), lines: [cashLine, counterLine] } satisfies CashFlowEntry;
  });

const arbEntries = fc.array(arbEntry, { maxLength: 40 });

describe("cash flow (M10.1)", () => {
  it("per-entry cash delta is exactly minus the counter delta (balanced books)", () => {
    fc.assert(
      fc.property(arbEntries, fc.nat(1_000_000), (entries, _opening) => {
        for (const e of entries) {
          const c = classifyCashEntry(e.lines, CASH)!;
          const counterSum = e.lines
            .filter((l) => !CASH.includes(l.accountCode))
            .reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
          expect(c.cashDeltaMinor).toBe(-counterSum);
        }
      }),
    );
  });

  it("closing equals opening plus net, and ties to the independent cash balance", () => {
    fc.assert(
      fc.property(arbEntries, fc.integer({ min: -1_000_000, max: 5_000_000 }), (entries, opening) => {
        const s = buildCashFlowStatement(entries, { cashCodes: CASH, openingMinor: opening });
        expect(s.closingMinor).toBe(opening + s.netMinor);
        expect(s.netMinor).toBe(
          s.operating.netMinor + s.investing.netMinor + s.financing.netMinor,
        );
        expect(s.ties).toBe(true);
        expect(s.cashBalanceMinor).toBe(cashBalanceFromEntries(entries, CASH));
      }),
    );
  });

  it("classifies deterministically: equity → financing, non-trading assets → investing, trading → operating", () => {
    const mk = (counter: CashFlowLine): CashFlowEntry => ({
      occurredAt: new Date(0),
      lines: [
        { accountCode: "1000", accountType: "asset", debitMinor: 100, creditMinor: 0 },
        counter,
      ],
    });
    expect(classifyCashEntry(mk({ accountCode: "3000", accountType: "equity", debitMinor: 0, creditMinor: 100 })!.lines, CASH)!.category).toBe("financing");
    expect(classifyCashEntry(mk({ accountCode: "1500", accountType: "asset", debitMinor: 0, creditMinor: 100 }).lines, CASH)!.category).toBe("investing");
    expect(classifyCashEntry(mk({ accountCode: "1100", accountType: "asset", debitMinor: 0, creditMinor: 100 }).lines, CASH)!.category).toBe("operating");
    expect(classifyCashEntry(mk({ accountCode: "5000", accountType: "expense", debitMinor: 100, creditMinor: 0 }).lines, CASH)!.category).toBe("operating");
  });

  it("entries that never touch cash are excluded from the direct method", () => {
    const nonCash: CashFlowEntry = {
      occurredAt: new Date(0),
      lines: [
        { accountCode: "1100", accountType: "asset", debitMinor: 500, creditMinor: 0 },
        { accountCode: "4000", accountType: "income", debitMinor: 0, creditMinor: 500 },
      ],
    };
    expect(classifyCashEntry(nonCash.lines, CASH)).toBeNull();
    const s = buildCashFlowStatement([nonCash], { cashCodes: CASH, openingMinor: 1_000 });
    expect(s.operating.entries).toBe(0);
    expect(s.ties).toBe(true);
  });
});
