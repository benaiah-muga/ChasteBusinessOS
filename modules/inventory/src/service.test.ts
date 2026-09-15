import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  cycleCountLines,
  cycleCounts,
  items,
  lots,
  organizations,
  stockMovements,
  type Database,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import {
  applyStockDelta,
  getOrCreateLot,
  itemBySku,
  withOrgContext,
  type ModuleDeps,
} from "./index";
import { registerInventoryCapabilities } from "./index";

/**
 * One inventory command service (N22): every writer locks the item rows and
 * moves quantity through the same guards, so concurrent commands serialize,
 * a lot can never move another item's stock, balances cannot go negative,
 * and a count sheet detects a receipt+sale during counting even when the
 * net quantity lands back where it started.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let widgetId: string;
let countedId: string;
let bystanderId: string;

const WIDGET = "N22-WIDGET";
const GADGET = "N22-GADGET";
const COUNTED = "N22-COUNTED";
const BYSTANDER = "N22-BYSTANDER";

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
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Inventory Service Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
}

async function seedStock(sku: string, itemId: string, quantity: number): Promise<void> {
  await db.db.insert(stockMovements).values({
    orgId,
    itemId,
    quantityDelta: quantity,
    reason: "adjustment",
    note: "opening count",
    actorType: "system",
    actorId: null,
  });
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Inventory Service Probe", slug: `n22-${orgId.slice(0, 8)}` });
  for (const sku of [WIDGET, GADGET, COUNTED, BYSTANDER]) {
    const [item] = await db.db
      .insert(items)
      .values({ orgId, sku, name: `Probe ${sku}`, salePriceMinor: 100_00 })
      .returning({ id: items.id });
    if (sku === WIDGET) widgetId = item!.id;
    if (sku === COUNTED) countedId = item!.id;
    if (sku === BYSTANDER) bystanderId = item!.id;
  }
  await seedStock(WIDGET, widgetId, 10_000);
  await seedStock(COUNTED, countedId, 40_000);
  await seedStock(BYSTANDER, bystanderId, 1_000);
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} };
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("inventory command service (N22)", () => {
  it("a lot of one item cannot move another item's stock", async () => {
    const item = await itemBySku(deps.db, orgId, WIDGET);
    const lotId = await withOrgContext(deps.db, orgId, (tx) => getOrCreateLot(tx, orgId, item!.id, "LOT-A"));
    const other = await itemBySku(deps.db, orgId, GADGET);
    await expect(
      withOrgContext(deps.db, orgId, (tx) =>
        applyStockDelta(tx, {
          orgId,
          itemId: other!.id,
          quantityDelta: -1_000,
          reason: "adjustment",
          note: "cross-item lot abuse",
          lotId,
          actorType: "human",
          actorId: null,
        }),
      ),
    ).rejects.toThrow(/different item/);
  });

  it("outbound adjustments cannot drive the balance negative", async () => {
    await expect(run("inventory.adjustStock", { sku: WIDGET, quantityDelta: -100_000, note: "way more than on hand" })).rejects.toThrow(
      /not there/,
    );
    const out = await run("inventory.adjustStock", { sku: WIDGET, quantityDelta: -2_000, note: "breakage" });
    expect(out.onHandThousandths).toBe(8_000);
    await run("inventory.adjustStock", { sku: WIDGET, quantityDelta: 2_000, note: "restock the broken unit" });
  });

  it("a transfer cannot pull from a location that does not hold the stock", async () => {
    const balance = async () =>
      (await run("inventory.stockReport", { belowReorderOnly: false })).items.find((i: { sku: string }) => i.sku === WIDGET)
        .onHandThousandths as number;
    const start = await balance();
    await run("inventory.createLocation", { code: "N22-SRC", name: "Source dock" });
    await run("inventory.createLocation", { code: "N22-DST", name: "Destination" });
    await run("inventory.adjustStock", { sku: WIDGET, quantityDelta: 5_000, note: "stage at source", locationCode: "N22-SRC" });
    expect(await balance()).toBe(start + 5_000);
    const transfer = await run("inventory.createTransfer", {
      fromLocationCode: "N22-SRC",
      toLocationCode: "N22-DST",
      lines: [{ sku: WIDGET, quantityThousandths: 15_000 }],
    });
    await expect(run("inventory.confirmTransfer", { transferId: transfer.transferId })).rejects.toThrow();
    await run("inventory.cancelTransfer", { transferId: transfer.transferId });
    // A feasible transfer conserves quantity, then the staged stock leaves through DST.
    const feasible = await run("inventory.createTransfer", {
      fromLocationCode: "N22-SRC",
      toLocationCode: "N22-DST",
      lines: [{ sku: WIDGET, quantityThousandths: 5_000 }],
    });
    await run("inventory.confirmTransfer", { transferId: feasible.transferId });
    expect(await balance()).toBe(start + 5_000);
    await run("inventory.adjustStock", { sku: WIDGET, quantityDelta: -5_000, note: "consume staged stock", locationCode: "N22-DST" });
    expect(await balance()).toBe(start);
  });

  it("two concurrent commands for the last unit serialize — exactly one wins", async () => {
    const report = await run("inventory.stockReport", { belowReorderOnly: false });
    const onHand = report.items.find((i: { sku: string }) => i.sku === WIDGET).onHandThousandths as number;
    expect(onHand).toBeGreaterThan(0);
    const results = await Promise.allSettled([
      run("inventory.adjustStock", { sku: WIDGET, quantityDelta: -onHand, note: "buyer A takes everything" }),
      run("inventory.adjustStock", { sku: WIDGET, quantityDelta: -onHand, note: "buyer B takes everything" }),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled").length;
    expect(wins).toBe(1);
    await expect(run("inventory.adjustStock", { sku: WIDGET, quantityDelta: -1, note: "overdraw probe" })).rejects.toThrow(
      /not there/,
    );
  });

  it("a receipt+sale during counting is caught even when net quantity is unchanged", async () => {
    const count = await run("inventory.createCycleCount", { skus: [COUNTED], note: "watermark probe" });
    await run("inventory.adjustStock", { sku: COUNTED, quantityDelta: 5_000, note: "goods received during count" });
    await run("inventory.adjustStock", { sku: COUNTED, quantityDelta: -5_000, note: "goods sold during count" });
    await run("inventory.recordCycleCounts", { countId: count.countId, counts: [{ sku: COUNTED, countedThousandths: 40_000 }] });
    await expect(run("inventory.postCycleCount", { countId: count.countId })).rejects.toThrow(/movements since/);
    const [sheet] = await db.db
      .select()
      .from(cycleCounts)
      .where(and(eq(cycleCounts.orgId, orgId), eq(cycleCounts.id, count.countId)))
      .limit(1);
    expect(sheet!.status).toBe("open");
  });

  it("an unrelated item moving does not invalidate another item's count line", async () => {
    await run("inventory.adjustStock", { sku: BYSTANDER, quantityDelta: 500, note: "unrelated movement" });
    const count = await run("inventory.createCycleCount", { skus: [COUNTED, BYSTANDER], note: "clean count" });
    await run("inventory.recordCycleCounts", {
      countId: count.countId,
      counts: [
        { sku: COUNTED, countedThousandths: 40_000 },
        { sku: BYSTANDER, countedThousandths: 1_500 },
      ],
    });
    const posted = await run("inventory.postCycleCount", { countId: count.countId });
    expect(posted.posted).toBe(true);
    expect(posted.postedVariances).toBe(0);
    const [line] = await db.db
      .select()
      .from(cycleCountLines)
      .where(and(eq(cycleCountLines.orgId, orgId), eq(cycleCountLines.countId, count.countId)))
      .limit(1);
    expect(line!.expectedMovementCount).toBeGreaterThan(0);
  });

  it("lots stay usable without manufacturing: inward adjustment tags a lot", async () => {
    // Widget ended the serialization test at zero; this batch is all there is.
    const tagged = await run("inventory.adjustStock", {
      sku: WIDGET,
      quantityDelta: 3_000,
      note: "supplier batch",
      lotCode: "LOT-B",
    });
    expect(tagged.onHandThousandths).toBe(3_000);
    const [lot] = await db.db
      .select()
      .from(lots)
      .where(and(eq(lots.orgId, orgId), eq(lots.lotCode, "LOT-B")))
      .limit(1);
    expect(lot!.itemId).toBe(widgetId);
  });
});
