import { describe, expect, it } from "vitest";
import { calculateTaxSettlementDelta } from "./tax";

describe("tax settlement deltas", () => {
  it("settles output tax after recoverable input tax", () => {
    expect(calculateTaxSettlementDelta({ outputTaxMinor: 1_500, inputTaxMinor: 400 })).toEqual({
      outputDeltaMinor: 1_500,
      inputDeltaMinor: 400,
      taxDeltaMinor: 1_100,
    });
  });

  it("posts a refund when input tax exceeds output tax", () => {
    expect(calculateTaxSettlementDelta({ outputTaxMinor: 100, inputTaxMinor: 280 }).taxDeltaMinor).toBe(-180);
  });

  it("settles only the difference from the latest settled return", () => {
    expect(calculateTaxSettlementDelta(
      { outputTaxMinor: 1_700, inputTaxMinor: 450 },
      { outputTaxMinor: 1_500, inputTaxMinor: 400 },
    )).toEqual({ outputDeltaMinor: 200, inputDeltaMinor: 50, taxDeltaMinor: 150 });
  });

  it("supports a tax control adjustment with no cash movement", () => {
    expect(calculateTaxSettlementDelta(
      { outputTaxMinor: 1_600, inputTaxMinor: 500 },
      { outputTaxMinor: 1_500, inputTaxMinor: 400 },
    ).taxDeltaMinor).toBe(0);
  });

  it("rejects unsafe or negative snapshot amounts", () => {
    expect(() => calculateTaxSettlementDelta({ outputTaxMinor: Number.MAX_SAFE_INTEGER, inputTaxMinor: 0 }, { outputTaxMinor: 0, inputTaxMinor: Number.MAX_SAFE_INTEGER })).toThrow("supported amount range");
    expect(() => calculateTaxSettlementDelta({ outputTaxMinor: -1, inputTaxMinor: 0 })).toThrow("non-negative safe integer");
  });
});
