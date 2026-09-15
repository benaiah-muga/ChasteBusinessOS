import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  createDb,
  customers,
  invoices,
  items,
  journalEntries,
  journalLines,
  organizations,
  posSessions,
  stockMovements,
  stockReservations,
  type Database,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerPosCapabilities, type ModuleDeps } from "./index";

/**
 * Register oversell integrity (N15): repeated SKU lines spend one running
 * availability budget — 7 + 7 against 10 refuses — and stock promised to a
 * sales order (open reservation) is not sellable at the register.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let sessionId: string;
let itemId: string;

const SKU = "POS-STOCK-GADGET";

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerPosCapabilities(registry, deps);
  return registry;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "POS Stock Probe"));
  for (const o of orgs) {
    const es = await db.db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.orgId, o.id));
    for (const e of es) await db.db.delete(journalLines).where(eq(journalLines.entryId, e.id));
    await db.db.delete(journalEntries).where(eq(journalEntries.orgId, o.id));
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "POS Stock Probe", slug: `ps-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "2100", name: "Sales Tax Payable", type: "liability" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
  ]);
  await db.db.insert(customers).values({ orgId, name: "Walk-in" });
  const [item] = await db.db
    .insert(items)
    .values({ orgId, sku: SKU, name: "Stock gadget", salePriceMinor: 100_00 })
    .returning({ id: items.id });
  itemId = item!.id;
  await db.db.insert(stockMovements).values({ orgId, itemId, quantityDelta: 10_000, reason: "adjustment", actorType: "system", actorId: null });
  const [session] = await db.db.insert(posSessions).values({ orgId, register: "main" }).returning({ id: posSessions.id });
  sessionId = session!.id;
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} };
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("register oversell integrity (N15)", () => {
  it("repeated SKU lines check one shared budget, and a refused sale leaves nothing behind", async () => {
    // The first line consumed 7 of the 10-unit budget, so the refusal
    // reports the 3 000 the second line would have drawn from — proof the
    // lines share one budget rather than each seeing full stock.
    await expect(
      run("pos.completeSale", {
        sessionId,
        lines: [
          { description: "Gadget A", quantity: 7_000, unitPriceMinor: 100_00, taxMinor: 0, sku: SKU },
          { description: "Gadget B", quantity: 7_000, unitPriceMinor: 100_00, taxMinor: 0, sku: SKU },
        ],
        method: "cash",
      }),
    ).rejects.toThrow(/insufficient stock for POS-STOCK-GADGET: 3000 thousandths available/);

    const [invCount] = await db.db
      .select({ n: sql<number>`count(*)` })
      .from(invoices)
      .where(eq(invoices.orgId, orgId));
    expect(Number(invCount!.n)).toBe(0);
    const [mov] = await db.db
      .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
      .from(stockMovements)
      .where(eq(stockMovements.itemId, itemId));
    expect(Number(mov!.total)).toBe(10_000);
  });

  it("stock reserved for a sales order is not sellable at the register", async () => {
    await db.db.insert(stockReservations).values({
      orgId,
      itemId,
      quantityThousandths: 6_000,
      reason: "sales order #1",
      refType: "sales_order",
      refId: crypto.randomUUID(),
      status: "open",
      createdByActorType: "system",
      createdByActorId: null,
    });

    await expect(
      run("pos.completeSale", {
        sessionId,
        lines: [{ description: "Gadget", quantity: 5_000, unitPriceMinor: 100_00, taxMinor: 0, sku: SKU }],
        method: "cash",
      }),
    ).rejects.toThrow(/insufficient stock for POS-STOCK-GADGET: 4000 thousandths available/);

    const sale = await run("pos.completeSale", {
      sessionId,
      lines: [{ description: "Gadget", quantity: 4_000, unitPriceMinor: 100_00, taxMinor: 0, sku: SKU }],
      method: "cash",
    });
    expect(sale.totalMinor).toBe(400_00);
  });
});
