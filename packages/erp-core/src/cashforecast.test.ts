import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildThirteenWeekForecast, weekStartOf, type ForecastFlow } from "./cashforecast.js";

/** Bucket conservation and chained closes are the forecast's whole trust story. */

const asOf = new Date(Date.UTC(2026, 7, 31)); // a Monday

const arbFlows = fc
  .array(
    fc.record({
      offsetDays: fc.integer({ min: -20, max: 120 }),
      amountMinor: fc.integer({ min: 1, max: 5_000_000 }),
      kind: fc.constantFrom("inflow" as const, "outflow" as const),
      refId: fc.string({ maxLength: 8 }),
    }),
    { maxLength: 60 },
  )
  .map((rows) =>
    rows.map((r) => ({ dueAt: new Date(asOf.getTime() + r.offsetDays * 86_400_000), amountMinor: r.amountMinor, kind: r.kind, refId: r.refId }) satisfies ForecastFlow),
  );

describe("thirteen-week forecast (M10.3)", () => {
  it("every flow lands in exactly one bucket and the final close equals start plus all flows", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), arbFlows, (start, flows) => {
        const f = buildThirteenWeekForecast(start, flows, asOf);
        const inflow = flows.filter((x) => x.kind === "inflow").reduce((s, x) => s + x.amountMinor, 0);
        const outflow = flows.filter((x) => x.kind === "outflow").reduce((s, x) => s + x.amountMinor, 0);
        expect(f.finalMinor).toBe(start + inflow - outflow);
        const bucketedIn = f.weeks.reduce((s, w) => s + w.inflowMinor, 0);
        const bucketedOut = f.weeks.reduce((s, w) => s + w.outflowMinor, 0);
        expect(bucketedIn).toBe(inflow);
        expect(bucketedOut).toBe(outflow);
      }),
    );
  });

  it("weekly closes chain: this close is the previous close plus this week's net", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), arbFlows, (start, flows) => {
        const f = buildThirteenWeekForecast(start, flows, asOf);
        let prev = f.startMinor;
        for (const w of f.weeks) {
          expect(w.closeMinor).toBe(prev + w.inflowMinor - w.outflowMinor);
          prev = w.closeMinor;
        }
        expect(f.finalMinor).toBe(prev);
      }),
    );
  });

  it("13 weeks of Mondays, deterministic under shuffling", () => {
    const f = buildThirteenWeekForecast(100, [], asOf);
    expect(f.weeks).toHaveLength(13);
    expect(f.weeks[0]!.weekStart.toISOString()).toBe(weekStartOf(asOf).toISOString());
    for (let i = 1; i < 13; i++) {
      expect(f.weeks[i]!.weekStart.getTime() - f.weeks[i - 1]!.weekStart.getTime()).toBe(7 * 86_400_000);
    }
    const flows: ForecastFlow[] = [
      { dueAt: new Date(asOf.getTime() + 3 * 86_400_000), amountMinor: 500, kind: "inflow" },
      { dueAt: new Date(asOf.getTime() + 40 * 86_400_000), amountMinor: 200, kind: "outflow" },
    ];
    const a = buildThirteenWeekForecast(100, flows, asOf);
    const b = buildThirteenWeekForecast(100, [...flows].reverse(), asOf);
    expect(a).toEqual(b);
  });

  it("lowest close never exceeds the final close and is one of the weekly closes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), arbFlows, (start, flows) => {
        const f = buildThirteenWeekForecast(start, flows, asOf);
        const closes = f.weeks.map((w) => w.closeMinor);
        expect(f.lowestCloseMinor).toBe(Math.min(start, ...closes));
        expect(f.lowestCloseMinor).toBeLessThanOrEqual(f.finalMinor);
      }),
    );
  });
});
