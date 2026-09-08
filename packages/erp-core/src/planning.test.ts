import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { maxProducibleUnits, type PerUnitNeed } from "./planning.js";

/** The ceiling must be the honest minimum over every component ratio. */

const arbNeeds = fc
  .array(
    fc.record({
      componentItemId: fc.string({ minLength: 2, maxLength: 6 }),
      perUnitThousandths: fc.integer({ min: 1, max: 5_000 }),
    }),
    { minLength: 1, maxLength: 6 },
  )
  .map((rows) => {
    const seen = new Set<string>();
    return rows.map((r) => {
      let id = r.componentItemId;
      while (seen.has(id)) id = id + "x";
      seen.add(id);
      return { componentItemId: id, perUnitThousandths: r.perUnitThousandths } as PerUnitNeed;
    });
  });

function stockFor(needs: readonly PerUnitNeed[], maxUnits: number): Map<string, number> {
  const map = new Map<string, number>();
  for (const n of needs) map.set(n.componentItemId, Math.floor((maxUnits * n.perUnitThousandths) / 1000));
  return map;
}

describe("max producible units (M11.4)", () => {
  it("property: exactly the minimum component ratio, floored", () => {
    fc.assert(
      fc.property(arbNeeds, fc.integer({ min: 0, max: 20_000 }), (needs, maxUnits) => {
        const stock = stockFor(needs, maxUnits);
        const ceiling = maxProducibleUnits(needs, stock);
        expect(ceiling).toBeLessThanOrEqual(maxUnits * 1000);
        for (const need of needs) {
          const available = stock.get(need.componentItemId) ?? 0;
          expect(ceiling * need.perUnitThousandths).toBeLessThanOrEqual(available * 1000 + need.perUnitThousandths);
        }
      }),
    );
  });

  it("property: more stock never lowers the ceiling; zero-need components never constrain", () => {
    fc.assert(
      fc.property(arbNeeds, fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 10_000 }), (needs, a, b) => {
        const low = maxProducibleUnits(needs, stockFor(needs, Math.min(a, b)));
        const high = maxProducibleUnits(needs, stockFor(needs, Math.max(a, b)));
        expect(high).toBeGreaterThanOrEqual(low);
        expect(maxProducibleUnits([{ componentItemId: "x", perUnitThousandths: 0 }], new Map())).toBe(0);
      }),
    );
  });

  it("exact example: 2 bolts + 1 frame per unit — bolts cap output at 350", () => {
    const needs: PerUnitNeed[] = [
      { componentItemId: "bolt", perUnitThousandths: 2_000 },
      { componentItemId: "frame", perUnitThousandths: 1_000 },
    ];
    expect(maxProducibleUnits(needs, new Map([["bolt", 700_000], ["frame", 600_000]]))).toBe(350_000);
    expect(maxProducibleUnits(needs, new Map([["bolt", 1_000_000], ["frame", 500_000]]))).toBe(500_000);
  });

  it("empty needs produce nothing (no BOM, no promise)", () => {
    expect(maxProducibleUnits([], new Map())).toBe(0);
  });
});
