import { describe, expect, it } from "vitest";
import { calculateCashTender } from "./cash-tender";

describe("cash tender arithmetic", () => {
  it("returns the exact amount when the customer pays the total", () => {
    expect(calculateCashTender(12_500, 12_500)).toEqual({ tenderedMinor: 12_500, changeGivenMinor: 0 });
  });

  it("calculates change from integer minor units", () => {
    expect(calculateCashTender(12_500, 20_000)).toEqual({ tenderedMinor: 20_000, changeGivenMinor: 7_500 });
  });

  it("preserves the amount identity for a range of integer totals and tenders", () => {
    for (let total = 1; total <= 200; total += 1) {
      for (let extra = 0; extra <= 200; extra += 1) {
        const result = calculateCashTender(total, total + extra);
        expect(result.tenderedMinor - result.changeGivenMinor).toBe(total);
        expect(result.changeGivenMinor).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("rejects underpayment and fractional minor units", () => {
    expect(() => calculateCashTender(101, 100)).toThrow("at least equal");
    expect(() => calculateCashTender(100.5, 101)).toThrow("safe integer");
    expect(() => calculateCashTender(100, Number.MAX_SAFE_INTEGER + 1)).toThrow("safe integer");
  });
});
