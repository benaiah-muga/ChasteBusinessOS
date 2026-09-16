import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  lineUnexplained,
  paymentRemaining,
  planLineAllocations,
  reconciliationTotals,
  type BankStatementLine,
  type ProposedAllocation,
} from "./bankrec";

const SEED = 20260916;
const opts = { seed: SEED, numRuns: 300 };

describe("line allocations", () => {
  it("allocations never explain more than the line (N14)", () => {
    fc.assert(
      fc.property(
        fc.record({
          amount: fc.integer({ min: -1_000_000, max: 1_000_000 }).filter((n) => n !== 0),
          slices: fc.array(fc.integer({ min: 1, max: 200_000 }), { minLength: 1, maxLength: 6 }),
        }),
        ({ amount, slices }) => {
          const line: BankStatementLine = { id: "l1", amountMinor: amount, status: "unmatched" };
          // Same-direction slices, sized to sometimes fit and sometimes not.
          let allocated = 0;
          for (const raw of slices) {
            const magnitude = Math.min(raw, Math.abs(amount) - Math.abs(allocated));
            const proposed: ProposedAllocation[] = [
              { kind: "fee", amountMinor: amount > 0 ? magnitude : -magnitude },
            ];
            if (magnitude === 0) {
              expect(() => planLineAllocations(line, allocated, proposed)).toThrow(/exceeds the statement line|must be nonzero/);
              break;
            }
            const planned = planLineAllocations(line, allocated, proposed);
            allocated += planned[0]!.amountMinor;
            expect(Math.abs(allocated)).toBeLessThanOrEqual(Math.abs(amount));
          }
          expect(Math.abs(lineUnexplained(line, allocated))).toBeLessThanOrEqual(Math.abs(amount));
        },
      ),
      opts,
    );
  });

  it("refuses opposite-direction allocations", () => {
    const line: BankStatementLine = { id: "l1", amountMinor: 5_000, status: "unmatched" };
    expect(() => planLineAllocations(line, 0, [{ kind: "fee", amountMinor: -500 }])).toThrow(/direction mismatch/);
  });

  it("refuses excluded lines", () => {
    const line: BankStatementLine = { id: "l1", amountMinor: 5_000, status: "excluded" };
    expect(() => planLineAllocations(line, 0, [{ kind: "payment", amountMinor: 5_000 }])).toThrow(/excluded/);
  });

  it("allows a partial line to take further allocations until fully explained", () => {
    const line: BankStatementLine = { id: "l1", amountMinor: 10_000, status: "matched" };
    const first = planLineAllocations(line, 0, [{ kind: "payment", amountMinor: 6_000 }]);
    const second = planLineAllocations(line, first[0]!.amountMinor, [{ kind: "payment", amountMinor: 4_000 }]);
    expect(lineUnexplained(line, first[0]!.amountMinor + second[0]!.amountMinor)).toBe(0);
    expect(() =>
      planLineAllocations(line, 10_000, [{ kind: "payment", amountMinor: 1 }]),
    ).toThrow(/exceeds the statement line/);
  });
});

describe("payment remaining", () => {
  it("splits conserve the payment: slices may consume it exactly, never beyond", () => {
    fc.assert(
      fc.property(
        fc.record({
          amount: fc.integer({ min: 1, max: 1_000_000 }),
          slices: fc.array(fc.integer({ min: 1, max: 500_000 }), { minLength: 1, maxLength: 6 }),
        }),
        ({ amount, slices }) => {
          let allocated = 0;
          for (const raw of slices) {
            if (amount - allocated - raw < 0) {
              expect(() => paymentRemaining(amount, allocated, raw)).toThrow(/over-allocated/);
              break;
            }
            const remaining = paymentRemaining(amount, allocated, raw);
            allocated += raw;
            expect(allocated).toBeLessThanOrEqual(amount);
            expect(remaining).toBe(amount - allocated);
          }
        },
      ),
      opts,
    );
  });
});

describe("reconciliation totals", () => {
  it("reconciled means zero unexplained difference (N14)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.string({ minLength: 4, maxLength: 8 }),
            amount: fc.integer({ min: -500_000, max: 500_000 }).filter((n) => n !== 0),
            fraction: fc.integer({ min: 0, max: 100 }),
          }),
          { minLength: 0, maxLength: 12 },
        ),
        (rows) => {
          const lines: BankStatementLine[] = rows.map((r, i) => ({
            id: `${r.id}${i}`,
            amountMinor: r.amount,
            status: "matched",
          }));
          const allocatedByLine = new Map<string, number>();
          for (const [i, r] of rows.entries()) {
            const line = lines[i]!;
            const allocated = Math.trunc((line.amountMinor * r.fraction) / 100);
            allocatedByLine.set(line.id, allocated);
          }
          const { totals, lines: detailed } = reconciliationTotals(lines, allocatedByLine);
          // Totals are the exact sums of the per-line detail.
          expect(totals.linesMinor).toBe(detailed.reduce((s, l) => s + l.amountMinor, 0));
          expect(totals.allocatedMinor).toBe(detailed.reduce((s, l) => s + l.allocatedMinor, 0));
          expect(totals.unexplainedMinor).toBe(totals.linesMinor - totals.allocatedMinor);
          expect(totals.reconciled).toBe(totals.unexplainedMinor === 0);
        },
      ),
      opts,
    );
  });

  it("excluded lines carry no allocations and stay out of the difference", () => {
    const lines: BankStatementLine[] = [
      { id: "a", amountMinor: 10_000, status: "matched" },
      { id: "b", amountMinor: -777, status: "excluded" },
    ];
    const { totals, lines: detailed } = reconciliationTotals(lines, new Map([["a", 10_000]]));
    expect(detailed.find((l) => l.id === "b")).toMatchObject({ allocatedMinor: 0, unexplainedMinor: 0 });
    expect(totals).toMatchObject({ linesMinor: 10_000, allocatedMinor: 10_000, unexplainedMinor: 0, reconciled: true });
  });

  it("detects over-allocation", () => {
    const lines: BankStatementLine[] = [{ id: "a", amountMinor: 100, status: "matched" }];
    expect(() => reconciliationTotals(lines, new Map([["a", 200]]))).toThrow(/over-allocated/);
  });
});
