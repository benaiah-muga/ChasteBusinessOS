/**
 * Thirteen-week cash forecast (M10, ADR 0037).
 *
 * Advisory only — never a posting. Open receivables and payables are
 * bucketed into weekly closes from current cash. Every flow lands in
 * exactly one bucket (flows past the horizon fall into week 13; negative
 * offsets clamp into week 1), weekly closes chain, and the final close is
 * start cash plus every flow. Deterministic: byte-order stable, no locale.
 */

export interface ForecastFlow {
  /** When the money is expected (invoice dueAt, bill dueAt). */
  dueAt: Date;
  amountMinor: number;
  kind: "inflow" | "outflow";
  refId?: string;
}

export interface ForecastWeek {
  weekStart: Date;
  weekEnd: Date;
  inflowMinor: number;
  outflowMinor: number;
  closeMinor: number;
}

export interface CashForecast {
  startMinor: number;
  weeks: ForecastWeek[];
  finalMinor: number;
  lowestCloseMinor: number;
  lowestWeekIndex: number;
}

const WEEK_MS = 7 * 86_400_000;

/** Monday 00:00 UTC of the week containing d — deterministic week buckets. */
export function weekStartOf(d: Date): Date {
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return new Date(utc - dow * 86_400_000);
}

export function buildThirteenWeekForecast(
  startCashMinor: number,
  flows: ForecastFlow[],
  asOf: Date,
  weeks = 13,
): CashForecast {
  const firstWeekStart = weekStartOf(asOf).getTime();
  const buckets = Array.from({ length: weeks }, (_, i) => ({
    inflowMinor: 0,
    outflowMinor: 0,
    weekStart: new Date(firstWeekStart + i * WEEK_MS),
    weekEnd: new Date(firstWeekStart + (i + 1) * WEEK_MS - 1),
  }));

  for (const f of flows) {
    const diff = weekStartOf(f.dueAt).getTime() - firstWeekStart;
    const rawIndex = Math.floor(diff / WEEK_MS);
    const index = Math.min(weeks - 1, Math.max(0, rawIndex));
    if (f.kind === "inflow") buckets[index]!.inflowMinor += f.amountMinor;
    else buckets[index]!.outflowMinor += f.amountMinor;
  }

  let running = startCashMinor;
  const out: ForecastWeek[] = buckets.map((b) => {
    running += b.inflowMinor - b.outflowMinor;
    return {
      weekStart: b.weekStart,
      weekEnd: b.weekEnd,
      inflowMinor: b.inflowMinor,
      outflowMinor: b.outflowMinor,
      closeMinor: running,
    };
  });

  // The trough is the minimum over start cash and every weekly close.
  let lowestCloseMinor = startCashMinor;
  let lowestWeekIndex = -1;
  out.forEach((w, i) => {
    if (w.closeMinor < lowestCloseMinor) {
      lowestCloseMinor = w.closeMinor;
      lowestWeekIndex = i;
    }
  });

  return {
    startMinor: startCashMinor,
    weeks: out,
    finalMinor: running,
    lowestCloseMinor,
    lowestWeekIndex,
  };
}
