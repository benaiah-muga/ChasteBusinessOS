/**
 * Payroll math. Pure, deterministic, integer minor units throughout.
 * The run's invariant: net + tax = gross, always, for any input — verified
 * by property tests before it ever reaches the ledger.
 */

export interface PayslipLine {
  employeeRef: string;
  monthlySalaryMinor: number;
  /** Thousandths of the month actually worked (1000 = full month). */
  workedFractionThousandths: number;
  /** Tax rate in basis points of gross. */
  taxRateBps: number;
}

export interface Payslip {
  employeeRef: string;
  grossMinor: number;
  taxMinor: number;
  netMinor: number;
}

function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/** Calendar days in a month; nothing else about time is trusted here. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Fraction of the month worked as thousandths, reduced by unpaid leave days
 * and clamped to [0, 1000]. Approved *paid* leave does not reduce pay.
 */
export function workedFractionThousandths(year: number, month: number, unpaidLeaveDays: number): number {
  const total = daysInMonth(year, month);
  if (total <= 0) return 0;
  const clampedDays = Math.min(Math.max(unpaidLeaveDays, 0), total);
  return Math.round(((total - clampedDays) / total) * 1000);
}

/** Gross → tax → net. Net can never be negative and never exceeds gross. */
export function computePayslip(line: PayslipLine): Payslip {
  const grossMinor = roundHalfUp((line.monthlySalaryMinor * line.workedFractionThousandths) / 1000);
  const taxMinor = roundHalfUp((grossMinor * line.taxRateBps) / 10_000);
  return { employeeRef: line.employeeRef, grossMinor, taxMinor, netMinor: grossMinor - taxMinor };
}

export function computePayslips(lines: PayslipLine[]): Payslip[] {
  return lines.map(computePayslip);
}

export interface RunSummary {
  totalGrossMinor: number;
  totalTaxMinor: number;
  totalNetMinor: number;
  headcount: number;
}

/** Run totals are the exact sum of payslips — no independent recomputation. */
export function summarizeRun(payslips: Payslip[]): RunSummary {
  let g = 0;
  let t = 0;
  let n = 0;
  for (const p of payslips) {
    if (p.netMinor !== p.grossMinor - p.taxMinor || p.grossMinor < 0 || p.taxMinor < 0 || p.netMinor < 0) {
      throw new Error(`corrupt payslip for ${p.employeeRef}`);
    }
    g += p.grossMinor;
    t += p.taxMinor;
    n += p.netMinor;
  }
  return { totalGrossMinor: g, totalTaxMinor: t, totalNetMinor: n, headcount: payslips.length };
}

/** Monthly accrual of an annual leave entitlement, in whole days so far. */
export function leaveAccruedDays(annualEntitlementDays: number, monthsElapsed: number): number {
  if (annualEntitlementDays <= 0 || monthsElapsed <= 0) return 0;
  const accrued = Math.floor((annualEntitlementDays * Math.min(monthsElapsed, 12)) / 12);
  return accrued;
}

/**
 * Calendar days of approved *unpaid* leave falling inside a given month,
 * clamped to the month's length. This is what reduces a payslip.
 */
export function unpaidLeaveDaysInMonth(
  leaves: { startDate: Date; endDate: Date }[],
  year: number,
  month: number,
): number {
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd = Date.UTC(year, month, 1);
  const total = daysInMonth(year, month);
  const dayMs = 86_400_000;
  let sum = 0;
  for (const l of leaves) {
    const start = Math.max(l.startDate.getTime(), monthStart);
    // endDate is inclusive; compare against the first ms outside the range.
    const endExclusive = Math.min(l.endDate.getTime() + dayMs, monthEnd);
    if (endExclusive > start) sum += Math.round((endExclusive - start) / dayMs);
  }
  return Math.min(sum, total);
}

/** Posting rule for payroll: DR expense (gross), CR cash (net), CR withholding liability (tax). */
export interface PayrollAccounts {
  expenseCode: string;
  cashCode: string;
  withholdingCode: string;
}

import { type JournalLineInput } from "./posting";

export function buildPayrollEntryLines(accounts: PayrollAccounts, s: RunSummary): JournalLineInput[] {
  return [
    { accountCode: accounts.expenseCode, debitMinor: s.totalGrossMinor, creditMinor: 0 },
    { accountCode: accounts.cashCode, debitMinor: 0, creditMinor: s.totalNetMinor },
    { accountCode: accounts.withholdingCode, debitMinor: 0, creditMinor: s.totalTaxMinor },
  ];
}
