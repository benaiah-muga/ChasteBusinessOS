import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateExpensePolicy, findDuplicateExpenseClaims, suggestExpenseCategory, type ExpenseClaimRecord } from "./expenses.js";

/** Category suggestions and duplicate pairing must be deterministic and honest. */

const base = new Date(Date.UTC(2026, 7, 1));

function claim(id: string, userId: string, amountMinor: number, days: number): ExpenseClaimRecord {
  return { id, claimantUserId: userId, amountMinor, submittedAt: new Date(base.getTime() + days * 86_400_000) };
}

describe("expense intelligence (M11.6)", () => {
  it("rules-first categories are deterministic and keyword-honest", () => {
    expect(suggestExpenseCategory("Taxi to client meeting")).toBe("travel");
    expect(suggestExpenseCategory("Team lunch at the bistro")).toBe("meals");
    expect(suggestExpenseCategory("Figma subscription renewal")).toBe("software");
    expect(suggestExpenseCategory("Printer paper restock")).toBe("supplies");
    expect(suggestExpenseCategory("Mystery item")).toBe("other");
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (memo) => {
        expect(suggestExpenseCategory(memo)).toBe(suggestExpenseCategory(memo));
      }),
    );
  });

  it("flags a same-claimant same-amount repeat inside the window only", () => {
    const claims = [
      claim("a", "u1", 5_000, 0),
      claim("b", "u1", 5_000, 2),
      claim("c", "u2", 5_000, 1), // different claimant — never flags
      claim("d", "u1", 7_000, 1), // different amount — never flags
      claim("e", "u1", 5_000, 9), // outside window — never flags
    ];
    const dupes = findDuplicateExpenseClaims(claims);
    expect(dupes).toHaveLength(1);
    expect(dupes[0]).toMatchObject({ claimIdA: "a", claimIdB: "b", claimantUserId: "u1", amountMinor: 5_000 });
  });

  it("property: order-independent, symmetric, distinct claimants never cross-flag", () => {
    const userIds = fc.constantFrom("u1", "u2", "u3");
    const arb = fc
      .array(
        fc.record({ id: fc.string({ minLength: 1, maxLength: 6 }), userId: userIds, amountMinor: fc.constantFrom(1_000, 2_000), day: fc.nat(8) }),
        { maxLength: 12 },
      )
      .map((rows) => rows.map((r, i) => claim(`${r.id}-${i}`, r.userId, r.amountMinor, r.day)));
    fc.assert(
      fc.property(arb, (claims) => {
        const a = findDuplicateExpenseClaims(claims);
        const b = findDuplicateExpenseClaims([...claims].reverse());
        expect(a).toEqual(b);
        for (const d of a) expect(d.claimIdA < d.claimIdB).toBe(true);
      }),
    );
  });

  it("policy evaluation is exact and null-safe", () => {
    const policies = [
      { category: "meals", limitMinor: 5_000 },
      { category: "travel", limitMinor: 100_000 },
    ];
    expect(evaluateExpensePolicy("meals", 5_000, policies)).toEqual({ overLimit: false, limitMinor: 5_000 });
    expect(evaluateExpensePolicy("meals", 5_001, policies)).toEqual({ overLimit: true, limitMinor: 5_000 });
    expect(evaluateExpensePolicy("other", 999_999, policies)).toEqual({ overLimit: false, limitMinor: null });
  });
});
