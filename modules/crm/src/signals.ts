import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { deals, tasks } from "@chaste/db";
import type { Database } from "@chaste/db";
import type { BusinessSignal, SignalProducer } from "@chaste/kernel";

/**
 * Pipeline signals (ADR 0034): open deals with no stage movement recently.
 * A deal that has gone quiet is the cheapest loss to prevent.
 *
 * M9 adds overdue tasks: a promised follow-up past its due date is red —
 * the cheapest trust to lose.
 */

const STALL_DAYS = 14;
const OPEN_STAGES = ["lead", "qualified", "proposal", "negotiation"] as const;

export function createCrmSignalProducer(db: Database["db"]): SignalProducer {
  return async (orgId, now) => {
    const rows = await db
      .select({
        id: deals.id,
        title: deals.title,
        stage: deals.stage,
        valueMinor: deals.valueMinor,
        updatedAt: deals.updatedAt,
      })
      .from(deals)
      .where(
        and(
          eq(deals.orgId, orgId),
          sql`${deals.stage} IN ('lead', 'qualified', 'proposal', 'negotiation')`,
        ),
      )
      .limit(200);

    const signals: BusinessSignal[] = [];
    for (const deal of rows) {
      if (!OPEN_STAGES.includes(deal.stage as (typeof OPEN_STAGES)[number])) continue;
      const ageDays = Math.floor((now.getTime() - deal.updatedAt.getTime()) / 86_400_000);
      if (ageDays < STALL_DAYS) continue;
      signals.push({
        id: `crm.stalled:${deal.id}`,
        severity: "orange",
        module: "crm",
        subject: `Deal "${deal.title}" has gone quiet for ${ageDays} days`,
        detail: `Sat in "${deal.stage}" with ${(deal.valueMinor / 100).toFixed(2)} attached — a nudge now is cheaper than a loss later.`,
        evidence: { refType: "deal", refId: deal.id },
        suggestedAction: {
          capabilityId: "crm.moveDealStage",
          inputDraft: { dealId: deal.id },
        },
      });
    }
    const overdue = await db
      .select({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt })
      .from(tasks)
      .where(and(eq(tasks.orgId, orgId), isNull(tasks.doneAt), lt(tasks.dueAt, now)))
      .limit(100);
    for (const t of overdue) {
      const daysLate = Math.floor((now.getTime() - t.dueAt!.getTime()) / 86_400_000);
      signals.push({
        id: `crm.taskOverdue:${t.id}`,
        severity: "red",
        module: "crm",
        subject: `Task "${t.title}" is ${daysLate} day${daysLate === 1 ? "" : "s"} overdue`,
        detail: `Due ${t.dueAt!.toISOString().slice(0, 10)} and still open. Close it or renegotiate the date — silent slippage is how trust erodes.`,
        evidence: { refType: "task", refId: t.id },
        suggestedAction: {
          capabilityId: "crm.completeTask",
          inputDraft: { taskId: t.id },
        },
      });
    }
    return signals;
  };
}
