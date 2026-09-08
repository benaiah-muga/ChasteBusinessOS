import { and, eq, lt } from "drizzle-orm";
import { documents } from "@chaste/db";
import type { Database } from "@chaste/db";
import type { BusinessSignal, SignalProducer } from "@chaste/kernel";

/** Expiry signals (M12): documents past their validity date are red. */

export function createDocumentSignalProducer(db: Database["db"]): SignalProducer {
  return async (orgId, now) => {
    const rows = await db
      .select({ id: documents.id, title: documents.title, expiresAt: documents.expiresAt })
      .from(documents)
      .where(and(eq(documents.orgId, orgId), lt(documents.expiresAt, now)))
      .limit(100);
    const signals: BusinessSignal[] = [];
    for (const d of rows) {
      const days = Math.floor((now.getTime() - d.expiresAt!.getTime()) / 86_400_000);
      signals.push({
        id: `documents.expired:${d.id}`,
        severity: "red",
        module: "documents",
        subject: `Document "${d.title}" expired ${days} day${days === 1 ? "" : "s"} ago`,
        detail: `Past its validity date (${d.expiresAt!.toISOString().slice(0, 10)}). Renew it, or archive it so it stops looking current.`,
        evidence: { refType: "document", refId: d.id },
        suggestedAction: null,
      });
    }
    return signals;
  };
}
