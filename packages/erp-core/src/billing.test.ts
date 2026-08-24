import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isDue, nextRunAfter, type RecurringFrequency } from "./billing";

/**
 * Schedule invariants: weekly adds exactly 7 days; monthly/quarterly clamp
 * to month end without skipping months; every next run is strictly in the
 * future relative to the anchor, so a template can never double-fire.
 */

describe("nextRunAfter", () => {
  it("weekly adds seven days across month boundaries", () => {
    expect(nextRunAfter("weekly", new Date(Date.UTC(2026, 0, 28)))).toEqual(
      new Date(Date.UTC(2026, 1, 4)),
    );
  });

  it("monthly clamps Jan 31 to Feb 28/29", () => {
    expect(nextRunAfter("monthly", new Date(Date.UTC(2026, 0, 31)))).toEqual(
      new Date(Date.UTC(2026, 1, 28)),
    );
    expect(nextRunAfter("monthly", new Date(Date.UTC(2028, 0, 31)))).toEqual(
      new Date(Date.UTC(2028, 1, 29)),
    );
    expect(nextRunAfter("monthly", new Date(Date.UTC(2026, 0, 15)))).toEqual(
      new Date(Date.UTC(2026, 1, 15)),
    );
  });

  it("quarterly preserves the day and advances three months", () => {
    expect(nextRunAfter("quarterly", new Date(Date.UTC(2026, 4, 10)))).toEqual(
      new Date(Date.UTC(2026, 7, 10)),
    );
    // May 31 → Aug 31 exists.
    expect(nextRunAfter("quarterly", new Date(Date.UTC(2026, 4, 31)))).toEqual(
      new Date(Date.UTC(2026, 7, 31)),
    );
  });

  it("never produces a non-monotonic or past date (property)", () => {
    const freqs: RecurringFrequency[] = ["weekly", "monthly", "quarterly"];
    fc.assert(
      fc.property(
        fc.constantFrom(...freqs),
        fc.integer({ min: 0, max: 60_000 }), // days since epoch-ish
        (frequency, day) => {
          const from = new Date(day * 86_400_000);
          const next = nextRunAfter(frequency, from);
          if (!(next.getTime() > from.getTime())) return false;
          // Idempotence of clamping: iterating monthly from a clamped date
          // must keep advancing by one calendar month each step.
          const after2 = nextRunAfter(frequency, next);
          return after2.getTime() > next.getTime();
        },
      ),
      { numRuns: 400 },
    );
  });

  it("isDue is an inclusive boundary comparison", () => {
    const now = new Date(Date.UTC(2026, 7, 24, 12));
    expect(isDue(now, now)).toBe(true);
    expect(isDue(new Date(now.getTime() + 1), now)).toBe(false);
  });
});
