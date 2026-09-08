import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateCredit } from "./credit.js";

describe("evaluateCredit", () => {
  it("no configured limit always passes with null headroom", () => {
    expect(evaluateCredit(1_000_00, 999_999_00, null)).toEqual({
      decision: "no-limit",
      headroomMinor: null,
      creditLimitMinor: null,
    });
  });

  it("exact fit sits within with zero headroom (boundary)", () => {
    expect(evaluateCredit(300_00, 200_00, 500_00)).toEqual({
      decision: "within",
      headroomMinor: 0,
      creditLimitMinor: 500_00,
    });
  });

  it("over-limit reports the exact overshoot as negative headroom", () => {
    const r = evaluateCredit(300_00, 250_00, 500_00);
    expect(r.decision).toBe("over");
    expect(r.headroomMinor).toBe(-50_00);
  });

  it("property: decision and headroom agree for every input", () => {
    const arb = fc.tuple(
      fc.integer({ min: 0, max: 10_000_000 }),
      fc.integer({ min: 0, max: 10_000_000 }),
      fc.option(fc.integer({ min: 0, max: 10_000_000 }), { nil: null }),
    );
    fc.assert(
      fc.property(arb, ([ar, order, limit]) => {
        const r = evaluateCredit(ar, order, limit);
        if (limit === null) {
          expect(r.decision).toBe("no-limit");
          expect(r.headroomMinor).toBeNull();
        } else {
          expect(r.headroomMinor).toBe(limit - ar - order);
          expect(r.decision).toBe(r.headroomMinor! >= 0 ? "within" : "over");
        }
      }),
    );
  });

  it("property: monotone — more open AR never flips over-limit back to within", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (ar, order, limit, bump) => {
          const a = evaluateCredit(ar, order, limit);
          const b = evaluateCredit(ar + bump, order, limit);
          if (a.decision === "over") expect(b.decision).toBe("over");
          expect(b.headroomMinor!).toBeLessThanOrEqual(a.headroomMinor!);
        },
      ),
    );
  });
});
