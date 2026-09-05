import { and, asc, eq, sql } from "drizzle-orm";
import { items, lots, stockMovements, type Database, withOrgContext } from "@chaste/db";

export interface ModuleDeps {
  db: Database["db"];
}

export type Tx = Parameters<Parameters<ModuleDeps["db"]["transaction"]>[0]>[0];
export type DbLike = Tx | ModuleDeps["db"];

export interface MovementInput {
  orgId: string;
  itemId: string;
  quantityDelta: number;
  reason: "purchase" | "sale" | "adjustment" | "production" | "transfer";
  note?: string | undefined;
  refType?: string | undefined;
  refId?: string | undefined;
  unitCostMinor?: number | undefined;
  locationId?: string | undefined;
  lotId?: string | undefined;
  actorType: "human" | "agent" | "system";
  actorId: string | null;
}

/**
 * Shared writer for the append-only stock ledger. Other modules (POS,
 * purchasing) import this so every quantity change lands in one ledger
 * with a reason and an actor, whatever wrote it.
 */
export async function recordStockMovement(tx: Tx | ModuleDeps["db"], m: MovementInput): Promise<void> {
  await tx.insert(stockMovements).values({
    orgId: m.orgId,
    itemId: m.itemId,
    quantityDelta: m.quantityDelta,
    reason: m.reason,
    note: m.note ?? null,
    refType: m.refType ?? null,
    refId: m.refId ?? null,
    unitCostMinor: m.unitCostMinor ?? null,
    locationId: m.locationId ?? null,
    lotId: m.lotId ?? null,
    actorType: m.actorType,
    actorId: m.actorId,
  });
}

/** Current on-hand thousandths for one item (optionally at one location). */
export async function stockOnHand(db: DbLike, orgId: string, itemId: string, locationId?: string): Promise<number> {
  const conditions = [eq(stockMovements.orgId, orgId), eq(stockMovements.itemId, itemId)];
  if (locationId) conditions.push(eq(stockMovements.locationId, locationId));
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
    .from(stockMovements)
    .where(and(...conditions));
  return Number(row?.total ?? 0);
}

/** Ordered movement history for valuation replay (moving average). */
export async function movementHistory(db: DbLike, orgId: string, itemId: string) {
  return db
    .select({
      quantityDelta: stockMovements.quantityDelta,
      unitCostMinor: stockMovements.unitCostMinor,
      reason: stockMovements.reason,
      createdAt: stockMovements.createdAt,
    })
    .from(stockMovements)
    .where(and(eq(stockMovements.orgId, orgId), eq(stockMovements.itemId, itemId)))
    .orderBy(asc(stockMovements.createdAt));
}

export async function itemBySku(db: DbLike, orgId: string, sku: string) {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.orgId, orgId), eq(items.sku, sku)))
    .limit(1);
  return row ?? null;
}

/**
 * Finds or creates a lot for one item inside the caller's transaction.
 * Lot codes are unique per (org, item); races resolve via the unique index
 * with an on-conflict re-select rather than failing the run.
 */
export async function getOrCreateLot(tx: Tx, orgId: string, itemId: string, lotCode: string): Promise<string> {
  const [existing] = await tx
    .select({ id: lots.id })
    .from(lots)
    .where(and(eq(lots.orgId, orgId), eq(lots.itemId, itemId), eq(lots.lotCode, lotCode)))
    .limit(1);
  if (existing) return existing.id;
  await tx.insert(lots).values({ orgId, itemId, lotCode }).onConflictDoNothing();
  const [row] = await tx
    .select({ id: lots.id })
    .from(lots)
    .where(and(eq(lots.orgId, orgId), eq(lots.itemId, itemId), eq(lots.lotCode, lotCode)))
    .limit(1);
  if (!row) throw new Error(`could not resolve lot "${lotCode}"`);
  return row.id;
}

export { withOrgContext };
