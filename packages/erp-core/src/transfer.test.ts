import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { replayValuation, type CostedMovement } from "./inventory";
import { assertTransferFeasible, transferConserved, transferLegs } from "./transfer";

describe("transferLegs", () => {
  it("pairs an out leg with an equal in leg", () => {
    expect(transferLegs(5_000)).toEqual({ out: -5_000, inn: 5_000 });
  });

  it("refuses zero, negative, and fractional quantities", () => {
    expect(() => transferLegs(0)).toThrow(/positive integer/);
    expect(() => transferLegs(-1_000)).toThrow(/positive integer/);
    expect(() => transferLegs(1.5)).toThrow(/positive integer/);
  });
});

describe("assertTransferFeasible", () => {
  it("allows exactly-draining the source but never overdrawing", () => {
    expect(() => assertTransferFeasible(5_000, 5_000)).not.toThrow();
    expect(() => assertTransferFeasible(4_999, 5_000)).toThrow(/insufficient stock at source/);
  });
});

describe("transfers (property-based)", () => {
  it("(property) any sequence of feasible transfers conserves the two-bucket total and never goes negative", () => {
    const commands = fc.array(
      fc.integer({ min: 1, max: 400 }).map((qty) => qty * 10),
      { maxLength: 40 },
    );

    fc.assert(
      fc.property(commands, fc.integer({ min: 0, max: 100_000 }), (quantities, initialSource) => {
        let source = initialSource;
        let destination = 0;
        const totalBefore = source + destination;
        for (const q of quantities) {
          const before = { source, destination };
          try {
            assertTransferFeasible(source, q);
          } catch {
            continue; // infeasible transfers are refused and skipped
          }
          const legs = transferLegs(q);
          source += legs.out;
          destination += legs.inn;
          expect(transferConserved(before, { source, destination })).toBe(true);
        }
        expect(source).toBeGreaterThanOrEqual(0);
        expect(destination).toBeGreaterThanOrEqual(0);
        expect(source + destination).toBe(totalBefore);
        return true;
      }),
      { seed: 20260901, numRuns: 200 },
    );
  });

  it("(property) value is untouched by value-neutral legs in valuation replay", () => {
    const historyArb = fc
      .tuple(
        fc.array(fc.integer({ min: -3_000, max: 3_000 }), { minLength: 1, maxLength: 25 }),
        fc.integer({ min: 500, max: 4_000 }),
      )
      .map(([deltas, baseCost]) => {
        const movements: CostedMovement[] = [];
        let onHand = 0;
        for (const d of deltas) {
          if (d < 0 && onHand + d < 0) continue;
          movements.push({ quantityDelta: d, unitCostMinor: d > 0 ? baseCost : undefined });
          onHand += d;
        }
        return movements;
      })
      .filter((m) => m.length > 0);

    fc.assert(
      fc.property(historyArb, fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 1, max: 5 }), (movements, transferQty, times) => {
        const base = replayValuation(movements);
        if (base.quantityOnHand < transferQty) return true;
        const withTransfers = [...movements];
        for (let i = 0; i < times; i++) {
          withTransfers.push({ quantityDelta: -transferQty, valueNeutral: true });
          withTransfers.push({ quantityDelta: transferQty, valueNeutral: true });
        }
        const after = replayValuation(withTransfers);
        expect(after.totalValueMinor).toBe(base.totalValueMinor);
        expect(after.quantityOnHand).toBe(base.quantityOnHand);
        return true;
      }),
      { seed: 20260902, numRuns: 200 },
    );
  });
});
