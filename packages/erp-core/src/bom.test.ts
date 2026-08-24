import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  BomCycleError,
  checkAvailability,
  explodeBom,
  type BomEdge,
} from "./bom";

describe("explodeBom", () => {
  it("flat BOM passes through with scaling", () => {
    const edges: BomEdge[] = [
      { assemblyItemId: "lamp", componentItemId: "wire", quantityThousandths: 2000 },
      { assemblyItemId: "lamp", componentItemId: "bulb", quantityThousandths: 1000 },
    ];
    expect(explodeBom(edges, "lamp", 5000)).toEqual([
      { itemId: "bulb", quantityThousandths: 5000 },
      { itemId: "wire", quantityThousandths: 10_000 },
    ]);
  });

  it("nested sub-assemblies expand recursively and aggregate shared parts", () => {
    const edges: BomEdge[] = [
      { assemblyItemId: "chandelier", componentItemId: "arm", quantityThousandths: 3000 },
      { assemblyItemId: "chandelier", componentItemId: "canopy", quantityThousandths: 1000 },
      { assemblyItemId: "arm", componentItemId: "socket", quantityThousandths: 1000 },
      { assemblyItemId: "arm", componentItemId: "wire", quantityThousandths: 1500 },
    ];
    // 2 chandeliers → 6 arms → 6 sockets + 9 wire, plus 2 canopies
    expect(explodeBom(edges, "chandelier", 2000)).toEqual([
      { itemId: "canopy", quantityThousandths: 2000 },
      { itemId: "socket", quantityThousandths: 6000 },
      { itemId: "wire", quantityThousandths: 9000 },
    ]);
  });

  it("throws on a direct cycle (assembly contains itself)", () => {
    const edges: BomEdge[] = [
      { assemblyItemId: "a", componentItemId: "b", quantityThousandths: 1000 },
      { assemblyItemId: "b", componentItemId: "a", quantityThousandths: 1000 },
    ];
    expect(() => explodeBom(edges, "a", 1000)).toThrow(BomCycleError);
  });

  it("detects a cycle even when the repeated node is reached via two parents", () => {
    const edges: BomEdge[] = [
      { assemblyItemId: "top", componentItemId: "left", quantityThousandths: 1000 },
      { assemblyItemId: "top", componentItemId: "right", quantityThousandths: 1000 },
      { assemblyItemId: "left", componentItemId: "loop", quantityThousandths: 1000 },
      { assemblyItemId: "right", componentItemId: "loop", quantityThousandths: 1000 },
      { assemblyItemId: "loop", componentItemId: "top", quantityThousandths: 1000 },
    ];
    expect(() => explodeBom(edges, "top", 1000)).toThrow(BomCycleError);
  });

  it("leaf item without a BOM is its own single requirement", () => {
    expect(explodeBom([], "widget", 7000)).toEqual([{ itemId: "widget", quantityThousandths: 7000 }]);
  });

  it("never returns negative or zero requirements for positive inputs", () => {
    const arbEdges = fc.array(
      fc.record({
        assemblyItemId: fc.constantFrom("a", "b", "c"),
        componentItemId: fc.constantFrom("a", "b", "c", "d"),
        quantityThousandths: fc.integer({ min: 1, max: 10_000 }),
      }) as fc.Arbitrary<BomEdge>,
      { maxLength: 12 },
    );
    const prop = fc.property(arbEdges, fc.integer({ min: 1, max: 10_000 }), (edges, qty) => {
      try {
        const reqs = explodeBom(edges, "a", qty);
        return reqs.every((r) => r.quantityThousandths > 0);
      } catch (e) {
        return e instanceof BomCycleError;
      }
    });
    expect(fc.assert(prop)).toBeUndefined();
  });
});

describe("checkAvailability", () => {
  it("producible only when every requirement is covered", () => {
    const reqs = [
      { itemId: "w", quantityThousandths: 4000 },
      { itemId: "x", quantityThousandths: 1000 },
    ];
    expect(checkAvailability(reqs, new Map([["w", 4000], ["x", 999]]))).toMatchObject({
      producible: false,
      totalShortfallThousandths: 1,
    });
    expect(
      checkAvailability(reqs, new Map([["w", 10_000], ["x", 1000]])),
    ).toMatchObject({ producible: true, totalShortfallThousandths: 0 });
  });

  it("missing from the on-hand map counts as zero stock", () => {
    const r = checkAvailability([{ itemId: "z", quantityThousandths: 5 }], new Map());
    expect(r.lines[0]?.onHandThousandths).toBe(0);
    expect(r.producible).toBe(false);
  });
});
