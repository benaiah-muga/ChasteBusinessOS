import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { reconcileInventoryValue, valuationAdjustmentLines } from "./gl";
import { assertBalanced } from "./posting";
import { replayValuation, type CostedMovement } from "./inventory";

const CODES = { inventoryCode: "1200", cogsCode: "5000" };

describe("reconcileInventoryValue", () => {
  it("variance is ledger minus GL, whatever the direction", () => {
    expect(reconcileInventoryValue(4_400, 4_000).varianceMinor).toBe(400);
    expect(reconcileInventoryValue(4_000, 4_400).varianceMinor).toBe(-400);
    expect(reconcileInventoryValue(4_400, 4_400).varianceMinor).toBe(0);
  });
});

describe("valuationAdjustmentLines", () => {
  it("under-stated books: DR inventory, relieve COGS", () => {
    const lines = valuationAdjustmentLines(400, CODES);
    assertBalanced({ memo: "t", lines });
    expect(lines[0]).toMatchObject({ accountCode: "1200", debitMinor: 400, creditMinor: 0 });
    expect(lines[1]).toMatchObject({ accountCode: "5000", debitMinor: 0, creditMinor: 400 });
  });

  it("over-stated books: expense the shrinkage, CR inventory", () => {
    const lines = valuationAdjustmentLines(-400, CODES);
    assertBalanced({ memo: "t", lines });
    expect(lines[0]).toMatchObject({ accountCode: "5000", debitMinor: 400, creditMinor: 0 });
    expect(lines[1]).toMatchObject({ accountCode: "1200", debitMinor: 0, creditMinor: 400 });
  });

  it("reconciled books post nothing — an empty entry must not exist", () => {
    expect(valuationAdjustmentLines(0, CODES)).toEqual([]);
  });

  it("(property) lines always balance and land the GL exactly on the ledger value", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000_000 }),
        fc.integer({ min: 0, max: 1_000_000_000 }),
        (ledgerValueMinor, glBalanceMinor) => {
          const { varianceMinor } = reconcileInventoryValue(ledgerValueMinor, glBalanceMinor);
          const lines = valuationAdjustmentLines(varianceMinor, CODES);
          if (varianceMinor === 0) {
            expect(lines).toHaveLength(0);
            return;
          }
          assertBalanced({ memo: "property", lines });
          const inventoryDelta = lines.reduce(
            (sum, l) => sum + (l.accountCode === CODES.inventoryCode ? l.debitMinor - l.creditMinor : 0),
            0,
          );
          expect(glBalanceMinor + inventoryDelta).toBe(ledgerValueMinor);
        },
      ),
      { seed: 20260830, numRuns: 300 },
    );
  });

  it("(property) reconciliation survives randomized costed activity: replayed value equals the GL after adjustment", () => {
    // Valid history generator: fold deltas, skipping outs that would go
    // negative (the ledger itself refuses those). Costs are derived from the
    // generated integers so every run is reproducible from its seed.
    const historyArb = fc
      .tuple(
        fc.array(fc.integer({ min: -5_000, max: 5_000 }), { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 500, max: 5_500 }),
      )
      .map(([deltas, baseCost]) => {
        const movements: CostedMovement[] = [];
        let onHand = 0;
        for (const d of deltas) {
          if (d < 0 && onHand + d < 0) continue;
          const unitCostMinor = d > 0 ? baseCost + (Math.abs(onHand + d) % 977) * 3 : undefined;
          movements.push({ quantityDelta: d, unitCostMinor });
          onHand += d;
        }
        return movements.filter((m) => m.quantityDelta !== 0);
      })
      .filter((m) => m.length > 0);

    fc.assert(
      fc.property(historyArb, fc.integer({ min: -50_000, max: 50_000 }), (movements, drift) => {
        const ledger = replayValuation(movements);
        // gl = true value plus arbitrary human drift (possibly negative drift
        // on a zero-value ledger clamps the property to valid domains)
        const gl = Math.max(0, ledger.totalValueMinor + drift);
        const { varianceMinor } = reconcileInventoryValue(ledger.totalValueMinor, gl);
        const lines = valuationAdjustmentLines(varianceMinor, CODES);
        const inventoryDelta = lines.reduce(
          (sum, l) => sum + (l.accountCode === CODES.inventoryCode ? l.debitMinor - l.creditMinor : 0),
          0,
        );
        expect(gl + inventoryDelta).toBe(ledger.totalValueMinor);
      }),
      { seed: 20260831, numRuns: 200 },
    );
  });
});
