/**
 * Recurring invoice schedule arithmetic. Pure so the worker can be tested
 * without a database and DST/timezone behavior is pinned by property tests.
 * All dates are UTC.
 */

export type RecurringFrequency = "weekly" | "monthly" | "quarterly";

/** The next due date strictly after `from`, preserving day-of-month intent. */
export function nextRunAfter(frequency: RecurringFrequency, from: Date): Date {
  const d = new Date(from.getTime());
  switch (frequency) {
    case "weekly":
      d.setUTCDate(d.getUTCDate() + 7);
      return d;
    case "monthly": {
      const day = d.getUTCDate();
      // Clamp to month end when the anchor day does not exist (Jan 31 → Feb 28).
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
      const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, daysInMonth));
      return d;
    }
    case "quarterly": {
      const day = d.getUTCDate();
      d.setUTCMonth(d.getUTCMonth() + 3, 1);
      const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, daysInMonth));
      return d;
    }
  }
}

/** True when a template is due as of `now`. */
export function isDue(nextRunAt: Date, now: Date): boolean {
  return nextRunAt.getTime() <= now.getTime();
}
