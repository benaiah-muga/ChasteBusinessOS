import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { items, lots, stockBalances, stockMovements } from "@chaste/db";
import { recordStockMovement, stockOnHand, type DbLike, type MovementInput } from "./shared";

/**
 * N22 (ADR 0050): one command service for the stock ledger. Every writer -
 * inventory, POS, purchasing, sales, manufacturing - locks the item rows
 * first (stable id order, so concurrent commands cannot deadlock), then
 * moves quantity through here, which re-checks the guards against the
 * serialized state: lot must belong to the item being moved, and the
 * resulting on-hand may never go negative, org-wide or at the movement's
 * location when one is given.
 *
 * N22 completion: the stock_balances projection that stockOnHand reads is
 * maintained by a database trigger on stock_movements (migration 0053), so
 * the projection is consistent with the ledger by construction - whatever
 * wrote the movement - and rebuildStockBalances replays the ledger to
 * prove it.
 */

/** Locks the given items' rows in stable id order inside the caller's transaction. */
export async function lockStockItems(tx: DbLike, itemIds: string[]): Promise<void> {
  const ids = [...new Set(itemIds)].sort();
  if (ids.length === 0) return;
  await tx
    .select({ id: items.id })
    .from(items)
    .where(inArray(items.id, ids))
    .orderBy(asc(items.id))
    .for("update");
}

/**
 * Replays the ledger into the projection for one org - the read model is
 * derived state, and this is its one repair path. Returns the projection
 * rows written and the org-wide total quantity.
 */
export async function rebuildStockBalances(
  tx: DbLike,
  orgId: string,
): Promise<{ rows: number; totalQuantity: number }> {
  await tx.delete(stockBalances).where(eq(stockBalances.orgId, orgId));
  await tx.execute(sql`
    INSERT INTO stock_balances (org_id, item_id, location_id, lot_id, quantity)
    SELECT org_id, item_id, location_id, lot_id, sum(quantity_delta)::integer
    FROM stock_movements
    WHERE org_id = ${orgId}
    GROUP BY org_id, item_id, location_id, lot_id
  `);
  const [row] = await tx
    .select({ rows: sql<number>`count(*)`, total: sql<number>`coalesce(sum(${stockBalances.quantity}), 0)` })
    .from(stockBalances)
    .where(eq(stockBalances.orgId, orgId));
  return { rows: Number(row?.rows ?? 0), totalQuantity: Number(row?.total ?? 0) };
}

/** Movements recorded so far for one item - the watermark a count sheet is snapshotted against. */
export async function itemMovementCount(db: DbLike, orgId: string, itemId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(stockMovements)
    .where(and(eq(stockMovements.orgId, orgId), eq(stockMovements.itemId, itemId)));
  return Number(row?.count ?? 0);
}

/** Movement counts for many items in one query (count sheets snapshot every line at once). */
export async function movementCountsByItem(
  db: DbLike,
  orgId: string,
  itemIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (itemIds.length === 0) return counts;
  const rows = await db
    .select({ itemId: stockMovements.itemId, count: sql<number>`count(*)` })
    .from(stockMovements)
    .where(and(eq(stockMovements.orgId, orgId), inArray(stockMovements.itemId, itemIds)))
    .groupBy(stockMovements.itemId);
  for (const r of rows) counts.set(r.itemId, Number(r.count));
  for (const id of itemIds) if (!counts.has(id)) counts.set(id, 0);
  return counts;
}

async function assertLotBelongsToItem(db: DbLike, orgId: string, lotId: string, itemId: string): Promise<void> {
  const [lot] = await db
    .select({ itemId: lots.itemId })
    .from(lots)
    .where(and(eq(lots.orgId, orgId), eq(lots.id, lotId)))
    .limit(1);
  if (!lot) throw new Error(`lot ${lotId} does not exist in this organization`);
  if (lot.itemId !== itemId) {
    throw new Error(`lot ${lotId} belongs to a different item; a lot cannot move another item's stock`);
  }
}

/**
 * Moves quantity through the ledger under the item lock: validates the lot
 * binding, refuses any negative resulting balance (org-wide, and at the
 * movement's location when one is given), then appends the movement.
 */
export async function applyStockDelta(
  tx: DbLike,
  m: MovementInput,
): Promise<{ onHandThousandths: number }> {
  await lockStockItems(tx, [m.itemId]);

  if (m.lotId) await assertLotBelongsToItem(tx, m.orgId, m.lotId, m.itemId);

  const onHand = await stockOnHand(tx, m.orgId, m.itemId);
  if (onHand + m.quantityDelta < 0) {
    throw new Error(
      `cannot move ${-m.quantityDelta} thousandths of stock that is not there: ` +
        `only ${onHand} on hand for this item`,
    );
  }
  if (m.locationId) {
    const atLocation = await stockOnHand(tx, m.orgId, m.itemId, m.locationId);
    if (atLocation + m.quantityDelta < 0) {
      throw new Error(
        `cannot move ${-m.quantityDelta} thousandths from this location: ` +
          `only ${atLocation} on hand there`,
      );
    }
  }

  await recordStockMovement(tx, m);
  // stock_balances is updated by the stock_movements projection trigger
  // (migration 0053) inside this same transaction.
  return { onHandThousandths: onHand + m.quantityDelta };
}
