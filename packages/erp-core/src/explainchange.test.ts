import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { explainChange, type MetricRow } from "./explainchange.js";

/** The decomposition's whole contract: contributions sum to the delta. */

const arbRows = fc
  .array(
    fc.record({ key: fc.string({ minLength: 1, maxLength: 6 }), valueMinor: fc.integer({ min: 0, max: 1_000_000 }) }),
    { maxLength: 20 },
  )
  .map((rows) => rows.map((r, i) => ({ key: `${r.key}-${i % 7}`, valueMinor: r.valueMinor }) as MetricRow));

describe("explainChange (M12.1)", () => {
  it("property: contributions sum to the delta exactly, for every input", () => {
    fc.assert(
      fc.property(arbRows, arbRows, (a, b) => {
        const d = explainChange(a, b);
        const sum = d.contributions.reduce((s, c) => s + c.deltaMinor, 0);
        expect(sum).toBe(d.deltaMinor);
        expect(d.priorTotalMinor).toBe(a.reduce((s, r) => s + r.valueMinor, 0));
        expect(d.currentTotalMinor).toBe(b.reduce((s, r) => s + r.valueMinor, 0));
      }),
    );
  });

  it("property: order-independent — shuffled inputs decompose identically", () => {
    fc.assert(
      fc.property(arbRows, arbRows, fc.nat(4), (a, b, _seed) => {
        const one = explainChange(a, b);
        const two = explainChange([...a].reverse(), [...b].reverse());
        expect(one).toEqual(two);
      }),
    );
  });

  it("property: share is the exact delta-over-total ratio (can exceed ±1 with offsetting movers)", () => {
    fc.assert(
      fc.property(arbRows, arbRows, (a, b) => {
        const d = explainChange(a, b);
        for (const c of d.contributions) {
          if (d.deltaMinor === 0) expect(c.shareOfDelta).toBeNull();
          else expect(c.shareOfDelta!).toBe(c.deltaMinor / d.deltaMinor);
        }
      }),
    );
  });

  it("the marquee: revenue drop decomposes to the products that caused it", () => {
    const prior: MetricRow[] = [
      { key: "widget", valueMinor: 500_00 },
      { key: "gadget", valueMinor: 300_00 },
      { key: "spacer", valueMinor: 200_00 },
    ];
    const current: MetricRow[] = [
      { key: "widget", valueMinor: 250_00 },
      { key: "gadget", valueMinor: 300_00 },
      { key: "spacer", valueMinor: 190_00 },
    ];
    const d = explainChange(prior, current);
    expect(d.deltaMinor).toBe(-260_00); // 1000 → 740: down 26%
    expect(d.contributions[0]).toMatchObject({ key: "widget", deltaMinor: -250_00 });
    const sum = d.contributions.reduce((s, c) => s + c.deltaMinor, 0);
    expect(sum).toBe(d.deltaMinor);
  });
});
