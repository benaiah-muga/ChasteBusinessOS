import { describe, expect, it } from "vitest";
import { applyBasisPointUplift, calculateTaxLine, calculateTaxMinor, compareBudget, fxRevaluationDeltaMinor, remainingCommitmentMinor } from "./budget";

describe("budget and tax arithmetic", () => {
  it("includes unbilled commitments in projected spend without changing booked actuals", () => {
    expect(compareBudget({ planMinor: 100_000, actualMinor: 65_000, committedMinor: 40_000 })).toEqual({
      planMinor: 100_000,
      actualMinor: 65_000,
      committedMinor: 40_000,
      projectedMinor: 105_000,
      remainingBeforeCommitmentsMinor: 35_000,
      varianceMinor: 5_000,
      utilizationBps: 10_500,
    });
  });

  it("keeps large budget ratios exact and refuses unsafe derived money amounts", () => {
    expect(compareBudget({ planMinor: 1, actualMinor: Number.MAX_SAFE_INTEGER, committedMinor: 0 }).utilizationBps).toBeNull();
    expect(() => compareBudget({ planMinor: Number.MAX_SAFE_INTEGER, actualMinor: -Number.MAX_SAFE_INTEGER, committedMinor: 0 })).toThrow(/supported amount range/);
  });

  it("uses half-up integer math for small tax amounts", () => {
    expect(calculateTaxMinor(5, 1_000)).toBe(1);
    expect(calculateTaxMinor(4, 1_000)).toBe(0);
    expect(calculateTaxLine(1_000, 1_001, 1_800)).toEqual({ netMinor: 1_001, taxMinor: 180, grossMinor: 1_181 });
  });

  it("applies scenario uplift with bounded integer rounding", () => {
    expect(applyBasisPointUplift(10_000, 750)).toBe(10_750);
    expect(applyBasisPointUplift(1, 5_000)).toBe(2);
  });

  it("extracts included tax so net plus tax exactly equals the entered gross", () => {
    const result = calculateTaxLine(1_000, 1_180, 1_800, true);
    expect(result).toEqual({ netMinor: 1_000, taxMinor: 180, grossMinor: 1_180 });
    expect(result.netMinor + result.taxMinor).toBe(result.grossMinor);
  });

  it("reports FX gains as a positive asset revaluation and losses as negative", () => {
    expect(fxRevaluationDeltaMinor(10_000, 9_000, 9_500)).toBe(500);
    expect(fxRevaluationDeltaMinor(10_000, 9_000, 8_500)).toBe(-500);
  });

  it("subtracts posted bills from purchase commitments without going below zero", () => {
    expect(remainingCommitmentMinor(100_000, 25_000)).toBe(75_000);
    expect(remainingCommitmentMinor(100_000, 100_000)).toBe(0);
    expect(remainingCommitmentMinor(100_000, 125_000)).toBe(0);
    expect(() => remainingCommitmentMinor(Number.MAX_SAFE_INTEGER + 1, 0)).toThrow(/safe integer/);
  });

  it("rejects unsafe amounts and rates", () => {
    expect(() => calculateTaxMinor(Number.MAX_SAFE_INTEGER, 20_000)).toThrow(/supported amount range/);
    expect(() => compareBudget({ planMinor: -1, actualMinor: 0, committedMinor: 0 })).toThrow(/non-negative/);
  });
});
