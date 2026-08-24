import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertBalanced } from "./posting";
import {
  buildPayrollEntryLines,
  computePayslip,
  computePayslips,
  daysInMonth,
  leaveAccruedDays,
  summarizeRun,
  unpaidLeaveDaysInMonth,
  workedFractionThousandths,
} from "./payroll";

const SEED = 20260822;
const opts = { seed: SEED, numRuns: 500 };

const arbLine = () =>
  fc.record({
    employeeRef: fc.string({ minLength: 1, maxLength: 20 }),
    monthlySalaryMinor: fc.integer({ min: 0, max: 100_000_000 }),
    workedFractionThousandths: fc.integer({ min: 0, max: 1000 }),
    taxRateBps: fc.integer({ min: 0, max: 5000 }),
  });

describe("payroll invariants (property-based)", () => {
  it("net + tax == gross for every payslip, for any input", () => {
    fc.assert(
      fc.property(fc.array(arbLine(), { minLength: 1, maxLength: 50 }), (lines) => {
        for (const p of computePayslips(lines)) {
          expect(p.netMinor).toBe(p.grossMinor - p.taxMinor);
        }
      }),
      opts,
    );
  });

  it("gross never exceeds the monthly salary and is never negative", () => {
    fc.assert(
      fc.property(arbLine(), (line) => {
        const p = computePayslip(line);
        expect(p.grossMinor).toBeGreaterThanOrEqual(0);
        expect(p.grossMinor).toBeLessThanOrEqual(line.monthlySalaryMinor);
      }),
      opts,
    );
  });

  it("a full month with zero tax yields exactly the monthly salary", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_000 }),
        (salary) => {
          const p = computePayslip({ employeeRef: "x", monthlySalaryMinor: salary, workedFractionThousandths: 1000, taxRateBps: 0 });
          expect(p.grossMinor).toBe(salary);
          expect(p.netMinor).toBe(salary);
        },
      ),
      opts,
    );
  });

  it("run summary is exactly the sum of its payslips and detects corruption", () => {
    fc.assert(
      fc.property(fc.array(arbLine(), { minLength: 1, maxLength: 50 }), (lines) => {
        const slips = computePayslips(lines);
        const s = summarizeRun(slips);
        expect(s.totalGrossMinor).toBe(slips.reduce((a, p) => a + p.grossMinor, 0));
        expect(s.totalNetMinor).toBe(slips.reduce((a, p) => a + p.netMinor, 0));
        expect(s.headcount).toBe(slips.length);
      }),
      opts,
    );
    const tampered = [{ employeeRef: "x", grossMinor: 100, taxMinor: 30, netMinor: 71 }];
    expect(() => summarizeRun(tampered)).toThrow(/corrupt payslip/);
  });

  it("worked fraction decreases monotonically with unpaid leave days", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 27 }),
        (year, month, day) => {
          const before = workedFractionThousandths(year, month, day);
          const after = workedFractionThousandths(year, month, day + 1);
          expect(after).toBeLessThan(before);
        },
      ),
      opts,
    );
    expect(workedFractionThousandths(2026, 2, 99)).toBe(0); // clamped
    expect(workedFractionThousandths(2026, 2, -5)).toBe(1000); // clamped
  });

  it("leave accrual caps at the entitlement and floors partial months", () => {
    expect(leaveAccruedDays(21, 12)).toBe(21);
    expect(leaveAccruedDays(21, 24)).toBe(21);
    expect(leaveAccruedDays(21, 6)).toBe(10); // floor(21*6/12)
    expect(leaveAccruedDays(0, 5)).toBe(0);
  });
});

describe("calendar", () => {
  it("knows its months", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 8)).toBe(31);
  });
});

describe("payroll posting", () => {
  it("the payroll entry balances for any non-degenerate run", () => {
    fc.assert(
      fc.property(fc.array(arbLine(), { minLength: 1, maxLength: 50 }), (lines) => {
        const s = summarizeRun(computePayslips(lines));
        const entryLines = buildPayrollEntryLines(
          { expenseCode: "6000", cashCode: "1000", withholdingCode: "2200" },
          s,
        );
        if (s.totalGrossMinor === 0) {
          // Degenerate (all-zero) runs are rejected upstream, never posted.
          expect(() => assertBalanced({ memo: "payroll", lines: entryLines })).toThrow();
          return;
        }
        expect(() => assertBalanced({ memo: "payroll", lines: entryLines })).not.toThrow();
      }),
      opts,
    );
  });
});

describe("unpaid leave overlap", () => {
  it("counts only days inside the month and never exceeds its length", () => {
    const leave = [{ startDate: new Date(Date.UTC(2026, 6, 28)), endDate: new Date(Date.UTC(2026, 7, 4)) }];
    expect(unpaidLeaveDaysInMonth(leave, 2026, 7)).toBe(4); // Jul 28-31
    expect(unpaidLeaveDaysInMonth(leave, 2026, 8)).toBe(4); // Aug 1-4
    expect(unpaidLeaveDaysInMonth([], 2026, 8)).toBe(0);
    const wholeMonth = [{ startDate: new Date(Date.UTC(2026, 7, 1)), endDate: new Date(Date.UTC(2026, 8, 30)) }];
    expect(unpaidLeaveDaysInMonth(wholeMonth, 2026, 8)).toBe(31);
  });
});
