export interface OpenReceivable {
  invoiceNumber: number;
  outstandingMinor: number;
  issuedAt: Date;
}

export interface AgingBuckets {
  current: number;
  d30: number;
  d60: number;
  d90plus: number;
  totalOutstanding: number;
}

const DAY = 86_400_000;

/** AR aging: outstanding value bucketed by invoice age at `now`. Pure. */
export function computeAging(receivables: OpenReceivable[], now: Date): AgingBuckets {
  const buckets: AgingBuckets = { current: 0, d30: 0, d60: 0, d90plus: 0, totalOutstanding: 0 };
  for (const r of receivables) {
    if (r.outstandingMinor <= 0) continue;
    const ageDays = Math.floor((now.getTime() - r.issuedAt.getTime()) / DAY);
    if (ageDays <= 30) buckets.current += r.outstandingMinor;
    else if (ageDays <= 60) buckets.d30 += r.outstandingMinor;
    else if (ageDays <= 90) buckets.d60 += r.outstandingMinor;
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
