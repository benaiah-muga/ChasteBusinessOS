import { and, eq } from "drizzle-orm";
import type { EffectReceipt, EffectReceiptStore } from "@chaste/kernel";
import { actionReceipts, withOrgContext, type Database } from "@chaste/db";

/**
 * Postgres-backed action receipts (B02). The executor's action key is
 * `${orgId}:${intentId}`; orgId leads the key and org ids contain no colons.
 * Reads and writes run inside the org context so the store stays correct
 * once the application connects under the NOBYPASSRLS runtime role.
 */
export function pgEffectReceiptStore(db: Database["db"]): EffectReceiptStore {
  return {
    async get(key) {
      const orgId = key.slice(0, key.indexOf(":"));
      if (!orgId) return null;
      return withOrgContext(db, orgId, async (tx) => {
        const [row] = await tx
          .select()
          .from(actionReceipts)
          .where(and(eq(actionReceipts.orgId, orgId), eq(actionReceipts.intentKey, key)))
          .limit(1);
        if (!row) return null;
        return {
          capabilityId: row.capabilityId,
          inputHash: row.inputHash,
          ok: row.ok,
          data: row.data ?? undefined,
          error: row.error ?? undefined,
          outcome: row.outcome as EffectReceipt["outcome"],
          recordedAt: row.recordedAt.toISOString(),
        };
      });
    },
    async put(key, receipt) {
      const orgId = key.slice(0, key.indexOf(":"));
      if (!orgId) throw new Error(`malformed action key: ${key}`);
      await withOrgContext(db, orgId, async (tx) => {
        await tx
          .insert(actionReceipts)
          .values({
            orgId,
            intentKey: key,
            capabilityId: receipt.capabilityId,
            inputHash: receipt.inputHash,
            ok: receipt.ok,
            outcome: receipt.outcome,
            data: receipt.data ?? null,
            error: receipt.error ?? null,
          })
          .onConflictDoNothing();
      });
    },
  };
}
