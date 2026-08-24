import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { computeYearEndClose } from "./year-end";
import type { AccountBalance } from "./reports";

const arbBalance = (type: AccountBalance["type"]) =>
  fc
    .record({
      code: fc.integer({ min: 1000, max: 9999 }).map((n) => String(n)),
      name: fc.string({ minLength: 1, maxLength: 20 }),
      debitMinor: fc.integer({ min: 0, max: 10_000_000 }),
      creditMinor: fc.integer({ min: 0, max: 10_000_000 }),
    })
    .map((b) => ({ ...b, type }) as AccountBalance);

describe("computeYearEndClose", () => {
  it("closing entry is always balanced", () => {
    const prop = fc.property(
      fc.array(arbBalance("income"), { maxLength: 8 }),
      fc.array(arbBalance("expense"), { maxLength: 8 }),
      (incomes, expenses) => {
        const close = computeYearEndClose([...incomes, ...expenses], "3100");
        return close.totalDebitMinor === close.totalCreditMinor;
      },
    );
    expect(fc.assert(prop)).toBeUndefined();
  });

  it("retained earnings delta equals net income for any balance mix", () => {
    const prop = fc.property(
      fc.array(arbBalance("income"), { maxLength: 8 }),
      fc.array(arbBalance("expense"), { maxLength: 8 }),
      (incomes, expenses) => {
        const revenue = incomes.reduce((s, a) => s + a.creditMinor - a.debitMinor, 0);
        const expense = expenses.reduce((s, a) => s + a.debitMinor - a.creditMinor, 0);
        const close = computeYearEndClose([...incomes, ...expenses], "3100");
        return close.netIncomeMinor === revenue - expense;
      },
    );
    expect(fc.assert(prop)).toBeUndefined();
  });

  it("zeroes every income and expense account touched", () => {
    const balances: AccountBalance[] = [
      { code: "4000", name: "Sales Revenue", type: "income", debitMinor: 100, creditMinor: 5_000 },
      { code: "5000", name: "COGS", type: "expense", debitMinor: 1_200, creditMinor: 0 },
    ];
    const close = computeYearEndClose(balances, "3100");
    expect(close.closingLines).toContainEqual({ accountCode: "4000", debitMinor: 4_900, creditMinor: 0 });
    expect(close.closingLines).toContainEqual({ accountCode: "5000", debitMinor: 0, creditMinor: 1_200 });
    expect(close.netIncomeMinor).toBe(3_700);
    expect(close.retainedEarningsLine).toEqual({ accountCode: "3100", debitMinor: 0, creditMinor: 3_700 });
  });

  it("handles a net loss with retained earnings on the debit side", () => {
    const balances: AccountBalance[] = [
      { code: "6000", name: "Operating Expenses", type: "expense", debitMinor: 2_000, creditMinor: 0 },
      { code: "4000", name: "Sales Revenue", type: "income", debitMinor: 0, creditMinor: 500 },
    ];
    const close = computeYearEndClose(balances, "3100");
    expect(close.netIncomeMinor).toBe(-1_500);
    expect(close.retainedEarningsLine).toEqual({ accountCode: "3100", debitMinor: 1_500, creditMinor: 0 });
    expect(close.totalDebitMinor).toBe(close.totalCreditMinor);
  });

  it("no lines at all when the year has no activity", () => {
    const close = computeYearEndClose([], "3100");
    expect(close.closingLines).toHaveLength(0);
    expect(close.netIncomeMinor).toBe(0);
  });
});
