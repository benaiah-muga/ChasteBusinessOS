import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  customers,
  items,
  organizations,
  salesOrderLines,
  stockMovements,
  type Database,
  purgeTenantFinancials,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { openReserved } from "@chaste/module-inventory";
import { registerSalesCapabilities, type ModuleDeps } from "./index";

/**
 * Stock consistency under one order (N15): repeated lines for the same item
 * spend one running availability budget - 7 + 7 against 10 reserves 10, not
 * 14 - and concurrent confirms serialize on the item rows so two buyers
 * cannot both win the last unit.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let chairId: string;
let deskId: string;
let customerId: string;

const CHAIR = "SI-CHAIR";
const DESK = "SI-DESK";

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerSalesCapabilities(registry, deps);
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs; each assertion narrows its shape
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Stock Integrity Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Stock Integrity Probe", slug: `si-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1100", name: "Accounts Receivable", type: "asset" },
    { orgId, code: "1200", name: "Inventory", type: "asset" },
    { orgId, code: "2100", name: "Sales Tax Payable", type: "liability" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
  ]);
  const [chair] = await db.db
    .insert(items)
    .values({ orgId, sku: CHAIR, name: "Integrity Chair", salePriceMinor: 100_00 })
    .returning({ id: items.id });
  chairId = chair!.id;
  const [desk] = await db.db
    .insert(items)
    .values({ orgId, sku: DESK, name: "Integrity Desk", salePriceMinor: 300_00 })
    .returning({ id: items.id });
  deskId = desk!.id;
  const [cust] = await db.db.insert(customers).values({ orgId, name: "Integrity Buyer" }).returning({ id: customers.id });
  customerId = cust!.id;
  await db.db.insert(stockMovements).values([
    { orgId, itemId: chairId, quantityDelta: 10_000, reason: "adjustment", note: "opening count", actorType: "system", actorId: null },
    { orgId, itemId: deskId, quantityDelta: 5_000, reason: "adjustment", note: "opening count", actorType: "system", actorId: null },
  ]);
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} };
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("stock consistency under one order (N15)", () => {
  it("repeated lines reserve at most the available stock, not the demand sum", async () => {
    const created = await run("sales.createOrder", {
      customerId,
      lines: [
        { description: "Chair A", quantity: 7_000, unitPriceMinor: 100_00, sku: CHAIR },
        { description: "Chair B", quantity: 7_000, unitPriceMinor: 100_00, sku: CHAIR },
      ],
    });

    await expect(run("sales.confirmOrder", { orderId: created.orderId })).rejects.toThrow(/insufficient stock/);
    expect(await openReserved(db.db, orgId, chairId)).toBe(0);

    const partial = await run("sales.confirmOrder", { orderId: created.orderId, allowBackorder: true });
    expect(partial).toMatchObject({ confirmed: true, backordered: true, reservedThousandths: 10_000 });
    const perLine = await db.db
      .select({ description: salesOrderLines.description, reserved: salesOrderLines.reservedThousandths })
      .from(salesOrderLines)
      .where(eq(salesOrderLines.orderId, created.orderId));
    expect(perLine).toHaveLength(2);
    expect(perLine.map((l) => l.reserved).sort((a, b) => b - a)).toEqual([7_000, 3_000]);
    expect(await openReserved(db.db, orgId, chairId)).toBe(10_000);

    const cancelled = await run("sales.cancelOrder", { orderId: created.orderId });
    expect(cancelled).toMatchObject({ status: "cancelled", releasedThousandths: 10_000 });
    expect(await openReserved(db.db, orgId, chairId)).toBe(0);
  });

  it("budgets are per item identity: a repeated desk line never eats chair stock", async () => {
    const created = await run("sales.createOrder", {
      customerId,
      lines: [
        { description: "Chair", quantity: 4_000, unitPriceMinor: 100_00, sku: CHAIR },
        { description: "Desk A", quantity: 4_000, unitPriceMinor: 300_00, sku: DESK },
        { description: "Desk B", quantity: 4_000, unitPriceMinor: 300_00, sku: DESK },
      ],
    });
    const confirmed = await run("sales.confirmOrder", { orderId: created.orderId, allowBackorder: true });
    expect(confirmed.reservedThousandths).toBe(9_000); // chair 4k + desk 4k + 1k
    expect(await openReserved(db.db, orgId, chairId)).toBe(4_000);
    expect(await openReserved(db.db, orgId, deskId)).toBe(5_000);
    const cancelled = await run("sales.cancelOrder", { orderId: created.orderId });
    expect(cancelled.releasedThousandths).toBe(9_000);
  });

  it("two buyers racing for the same stock cannot both win", async () => {
    const a = await run("sales.createOrder", {
      customerId,
      lines: [{ description: "Race A", quantity: 10_000, unitPriceMinor: 100_00, sku: CHAIR }],
    });
    const b = await run("sales.createOrder", {
      customerId,
      lines: [{ description: "Race B", quantity: 10_000, unitPriceMinor: 100_00, sku: CHAIR }],
    });

    const [resA, resB] = await Promise.allSettled([
      run("sales.confirmOrder", { orderId: a.orderId }),
      run("sales.confirmOrder", { orderId: b.orderId }),
    ]);

    const winners = [resA, resB].filter((r) => r.status === "fulfilled");
    const losers = [resA, resB].filter((r) => r.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((losers[0] as PromiseRejectedResult).reason.message).toMatch(/insufficient stock/);
    expect(await openReserved(db.db, orgId, chairId)).toBe(10_000);

    const [winnerOrderRow] = await db.db
      .select({ id: salesOrderLines.orderId })
      .from(salesOrderLines)
      .where(and(eq(salesOrderLines.reservedThousandths, 10_000)));
    const cancelled = await run("sales.cancelOrder", { orderId: winnerOrderRow!.id });
    expect(cancelled.releasedThousandths).toBe(10_000);
  });
});
