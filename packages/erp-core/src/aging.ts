export interface OpenReceivable {
  invoiceNumber: number;
  outstandingMinor: number;
  issuedAt: Date;
  /** Collections age runs from the due date when the invoice carries one (N11). */
  dueAt?: Date | null;
}

export interface AgingBuckets {
  current: number;
  d30: number;
  d60: number;
  d90plus: number;
  totalOutstanding: number;
}

const DAY = 86_400_000;

/**
 * AR aging: outstanding value bucketed by days past due at the explicit
 * as-of instant `now`. The clock is the due date when present, otherwise
 * the issue date; not-yet-due invoices sit in `current`. Pure.
 */
export function computeAging(receivables: OpenReceivable[], now: Date): AgingBuckets {
  const buckets: AgingBuckets = { current: 0, d30: 0, d60: 0, d90plus: 0, totalOutstanding: 0 };
  for (const r of receivables) {
    if (r.outstandingMinor <= 0) continue;
    const ref = r.dueAt ?? r.issuedAt;
    const overdueDays = Math.floor((now.getTime() - ref.getTime()) / DAY);
    if (overdueDays <= 30) buckets.current += r.outstandingMinor;
    else if (overdueDays <= 60) buckets.d30 += r.outstandingMinor;
    else if (overdueDays <= 90) buckets.d60 += r.outstandingMinor;
    else buckets.d90plus += r.outstandingMinor;
    buckets.totalOutstanding += r.outstandingMinor;
  }
  return buckets;
}

export function isPeriodOpen(closedPeriods: { year: number; month: number }[], date: Date): boolean {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  return !closedPeriods.some((p) => p.year === y && p.month === m);
}
