import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  createDb,
  cycleCountLines,
  cycleCounts,
  docCounters,
  items,
  organizations,
  purchaseOrders,
  purgeTenantFinancials,
  stockBalances,
  stockLocations,
  stockMovements,
  vendors,
  nextDocNumber,
  type Database,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerInventoryCapabilities, type ModuleDeps } from "./index";

/**
 * N22 completion: the stock_balances projection is maintained by a database
 * trigger — consistent with the ledger whatever wrote the movement — so
 * reads stop re-summing the ledger; a rebuild replays the ledger and
 * repairs any drift; cycle counts can scope to one location; and document
 * numbers come from one per-org allocator instead of per-module MAX+1.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let mainLocId: string;
let otherLocId: string;

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerInventoryCapabilities(registry, deps);
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs; each assertion narrows its shape
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Projection Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

async function ledgerOnHand(itemId: string, locationId?: string): Promise<number> {
  const conds = [eq(stockMovements.orgId, orgId), eq(stockMovements.itemId, itemId)];
  if (locationId) conds.push(eq(stockMovements.locationId, locationId));
  const [row] = await db.db
    .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
    .from(stockMovements)
    .where(and(...conds));
  return Number(row?.total ?? 0);
}

async function projectedOnHand(itemId: string, locationId?: string): Promise<number> {
  const conds = [eq(stockBalances.orgId, orgId), eq(stockBalances.itemId, itemId)];
  if (locationId) conds.push(eq(stockBalances.locationId, locationId));
  const [row] = await db.db
    .select({ total: sql<number>`coalesce(sum(${stockBalances.quantity}), 0)` })
    .from(stockBalances)
    .where(and(...conds));
  return Number(row?.total ?? 0);
}

async function newItem(sku: string): Promise<string> {
  const [row] = await db.db
    .insert(items)
    .values({ orgId, sku, name: sku, salePriceMinor: 1_00 })
    .returning({ id: items.id });
  return row!.id;
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Projection Probe", slug: `pj-${orgId.slice(0, 8)}` });
  const [main] = await db.db.insert(stockLocations).values({ orgId, code: "MAIN", name: "Main shelf" }).returning({ id: stockLocations.id });
  const [other] = await db.db.insert(stockLocations).values({ orgId, code: "OTHER", name: "Back room" }).returning({ id: stockLocations.id });
  mainLocId = main!.id;
  otherLocId = other!.id;
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("N22 stock projections", () => {
  it("keeps the projection consistent with the ledger whatever wrote the movement", async () => {
    const itemId = await newItem("PJ-BOLT");

    // A fixture-style raw seed — the trigger maintains the projection for it
    // exactly as it does for service-written movements.
    await db.db.insert(stockMovements).values({ orgId, itemId, quantityDelta: 7_000, reason: "adjustment", actorType: "system", actorId: null });
    await db.db.insert(stockMovements).values({ orgId, itemId, quantityDelta: -2_000, reason: "sale", locationId: mainLocId, actorType: "system", actorId: null });
    await db.db.insert(stockMovements).values({ orgId, itemId, quantityDelta: 3_000, reason: "adjustment", locationId: otherLocId, actorType: "system", actorId: null });

    expect(await ledgerOnHand(itemId)).toBe(8_000);
    expect(await projectedOnHand(itemId)).toBe(8_000);
    expect(await projectedOnHand(itemId, mainLocId)).toBe(-2_000);
    expect(await projectedOnHand(itemId, otherLocId)).toBe(3_000);
  });

  it("rebuild replays the ledger and repairs a corrupted projection", async () => {
    const itemId = await newItem("PJ-NUT");
    await db.db.insert(stockMovements).values({ orgId, itemId, quantityDelta: 9_000, reason: "adjustment", actorType: "system", actorId: null });
    const trueQty = await ledgerOnHand(itemId);

    // Corrupt the derived row the way only a bug could.
    const [balance] = await db.db
      .select({ id: stockBalances.id })
      .from(stockBalances)
      .where(and(eq(stockBalances.orgId, orgId), eq(stockBalances.itemId, itemId)));
    await db.db.update(stockBalances).set({ quantity: 1 }).where(eq(stockBalances.id, balance!.id));
    expect(await projectedOnHand(itemId)).toBe(1);

    const result = await run("inventory.rebuildStockProjections", {});
    expect(result.rows).toBeGreaterThanOrEqual(1);
    expect(await projectedOnHand(itemId)).toBe(trueQty);
  });

  it("cycle counts can scope to one location and adjust only that location", async () => {
    const itemId = await newItem("PJ-LAMP");
    await db.db.insert(stockMovements).values([
      { orgId, itemId, quantityDelta: 10_000, reason: "adjustment", locationId: mainLocId, actorType: "system", actorId: null },
      { orgId, itemId, quantityDelta: 4_000, reason: "adjustment", locationId: otherLocId, actorType: "system", actorId: null },
    ]);

    const sheet = await run("inventory.createCycleCount", { skus: ["PJ-LAMP"], locationId: mainLocId });
    const [line] = await db.db
      .select({ expected: cycleCountLines.expectedThousandths })
      .from(cycleCountLines)
      .where(and(eq(cycleCountLines.countId, sheet.countId), eq(cycleCountLines.itemId, itemId)));
    expect(line!.expected).toBe(10_000);

    await run("inventory.recordCycleCounts", { countId: sheet.countId, counts: [{ sku: "PJ-LAMP", countedThousandths: 8_000 }] });
    const posted = await run("inventory.postCycleCount", { countId: sheet.countId });
    expect(posted.postedVariances).toBe(1);
    expect(posted.netVarianceThousandths).toBe(-2_000);

    expect(await projectedOnHand(itemId, mainLocId)).toBe(8_000);
    expect(await projectedOnHand(itemId, otherLocId)).toBe(4_000);
    const [countRow] = await db.db.select({ locationId: cycleCounts.locationId }).from(cycleCounts).where(eq(cycleCounts.id, sheet.countId));
    expect(countRow!.locationId).toBe(mainLocId);
  });

  it("allocates document numbers from one per-org counter seeded by existing maxima", async () => {
    const seedOrgId = crypto.randomUUID();
    await db.db.insert(organizations).values({ id: seedOrgId, name: "Projection Probe", slug: `pc-${seedOrgId.slice(0, 8)}` });

    await expect(nextDocNumber(db.db, seedOrgId, "carrier_pigeon")).rejects.toThrow(/unknown document sequence/);

    // No legacy rows: the sequence starts at 1 and marches.
    expect(await nextDocNumber(db.db, seedOrgId, "purchase_order")).toBe(1);
    expect(await nextDocNumber(db.db, seedOrgId, "purchase_order")).toBe(2);

    // A legacy document with a high number is honored: a fresh counter seeds
    // from MAX(number) of the org's existing rows.
    await db.db.delete(docCounters).where(and(eq(docCounters.orgId, seedOrgId), eq(docCounters.kind, "purchase_order")));
    const [vendor] = await db.db.insert(vendors).values({ orgId: seedOrgId, name: "Seed vendor" }).returning({ id: vendors.id });
    await db.db.insert(purchaseOrders).values({ orgId: seedOrgId, vendorId: vendor!.id, number: 41, status: "ordered" });
    expect(await nextDocNumber(db.db, seedOrgId, "purchase_order")).toBe(42);
  });
});
