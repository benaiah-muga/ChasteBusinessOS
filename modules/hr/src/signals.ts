import { and, eq, gte, sql } from "drizzle-orm";
import { employees, timeEntries } from "@chaste/db";
import type { Database } from "@chaste/db";
import type { BusinessSignal, SignalProducer } from "@chaste/kernel";

/**
 * Attendance signals (M11, ADR 0038): chronic lateness in the trailing
 * week. Deterministic — three or more late clock-ins since the cutoff —
 * and advisory: a conversation, not an accusation.
 */

const LATE_COUNT_THRESHOLD = 3;
const TRAILING_DAYS = 7;

export function createHrSignalProducer(db: Database["db"]): SignalProducer {
  return async (orgId, now) => {
    const cutoff = new Date(now.getTime() - TRAILING_DAYS * 86_400_000);
    const rows = await db
      .select({
        employeeId: employees.id,
        name: employees.name,
        lateCount: sql<number>`count(*)`,
      })
      .from(timeEntries)
      .innerJoin(employees, eq(employees.id, timeEntries.employeeId))
      .where(
        and(
          eq(timeEntries.orgId, orgId),
          eq(timeEntries.late, true),
          gte(timeEntries.clockedInAt, cutoff),
        ),
      )
      .groupBy(employees.id, employees.name);

    const signals: BusinessSignal[] = [];
    for (const r of rows) {
      const count = Number(r.lateCount);
      if (count < LATE_COUNT_THRESHOLD) continue;
      signals.push({
        id: `hr.lateStreak:${r.employeeId}`,
        severity: "orange",
        module: "hr",
        subject: `${r.name} clocked in late ${count} times in the last ${TRAILING_DAYS} days`,
        detail: `Pattern, not one-off — worth a conversation before it becomes a culture.`,
        evidence: { refType: "employee", refId: r.employeeId },
        suggestedAction: null,
      });
    }
    return signals;
  };
}
