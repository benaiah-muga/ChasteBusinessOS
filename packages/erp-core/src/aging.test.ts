import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeAging, isPeriodOpen } from "./aging";

const SEED = 20260822;
const opts = { seed: SEED, numRuns: 300 };

describe("AR aging", () => {
  const now = new Date("2026-08-22T00:00:00Z");
  const DAY = 86_400_000;
  const mk = (days: number) => new Date(now.getTime() - days * DAY);

  it("buckets partition the total outstanding exactly", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            invoiceNumber: fc.nat(10_000),
            outstandingMinor: fc.integer({ min: 0, max: 1_000_000 }),
            ageDays: fc.integer({ min: 0, max: 400 }),
          }),
          { minLength: 0, maxLength: 30 },
        ),
        (rows) => {
          const receivables = rows.map((r) => ({
            invoiceNumber: r.invoiceNumber,
            outstandingMinor: r.outstandingMinor,
            issuedAt: new Date(now.getTime() - r.ageDays * 86_400_000),
          }));
          const b = computeAging(receivables, now);
          expect(b.current + b.d30 + b.d60 + b.d90plus).toBe(b.totalOutstanding);
        },
      ),
      opts,
    );
  });

  it("classifies boundaries correctly", () => {
    const b = computeAging(
      [
        { invoiceNumber: 1, outstandingMinor: 100, issuedAt: mk(0) },
        { invoiceNumber: 2, outstandingMinor: 200, issuedAt: mk(30) },
        { invoiceNumber: 3, outstandingMinor: 400, issuedAt: mk(31) },
        { invoiceNumber: 4, outstandingMinor: 800, issuedAt: mk(91) },
      ],
      now,
    );
    expect(b).toEqual({ current: 300, d30: 400, d60: 0, d90plus: 800, totalOutstanding: 1500 });
  });

  it("ignores fully paid invoices", () => {
    expect(computeAging([{ invoiceNumber: 1, outstandingMinor: 0, issuedAt: now }], now).totalOutstanding).toBe(0);
  });

  it("ages collections from the due date, not the issue date (N11)", () => {
    const b = computeAging(
      [
        // issued 100 days ago, due in 20 days: not yet due -> current
        { invoiceNumber: 1, outstandingMinor: 100, issuedAt: mk(100), dueAt: new Date(now.getTime() + 20 * DAY) },
        // due 45 days ago -> 31-60 band regardless of old issue date
        { invoiceNumber: 2, outstandingMinor: 200, issuedAt: mk(120), dueAt: mk(45) },
        // no due date: falls back to issue age
        { invoiceNumber: 3, outstandingMinor: 400, issuedAt: mk(75) },
        // explicit null behaves like absent
        { invoiceNumber: 4, outstandingMinor: 800, issuedAt: mk(95), dueAt: null },
      ],
      now,
    );
    expect(b).toEqual({ current: 100, d30: 200, d60: 400, d90plus: 800, totalOutstanding: 1500 });
  });

  it("keeps not-yet-due invoices in current even far past issue", () => {
    const b = computeAging(
      [{ invoiceNumber: 1, outstandingMinor: 100, issuedAt: mk(365), dueAt: new Date(now.getTime() + DAY) }],
      now,
    );
    expect(b).toEqual({ current: 100, d30: 0, d60: 0, d90plus: 0, totalOutstanding: 100 });
  });
});

describe("period guards", () => {
  it("closed periods block posting dates", () => {
    const closed = [{ year: 2026, month: 7 }];
    expect(isPeriodOpen(closed, new Date("2026-07-15"))).toBe(false);
    expect(isPeriodOpen(closed, new Date("2026-08-01"))).toBe(true);
  });
});
