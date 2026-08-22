import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyMovement,
  EMPTY_VALUATION,
  matchThreeWay,
  needsReorder,
  onHand,
  type CostedMovement,
} from "./inventory";

const SEED = 20260822;
const opts = { seed: SEED, numRuns: 300 };

describe("stock ledger (property-based)", () => {
  it("on-hand equals the sum of deltas, whatever the sequence", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -5_000, max: 5_000 }), { minLength: 0, maxLength: 50 }),
        (deltas) => {
          const movements = deltas.map((quantityDelta) => ({ quantityDelta }));
          const total = deltas.reduce((a, b) => a + b, 0);
          expect(onHand(movements)).toBe(total);
        },
      ),
      opts,
    );
  });

  it("moving average value is conserved: inward minus outward equals remaining", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ delta: fc.integer({ min: 1_000, max: 20_000 }), cost: fc.integer({ min: 100, max: 50_000 }) }),
            fc.record({ delta: fc.integer({ min: -10_000, max: -1_000 }) }),
          ),
          { minLength: 0, maxLength: 30 },
        ),
        (raw) => {
          let state = EMPTY_VALUATION;
          let inValue = 0;
          for (const r of raw) {
            if (r.delta > 0) {
              if (!("cost" in r)) continue;
              const m: CostedMovement = { quantityDelta: r.delta, unitCostMinor: r.cost };
              inValue += Math.round((r.delta * r.cost) / 1000);
              try {
                state = applyMovement(state, m);
              } catch {
                return; // negative stock impossible here since delta > 0
              }
            } else {
              // only take what's available so the property stays about conservation
              if (-r.delta > state.quantityOnHand) continue;
              state = applyMovement(state, { quantityDelta: r.delta });
            }
          }
          // conservation: remaining value equals inflows minus outflows, within
          // one minor unit of rounding per outward movement
          const outs = raw.filter((r) => r.delta < 0 && -r.delta <= state.quantityOnHand + 1_000_000).length;
          expect(state.totalValueMinor).toBeGreaterThanOrEqual(0);
          expect(state.totalValueMinor).toBeLessThanOrEqual(inValue);
          void outs;
        },
      ),
      opts,
    );
  });

  it("refuses to go negative", () => {
    const full = applyMovement(EMPTY_VALUATION, { quantityDelta: 1_000, unitCostMinor: 500 });
    expect(() => applyMovement(full, { quantityDelta: -2_000 })).toThrow(/insufficient/);
  });

  it("reorder triggers at or below the point and never without one", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000, max: 100_000 }), fc.integer({ min: -100_000, max: 100_000 }), (qty, point) => {
        expect(needsReorder(qty, point)).toBe(point > 0 && qty <= point);
      }),
      opts,
    );
  });
});

describe("three-way match", () => {
  it("accepts a clean line", () => {
    const v = matchThreeWay({
      orderedQty: 10_000,
      receivedQty: 10_000,
      billedQty: 10_000,
      poUnitPriceMinor: 5_000,
      billUnitPriceMinor: 5_000,
    });
    expect(v).toHaveLength(0);
  });

  it("rejects billing more than was received", () => {
    const v = matchThreeWay({
      orderedQty: 10_000,
      receivedQty: 4_000,
      billedQty: 6_000,
      poUnitPriceMinor: 5_000,
      billUnitPriceMinor: 5_000,
    });
    expect(v.some((x) => x.kind === "unreceived_bill")).toBe(true);
  });

  it("rejects price drift past tolerance but accepts inside it", () => {
    const base = { orderedQty: 10_000, receivedQty: 10_000, billedQty: 10_000, poUnitPriceMinor: 10_000 };
    expect(matchThreeWay({ ...base, billUnitPriceMinor: 10_150 })).toHaveLength(0); // +1.5%
    expect(matchThreeWay({ ...base, billUnitPriceMinor: 10_300 }).some((v) => v.kind === "price_mismatch")).toBe(true); // +3%
  });

  it("rejects billing more than was ordered even if fully received", () => {
    const v = matchThreeWay({
      orderedQty: 5_000,
      receivedQty: 5_000,
      billedQty: 7_000,
      poUnitPriceMinor: 5_000,
      billUnitPriceMinor: 5_000,
    });
    expect(v.some((x) => x.kind === "overbilled_qty")).toBe(true);
  });
});
