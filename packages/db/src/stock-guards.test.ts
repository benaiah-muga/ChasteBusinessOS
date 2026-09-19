import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  beginLedgerMaintenance,
  createDb,
  items,
  organizations,
  stockMovements,
  type Database,
} from "./index";

/**
 * ADR 0052 extended to inventory: quantity truth is append-only. Inserts are
 * ordinary writes; corrections are compensating movements (reversals, cycle
 * counts) - never edits to history. UPDATE/DELETE/TRUNCATE refuse outside the
 * declared maintenance context and succeed inside it.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
const orgId = crypto.randomUUID();
let itemId: string;
let movementId: string;

beforeAll(async () => {
  db = createDb(url);
  await db.db.insert(organizations).values({ id: orgId, name: "Stock Guard Probe", slug: `stock-guard-${orgId.slice(0, 8)}` });
  const [item] = await db.db
    .insert(items)
    .values({ orgId, sku: `SG-${orgId.slice(0, 6)}`, name: "Guard Probe Item" })
    .returning({ id: items.id });
  itemId = item!.id;
  const [movement] = await db.db
    .insert(stockMovements)
    .values({ orgId, itemId, quantityDelta: 10_000, reason: "adjustment", actorType: "system" })
    .returning({ id: stockMovements.id });
  movementId = movement!.id;
});

afterAll(async () => {
  await beginLedgerMaintenance(db.db, async (tx) => {
    await tx.delete(stockMovements).where(eq(stockMovements.orgId, orgId));
  });
  await db.db.delete(items).where(eq(items.id, itemId));
  await db.db.delete(organizations).where(eq(organizations.id, orgId));
  await db.client.end();
});

/** Drizzle wraps driver errors; match the refusal across message and cause. */
async function expectRefusal(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
    throw new Error(`expected refusal matching ${pattern}`);
  } catch (err) {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
    expect([err instanceof Error ? err.message : String(err), cause].join(" | ")).toMatch(pattern);
  }
}

describe("stock movement immutability at commit time", () => {
  it("accepts appending movements, including compensating reversals", async () => {
    const [reversal] = await db.db
      .insert(stockMovements)
      .values({ orgId, itemId, quantityDelta: -10_000, reason: "adjustment", note: "correction", actorType: "system" })
      .returning({ id: stockMovements.id });
    expect(reversal!.id).toBeTruthy();
  });

  it("refuses UPDATE, DELETE, and TRUNCATE outside the maintenance context", async () => {
    await expectRefusal(
      db.db.update(stockMovements).set({ quantityDelta: 99_000 }).where(eq(stockMovements.id, movementId)),
      /immutable/,
    );
    await expectRefusal(db.db.delete(stockMovements).where(eq(stockMovements.id, movementId)), /immutable/);
    await expectRefusal(db.db.execute(sql`TRUNCATE stock_movements`), /immutable/);
  });

  it("permits deletes only inside the declared maintenance context", async () => {
    await beginLedgerMaintenance(db.db, async (tx) => {
      await tx.delete(stockMovements).where(eq(stockMovements.id, movementId));
    });
    const rows = await db.db.select({ id: stockMovements.id }).from(stockMovements).where(eq(stockMovements.id, movementId));
    expect(rows).toHaveLength(0);
  });
});
