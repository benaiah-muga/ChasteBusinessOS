import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PCT_SCALE,
  applyScrap,
  availableToPromise,
  cycleCountVariances,
  plannedGoodQuantity,
  previewProductionCost,
  requirementsWithScrap,
  traceLotUpstream,
} from "./manufacturing";

const qtyArb = fc.nat({ max: 10_000_000 }); // thousandths
const pctArb = fc.nat({ max: 100_000 }); // up to 100% scrap/yield

describe("applyScrap", () => {
  it("zero scrap is the identity", () => {
    fc.assert(
      fc.property(qtyArb, (q) => {
        expect(applyScrap(q, 0)).toBe(q);
        expect(applyScrap(q, -5)).toBe(q); // negative allowance clamps to none
      }),
    );
  });

  it("never decreases the requirement", () => {
    fc.assert(
      fc.property(qtyArb, pctArb, (q, p) => {
        expect(applyScrap(q, p)).toBeGreaterThanOrEqual(q);
      }),
    );
  });

  it("is monotonically increasing in the scrap percentage", () => {
    fc.assert(
      fc.property(qtyArb, pctArb, fc.nat({ max: 50_000 }), (q, p, more) => {
        expect(applyScrap(q, p + more)).toBeGreaterThanOrEqual(applyScrap(q, p));
      }),
    );
  });

  it("rounds up so fractional parts never understate demand", () => {
    // 1.001 units at 5% scrap = 1.05105 units → must round to 1.052, not 1.051.
    expect(applyScrap(1001, 50_000)).toBe(1052);
  });
});

describe("requirementsWithScrap", () => {
  it("applies each item's own allowance and leaves others untouched", () => {
    const reqs = [
      { itemId: "a", quantityThousandths: 1000 },
      { itemId: "b", quantityThousandths: 1000 },
    ];
    const out = requirementsWithScrap(reqs, new Map([["a", 100_000]]));
    expect(out[0]!.quantityThousandths).toBe(1100);
    expect(out[1]!.quantityThousandths).toBe(1000);
  });
});

describe("plannedGoodQuantity", () => {
  it("full yield passes through; zero yield produces nothing", () => {
    fc.assert(
      fc.property(qtyArb, (q) => {
        expect(plannedGoodQuantity(q, PCT_SCALE)).toBe(q);
        expect(plannedGoodQuantity(q, 0)).toBe(0);
      }),
    );
  });

  it("never exceeds planned and never goes negative", () => {
    fc.assert(
      fc.property(qtyArb, pctArb, (q, y) => {
        const good = plannedGoodQuantity(q, y);
        expect(good).toBeGreaterThanOrEqual(0);
        expect(good).toBeLessThanOrEqual(q);
      }),
    );
  });

  it("clamps yield above 100% instead of promising phantom output", () => {
    expect(plannedGoodQuantity(1000, PCT_SCALE * 3)).toBe(1000);
  });
});

describe("availableToPromise", () => {
  it("is on hand when nothing is reserved", () => {
    fc.assert(
      fc.property(qtyArb, (q) => {
        expect(availableToPromise(q, 0)).toBe(q);
      }),
    );
  });

  it("never goes negative even when reservations exceed stock", () => {
    fc.assert(
      fc.property(qtyArb, qtyArb, (onHand, reserved) => {
        expect(availableToPromise(onHand, reserved)).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

describe("previewProductionCost", () => {
  it("totals equal the sum of displayed lines", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(qtyArb, qtyArb), { maxLength: 20 }), (pairs) => {
        const reqs = pairs.map(([seed], i) => ({
          itemId: `item-${i}`,
          quantityThousandths: seed + 1,
        }));
        const costs = new Map(pairs.map(([, c], i) => [`item-${i}`, c]));
        const preview = previewProductionCost(reqs, costs);
        expect(preview.totalCostMinor).toBe(preview.lines.reduce((s, l) => s + l.costMinor, 0));
      }),
    );
  });

  it("missing cost entries are treated as free, not NaN", () => {
    const preview = previewProductionCost([{ itemId: "x", quantityThousandths: 4000 }], new Map());
    expect(preview.totalCostMinor).toBe(0);
  });
});

describe("cycleCountVariances", () => {
  it("skips uncounted lines and reports counted − expected", () => {
    const out = cycleCountVariances([
      { expectedThousandths: 5000, countedThousandths: 4800 },
      { expectedThousandths: 3000, countedThousandths: null },
    ]);
    expect(out).toEqual([{ varianceThousandths: -200 }]);
  });
});

describe("traceLotUpstream", () => {
  it("collects every upstream lot reachable from the root", () => {
    const edges = [
      { consumerLotId: "bike-1", sourceLotId: "wheel-7", quantityThousandths: 2000 },
      { consumerLotId: "bike-1", sourceLotId: "frame-3", quantityThousandths: 1000 },
      { consumerLotId: "wheel-7", sourceLotId: "rim-9", quantityThousandths: 2000 },
    ];
    const tree = traceLotUpstream(edges, "bike-1");
    expect(tree.children.map((c) => c.lotId).sort()).toEqual(["frame-3", "wheel-7"]);
    const wheel = tree.children.find((c) => c.lotId === "wheel-7")!;
    expect(wheel.children.map((c) => c.lotId)).toEqual(["rim-9"]);
  });

  it("terminates on cyclic graphs instead of recursing forever", () => {
    const edges = [
      { consumerLotId: "a", sourceLotId: "b", quantityThousandths: 1 },
      { consumerLotId: "b", sourceLotId: "a", quantityThousandths: 1 },
    ];
    expect(() => traceLotUpstream(edges, "a")).not.toThrow();
  });
});

