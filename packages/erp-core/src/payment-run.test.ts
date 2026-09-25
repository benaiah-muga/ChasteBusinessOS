import { describe, expect, it } from "vitest";
import { validatePaymentRun } from "./payment-run";

describe("supplier payment run validation", () => {
  const first = { billId: "a", currency: "UGX", outstandingMinor: 120_000, payMinor: 100_000 };

  it("totals same-currency partial and full payments exactly", () => {
    expect(validatePaymentRun([first, { billId: "b", currency: "UGX", outstandingMinor: 50_000, payMinor: 50_000 }])).toMatchObject({
      currency: "UGX",
      totalMinor: 150_000,
      billCount: 2,
    });
  });

  it("rejects duplicate, mixed-currency, zero, and over-balance selections", () => {
    expect(() => validatePaymentRun([first, first])).toThrow(/only once/);
    expect(() => validatePaymentRun([first, { ...first, billId: "b", currency: "USD" }])).toThrow(/same currency/);
    expect(() => validatePaymentRun([{ ...first, payMinor: 0 }])).toThrow(/must be positive/);
    expect(() => validatePaymentRun([{ ...first, payMinor: 120_001 }])).toThrow(/exceeds/);
  });
});
