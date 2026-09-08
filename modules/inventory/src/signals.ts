import { and, desc, eq, sql } from "drizzle-orm";
import { items, stockMovements } from "@chaste/db";
import { needsReorder } from "@chaste/erp-core";
import type { Database } from "@chaste/db";
import type { BusinessSignal, SignalProducer } from "@chaste/kernel";

/**
 * Inventory signals (ADR 0034): reorder pressure, dead stock, and anomalous
 * adjustments. Deterministic over the append-only ledger; thresholds live
 * here so policy tuning has one home.
 */

const DEAD_STOCK_DAYS = 90;
const ADJUSTMENT_ANOMALY_FRACTION = 0.5;

export function createInventorySignalProducer(db: Database["db"]): SignalProducer {
  return async (orgId, now) => {
    const itemRows = await db
      .select({
        id: items.id,
        sku: items.sku,
        name: items.name,
        reorderPoint: items.reorderPointThousandths,
        createdAt: items.createdAt,
      })
      .from(items)
      .where(and(eq(items.orgId, orgId), sql`${items.archivedAt} IS NULL`))
      .limit(200);
    if (itemRows.length === 0) return [];

    const onHandRows = await db
      .select({
        itemId: stockMovements.itemId,
        onHand: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)`,
      })
      .from(stockMovements)
      .where(eq(stockMovements.orgId, orgId))
      .groupBy(stockMovements.itemId);
    const onHandOf = new Map(onHandRows.map((r) => [r.itemId, Number(r.onHand)]));

    const lastOutboundRows = await db
      .select({
        itemId: stockMovements.itemId,
        lastOutbound: sql<Date>`max(${stockMovements.createdAt})`,
      })
      .from(stockMovements)
      .where(and(eq(stockMovements.orgId, orgId), sql`${stockMovements.quantityDelta} < 0`))
      .groupBy(stockMovements.itemId);
    const lastOutboundOf = new Map(lastOutboundRows.map((r) => [r.itemId, r.lastOutbound]));

    const signals: BusinessSignal[] = [];

    for (const item of itemRows) {
      const onHand = onHandOf.get(item.id) ?? 0;
      if (needsReorder(onHand, item.reorderPoint)) {
        signals.push({
          id: `inventory.reorder:${item.sku}`,
          severity: "orange",
          module: "inventory",
          subject: `${item.name} is at or below its reorder point`,
          detail: `${(onHand / 1000).toFixed(3)} on hand against a reorder point of ${(item.reorderPoint / 1000).toFixed(3)}.`,
          evidence: { refType: "item", refId: item.id },
          suggestedAction: {
            capabilityId: "purchasing.createPurchaseOrder",
            inputDraft: { memo: `Replenish ${item.sku}`, lines: [{ description: `${item.sku} replenishment`, quantity: Math.max(item.reorderPoint - onHand, 0) }] },
          },
        });
      }

      const lastOutbound = lastOutboundOf.get(item.id);
      const ageDays = Math.floor((now.getTime() - (lastOutbound ?? item.createdAt).getTime()) / 86_400_000);
      if (onHand > 0 && ageDays >= DEAD_STOCK_DAYS) {
        signals.push({
          id: `inventory.dead-stock:${item.sku}`,
          severity: "orange",
          module: "inventory",
          subject: `${item.name} has not moved in ${ageDays} days`,
          detail: `${(onHand / 1000).toFixed(3)} on hand with no outbound movement since ${Math.floor(ageDays / 30)} months — cash sitting on a shelf.`,
          evidence: { refType: "item", refId: item.id },
          suggestedAction: null,
        });
      }
    }

    const adjustments = await db
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.orgId, orgId), eq(stockMovements.reason, "adjustment")))
      .orderBy(desc(stockMovements.createdAt))
      .limit(50);
    for (const adj of adjustments) {
      const onHand = onHandOf.get(adj.itemId) ?? 0;
      if (onHand > 0 && Math.abs(adj.quantityDelta) > onHand * ADJUSTMENT_ANOMALY_FRACTION) {
        const [item] = itemRows.filter((i) => i.id === adj.itemId);
        signals.push({
          id: `inventory.anomalous-adjustment:${adj.id}`,
          severity: "red",
          module: "inventory",
          subject: `Unusual adjustment on ${item?.name ?? "an item"}`,
          detail: `A single adjustment of ${(adj.quantityDelta / 1000).toFixed(3)} is more than half the current on-hand (${(onHand / 1000).toFixed(3)}) — worth a look.`,
          evidence: { refType: "stock_movement", refId: adj.id },
          suggestedAction: null,
        });
      }
    }

    return signals;
  };
}
