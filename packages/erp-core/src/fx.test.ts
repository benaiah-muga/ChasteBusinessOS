import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyRate,
  currencyMinorUnits,
  fxRateFromDecimal,
  fxRateToDecimal,
  realizedGainLoss,
  toBaseMinor,
} from "./fx";

/**
 * FX invariants (ADR 0021): rates are exact rationals; conversion is
 * deterministic half-up; rounding error is bounded by one base minor unit;
 * round-tripping a parsed decimal reproduces the same rate.
 */

describe("currencyMinorUnits", () => {
  it("covers zero, two, and three exponent currencies", () => {
    expect(currencyMinorUnits("JPY")).toBe(0);
    expect(currencyMinorUnits("USD")).toBe(2);
    expect(currencyMinorUnits("EUR")).toBe(2);
    expect(currencyMinorUnits("BHD")).toBe(3);
    expect(currencyMinorUnits("jpy")).toBe(0);
  });

  it("rejects malformed codes", () => {
    for (const bad of ["", "US", "USDD", "12$", "U D"]) {
      expect(currencyMinorUnits(bad)).toBeNull();
    }
  });
});

describe("fxRateFromDecimal", () => {
  it("parses exact decimals losslessly", () => {
    expect(fxRateFromDecimal("1.0875")).toEqual({ num: 87, den: 80 });
    expect(fxRateFromDecimal("1")).toEqual({ num: 1, den: 1 });
    expect(fxRateFromDecimal("0.5")).toEqual({ num: 1, den: 2 });
    expect(fxRateFromDecimal("150.25")).toEqual({ num: 601, den: 4 });
  });

  it("rejects garbage instead of throwing", () => {
    for (const bad of ["", "0", "-1.5", "1e3", "1.2345678901234", "abc", ".5", "1."]) {
      expect(fxRateFromDecimal(bad)).toBeNull();
    }
  });

  it("round-trips exactly for terminating decimals, within 1e-9 otherwise", () => {
    // A fraction terminates in decimal iff its reduced denominator is 2^a·5^b.
    const terminating = (den: number): boolean => {
      let d = den;
      for (const f of [2, 5]) {
        while (d % f === 0) d /= f;
      }
      return d === 1;
    };
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.integer({ min: 1, max: 10_000_000 }),
        (num, den) => {
          const dec = fxRateToDecimal({ num, den });
          const r = fxRateFromDecimal(dec);
          if (!r) return false;
          if (terminating(den)) {
            // Value equality across unreduced forms.
            return BigInt(r.num) * BigInt(den) === BigInt(num) * BigInt(r.den);
          }
          return Math.abs(r.num / r.den - num / den) < 1e-9;
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("applyRate / toBaseMinor", () => {
  it("is exact when the ratio divides evenly", () => {
    expect(toBaseMinor(10_000, { num: 109, den: 100 })).toBe(10_900);
    expect(toBaseMinor(-10_000, { num: 109, den: 100 })).toBe(-10_900);
  });

  it("rounds half-up on magnitude regardless of sign", () => {
    expect(toBaseMinor(1, { num: 1, den: 2 })).toBe(1);
    expect(toBaseMinor(-1, { num: 1, den: 2 })).toBe(-1);
    expect(toBaseMinor(5, { num: 1, den: 2 })).toBe(3); // 2.5 → 3
  });

  it("reconstructs the exact product: result*den + |remainder|*sign == amount*num", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (amount, num, den) => {
          // Remainder carries the sign of the overshoot/undershoot, so the
          // plain sum reconstructs the exact rational product.
          const { result, remainder } = applyRate(amount, { num, den });
          return BigInt(result) * BigInt(den) + BigInt(remainder) === BigInt(amount) * BigInt(num);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("the remainder stays strictly below the denominator", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 2, max: 10_000 }),
        fc.integer({ min: 2, max: 10_000 }),
        (amount, num, den) => {
          const { remainder } = applyRate(amount, { num, den });
          return Math.abs(remainder) < den;
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("realizedGainLoss", () => {
  it("is positive when settlement strengthens, negative when it weakens", () => {
    const inv = { num: 108, den: 100 };
    const stronger = { num: 110, den: 100 };
    const weaker = { num: 105, den: 100 };
    expect(realizedGainLoss(120_000, inv, stronger)).toBeGreaterThan(0);
    expect(realizedGainLoss(120_000, inv, weaker)).toBeLessThan(0);
  });

  it("is exactly zero at the same rate", () => {
    const same = fxRateFromDecimal("1.0875")!;
    expect(realizedGainLoss(999_999, same, same)).toBe(0);
  });

  it("stays bounded by one unit per unit of foreign amount times rate delta", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 90, max: 130 }),
        fc.integer({ min: 90, max: 130 }),
        (foreign, a, b) => {
          const ra = { num: a, den: 100 };
          const rb = { num: b, den: 100 };
          const gl = realizedGainLoss(foreign, ra, rb);
          const bound = foreign * (Math.abs(a - b) / 100) + 2;
          return Math.abs(gl) <= bound;
        },
      ),
      { numRuns: 400 },
    );
  });
});
