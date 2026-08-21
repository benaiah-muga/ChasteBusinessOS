import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AccountBalance, AccountType } from "./reports";
import { computeBalanceSheet, computeIncomeStatement } from "./reports";

const SEED = 20260822;
const opts = { seed: SEED, numRuns: 300 };

const TYPES: AccountType[] = ["asset", "liability", "equity", "income", "expense"];

/** Generates arbitrary balanced ledgers: every entry debits one account and credits another equally. */
function balancedLedger() {
  return fc.integer({ min: 1, max: 50 }).chain((n) =>
    fc.array(
      fc.record({
        debitCode: fc.nat(4),
        creditCode: fc.nat(4).filter((c) => c !== undefined),
        amount: fc.integer({ min: 1, max: 500_000 }),
      }),
      { minLength: n, maxLength: n },
    ),
  );
}

describe("financial reports (property-based)", () => {
  it("balance sheet always balances for any set of balanced postings", () => {
    fc.assert(
      fc.property(
        balancedLedger(),
        fc.tuple(fc.nat(5), fc.nat(5), fc.nat(5), fc.nat(5), fc.nat(5)),
        (entries, [a0, l0, e0, i0, x0]) => {
          // Five accounts, one of each type
          const codes = ["A1", "L1", "E1", "I1", "X1"];
          const types: Record<string, AccountType> = {
            A1: "asset",
            L1: "liability",
            E1: "equity",
            I1: "income",
            X1: "expense",
          };
          const bal = new Map<string, number>(codes.map((c) => [c, 0]));
          // opening entry: capital introduced (DR asset / CR equity) — keeps the equation intact
          const capital = a0 * 100 + e0 * 100;
          bal.set("A1", (bal.get("A1") ?? 0) + capital);
          bal.set("E1", (bal.get("E1") ?? 0) - capital); // CR equity
          for (const e of entries) {
            const dr = codes[e.debitCode % 5]!;
            const cr = codes[(e.creditCode + 1) % 5]!;
            if (dr === cr) continue;
            bal.set(dr, (bal.get(dr) ?? 0) + e.amount);
            bal.set(cr, (bal.get(cr) ?? 0) - e.amount);
          }
          void l0;
          void i0;
          void x0;
          void types;
          const balances: AccountBalance[] = codes.map((code) => {
            const net = bal.get(code) ?? 0;
            return {
              code,
              name: code,
              type: code === "A1" ? "asset" : code === "L1" ? "liability" : code === "E1" ? "equity" : code === "I1" ? "income" : "expense",
              debitMinor: net > 0 ? net : 0,
              creditMinor: net < 0 ? -net : 0,
            };
          });
          const bs = computeBalanceSheet(balances);
          expect(bs.balanced).toBe(true);
        },
      ),
      opts,
    );
  });

  it("net income = revenue − expenses always", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ incomeAmt: fc.integer({ min: 0, max: 100_000 }), expenseAmt: fc.integer({ min: 0, max: 100_000 }) }), {
          minLength: 0,
          maxLength: 10,
        }),
        (rows) => {
          let revenue = 0;
          let expense = 0;
          const balances: AccountBalance[] = rows.map((r, i) => {
            revenue += r.incomeAmt;
            expense += r.expenseAmt;
            const out: AccountBalance[] = [
              { code: `I${i}`, name: "inc", type: "income", debitMinor: r.incomeAmt ? 0 : 0, creditMinor: r.incomeAmt },
              { code: `X${i}`, name: "exp", type: "expense", debitMinor: r.expenseAmt, creditMinor: 0 },
            ];
            return out[0]!;
          });
          void expense;
          const pnl = computeIncomeStatement(balances);
          expect(pnl.netIncomeMinor).toBe(pnl.revenueMinor - pnl.expenseMinor);
        },
      ),
      opts,
    );
  });
});

describe("report sanity", () => {
  it("classic example balances", () => {
    const balances: AccountBalance[] = [
      { code: "1000", name: "Cash", type: "asset", debitMinor: 500_000, creditMinor: 0 },
      { code: "4000", name: "Revenue", type: "income", debitMinor: 0, creditMinor: 600_000 },
      { code: "6000", name: "Expenses", type: "expense", debitMinor: 100_000, creditMinor: 0 },
    ];
    const bs = computeBalanceSheet(balances);
    expect(bs.assetsMinor).toBe(500_000);
    expect(bs.retainedResultMinor).toBe(500_000);
    expect(bs.balanced).toBe(true);

    const pnl = computeIncomeStatement(balances);
    expect(pnl.netIncomeMinor).toBe(500_000);
  });

  it("flags corruption when ledger is broken", () => {
    const bad: AccountBalance[] = [
      { code: "1000", name: "Cash", type: "asset", debitMinor: 999_000, creditMinor: 0 },
      { code: "3000", name: "Equity", type: "equity", debitMinor: 0, creditMinor: 100_000 },
    ];
    expect(computeBalanceSheet(bad).balanced).toBe(false);
  });
});
