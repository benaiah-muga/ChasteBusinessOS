import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bomLines, createDb, items, organizations, stockMovements, workOrders, type Database } from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerManufacturingCapabilities, type ModuleDeps } from "./index";

/**
 * Production feasibility (M11.4): the capability answers can-we-produce-N
 * from the exploded BOM versus stock, names the ceiling, and estimates
 * lead time from completed-run history.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerManufacturingCapabilities(registry, deps);
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs; each assertion narrows its shape
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Planning Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Planning Probe", slug: `pl-${orgId.slice(0, 8)}` });
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };

  const [assembly] = await db.db.insert(items).values({ orgId, sku: "CHAIR-ASSY", name: "Chair assembly", salePriceMinor: 5_000_00 }).returning({ id: items.id });
  const [bolt] = await db.db.insert(items).values({ orgId, sku: "BOLT", name: "Bolt", salePriceMinor: 100 }).returning({ id: items.id });
  const [frame] = await db.db.insert(items).values({ orgId, sku: "FRAME", name: "Frame", salePriceMinor: 900_00 }).returning({ id: items.id });
  await db.db.insert(bomLines).values([
    { orgId, assemblyItemId: assembly!.id, componentItemId: bolt!.id, quantityThousandths: 2_000 },
    { orgId, assemblyItemId: assembly!.id, componentItemId: frame!.id, quantityThousandths: 1_000 },
  ]);

  // Stock: bolts cover 350 units, frames cover 600 → ceiling 350.
  await db.db.insert(stockMovements).values([
    { orgId, itemId: bolt!.id, quantityDelta: 700_000, reason: "adjustment", actorType: "system", actorId: null },
    { orgId, itemId: frame!.id, quantityDelta: 600_000, reason: "adjustment", actorType: "system", actorId: null },
  ]);

  // Lead-time history: one completed order that took ~2 days.
  await db.db.insert(workOrders).values({
    orgId,
    number: 1,
    assemblyItemId: assembly!.id,
    plannedQtyThousandths: 10_000,
    status: "completed",
    workCenter: "bay-1",
    releasedAt: new Date(Date.now() - 4 * 86_400_000),
    completedAt: new Date(Date.now() - 2 * 86_400_000),
  });
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("production feasibility (M11.4)", () => {
  it("answers can-we-produce-500 with the shortfall and the ceiling", async () => {
    const answer = await run("manufacturing.checkProductionFeasibility", {
      assemblySku: "CHAIR-ASSY",
      desiredUnitsThousandths: 500_000,
    });
    expect(answer.producible).toBe(false);
    expect(answer.maxProducibleThousandths).toBe(350_000);
    const bolt = answer.lines.find((l: { itemId: string; shortfallThousandths: number }) => l.shortfallThousandths > 0);
    expect(bolt).toBeDefined();
    expect(bolt.shortfallThousandths).toBe(300_000);
    expect(answer.estimatedLeadTimeDays).toBe(2);
  });

  it("work orders carry the work center", async () => {
    const wo = await run("manufacturing.createWorkOrder", {
      assemblySku: "CHAIR-ASSY",
      plannedQtyThousandths: 100_000,
      workCenter: "bay-2",
    });
    const [row] = await db.db.select({ workCenter: workOrders.workCenter }).from(workOrders).where(eq(workOrders.number, wo.number));
    expect(row!.workCenter).toBe("bay-2");
  });
});
