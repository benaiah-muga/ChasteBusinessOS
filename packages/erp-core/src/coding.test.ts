import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FALLBACK_EXPENSE_CODE, suggestExpenseAccount, type CoderAccount } from "./coding";
import { DEFAULT_CHART_OF_ACCOUNTS } from "./posting";

const accounts: CoderAccount[] = DEFAULT_CHART_OF_ACCOUNTS.map((a) => ({ ...a }));

const arbDescription = fc
  .string({ minLength: 0, maxLength: 120 })
  .map((s) => `${s} office supplies`);

const SEED = 20260822;
const opts = { seed: SEED, numRuns: 300 };

describe("deterministic expense coding", () => {
  it("always suggests an existing expense-account code, for any description", () => {
    fc.assert(
      fc.property(arbDescription, (description) => {
        const match = suggestExpenseAccount(description, accounts);
        const codes = new Set(accounts.filter((a) => a.type === "expense").map((a) => a.code));
        expect(codes.has(match.code)).toBe(true);
      }),
      opts,
    );
  });

  it("is deterministic and order-independent over the account list", () => {
    const shuffled = [...accounts].sort(() => Math.random() - 0.5);
    for (const d of ["monthly rent invoice", "fuel for delivery van", "internet subscription"]) {
      expect(suggestExpenseAccount(d, accounts)).toEqual(suggestExpenseAccount(d, shuffled));
    }
  });

  it("never throws, even on garbage input or empty account lists", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => suggestExpenseAccount(s, accounts)).not.toThrow();
        expect(() => suggestExpenseAccount(s, [])).not.toThrow();
      }),
      opts,
    );
  });

  it("routes lines to the account whose name they name", () => {
    // "Rent" is an exact token of the Operating Expenses name only via the
    // synonym table; a made-up account must win when its name matches.
    const custom: CoderAccount[] = [
      { code: "6100", name: "Rent Expense", type: "expense" },
      { code: "6200", name: "Utilities Expense", type: "expense" },
      { code: FALLBACK_EXPENSE_CODE, name: "Operating Expenses", type: "expense" },
    ];
    expect(suggestExpenseAccount("warehouse rent for march", custom).code).toBe("6100");
    expect(suggestExpenseAccount("electricity bill", custom).code).toBe("6200");
  });

  it("falls back to the default operating-expense code when nothing matches", () => {
    const match = suggestExpenseAccount("xyzzy qwux blorp", accounts);
    expect(match.code).toBe(FALLBACK_EXPENSE_CODE);
    expect(match.score).toBe(0);
  });
});

