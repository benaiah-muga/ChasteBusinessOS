import { and, eq, lt } from "drizzle-orm";
import { supportConversations } from "@chaste/db";
import type { Database } from "@chaste/db";
import type { BusinessSignal, SignalProducer } from "@chaste/kernel";

/** SLA breaches (M12): open tickets past their due date are red. */

export function createSupportSignalProducer(db: Database["db"]): SignalProducer {
  return async (orgId, now) => {
    const rows = await db
      .select({ id: supportConversations.id, ticketNumber: supportConversations.ticketNumber, slaDueAt: supportConversations.slaDueAt, priority: supportConversations.priority })
      .from(supportConversations)
      .where(and(eq(supportConversations.orgId, orgId), eq(supportConversations.status, "open"), lt(supportConversations.slaDueAt, now)))
      .limit(100);
    const signals: BusinessSignal[] = [];
    for (const t of rows) {
      const days = Math.floor((now.getTime() - t.slaDueAt!.getTime()) / 86_400_000);
      signals.push({
        id: `support.slaBreach:${t.id}`,
        severity: "red",
        module: "support",
        subject: `Ticket #${t.ticketNumber ?? "?"} breached its SLA ${days} day${days === 1 ? "" : "s"} ago`,
        detail: `Open ${t.priority}-priority ticket past its due date. Resolve it or renegotiate the deadline with the customer today.`,
        evidence: { refType: "support_conversation", refId: t.id },
        suggestedAction: null,
      });
    }
    return signals;
  };
}
