import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  items,
  organizations,
  poLines,
  purchaseOrders,
  stockMovements,
  vendors,
  type Database,
  purgeTenantFinancials,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerPurchasingCapabilities, type ModuleDeps } from "./index";

/**
 * Receiving and billing conservation (N16): receipts and returns respect
 * ordered quantities with one budget per line, service lines complete the
 * receiving contract without fake stock, a bill's repeated references to
 * one order line consume each other's allowance, a bill must come from the
 * order's vendor, and returning goods already shipped is refused while the
 * order status follows the goods.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let vendorId: string;
let otherVendorId: string;

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerPurchasingCapabilities(registry, deps);
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads heterogeneous capability outputs; each assertion narrows its shape
async function run<I>(id: string, input: I): Promise<any> {
  const cap = makeRegistry().get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

async function purgeProbeOrgs(): Promise<void> {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Receiving Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

async function nextPo(
  lines: Array<{ description: string; quantity: number; unitPriceMinor: number; sku?: string }>,
): Promise<number> {
  const created = await run("purchasing.createPurchaseOrder", { vendorId, lines });
  return created.poNumber;
}

async function orderStatus(poNumber: number): Promise<string> {
  const [row] = await db.db
    .select({ status: purchaseOrders.status })
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.orgId, orgId), eq(purchaseOrders.number, poNumber)));
  return row!.status;
}

/**
 * Lines are addressed by their stable display position, so tests must
 * resolve positions the way humans do — by looking at the order, not row
 * storage.
 */
async function lineNumberFor(poNumber: number, description: string): Promise<number> {
  const rows = await db.db
    .select({ position: poLines.position, description: poLines.description })
    .from(poLines)
    .innerJoin(purchaseOrders, eq(purchaseOrders.id, poLines.poId))
    .where(and(eq(purchaseOrders.orgId, orgId), eq(purchaseOrders.number, poNumber)))
    .orderBy(poLines.position);
  const row = rows.find((r) => r.description === description);
  if (!row) throw new Error(`no line "${description}" on order ${poNumber}`);
  return row.position;
}

async function itemIdBySku(sku: string): Promise<string> {
  const [row] = await db.db.select({ id: items.id }).from(items).where(and(eq(items.orgId, orgId), eq(items.sku, sku)));
  return row!.id;
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Receiving Probe", slug: `rc-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "2000", name: "Accounts Payable", type: "liability" },
    { orgId, code: "5000", name: "COGS", type: "expense" },
  ]);
  const [v1] = await db.db.insert(vendors).values({ orgId, name: "Acme Supply" }).returning({ id: vendors.id });
  vendorId = v1!.id;
  const [v2] = await db.db.insert(vendors).values({ orgId, name: "Other Vendor" }).returning({ id: vendors.id });
  otherVendorId = v2!.id;
  await db.db.insert(items).values([
    { orgId, sku: "RC-WIDGET", name: "Probe Widget", salePriceMinor: 500_00 },
    { orgId, sku: "RC-DESK", name: "Probe Desk", salePriceMinor: 900_00 },
    { orgId, sku: "RC-RETURN", name: "Probe Return Item", salePriceMinor: 100_00 },
  ]);
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} };
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("receiving and billing conservation (N16)", () => {
  it("refuses to receive more than the ordered quantity", async () => {
    const poNumber = await nextPo([{ description: "Widgets", quantity: 10_000, unitPriceMinor: 200_00, sku: "RC-WIDGET" }]);
    await expect(
      run("purchasing.receiveGoods", { poNumber, lines: [{ lineNumber: 1, quantity: 15_000 }] }),
    ).rejects.toThrow(/would exceed the ordered quantity \(ordered 10000, already accepted 0\)/);
    expect(await orderStatus(poNumber)).toBe("ordered");
  });

  it("repeated line references in one receipt spend one budget", async () => {
    const poNumber = await nextPo([{ description: "Desks", quantity: 10_000, unitPriceMinor: 300_00, sku: "RC-DESK" }]);
    await expect(
      run("purchasing.receiveGoods", {
        poNumber,
        lines: [
          { lineNumber: 1, quantity: 6_000 },
          { lineNumber: 1, quantity: 6_000 },
        ],
      }),
    ).rejects.toThrow(/would exceed the ordered quantity \(ordered 10000, already accepted 0\)/);
    const done = await run("purchasing.receiveGoods", {
      poNumber,
      lines: [
        { lineNumber: 1, quantity: 6_000 },
        { lineNumber: 1, quantity: 4_000 },
      ],
    });
    expect(done.fullyReceived).toBe(true);
    expect(await orderStatus(poNumber)).toBe("received");
  });

  it("service acceptance completes mixed and service-only orders without fake stock", async () => {
    const mixed = await nextPo([
      { description: "Widgets", quantity: 4_000, unitPriceMinor: 200_00, sku: "RC-WIDGET" },
      { description: "Installation", quantity: 6_000, unitPriceMinor: 100_00 },
    ]);
    const goodsLine = await lineNumberFor(mixed, "Widgets");
    const serviceLine = await lineNumberFor(mixed, "Installation");
    const goodsOnly = await run("purchasing.receiveGoods", { poNumber: mixed, lines: [{ lineNumber: goodsLine, quantity: 4_000 }] });
    expect(goodsOnly.fullyReceived).toBe(false);
    expect(await orderStatus(mixed)).toBe("partial");
    const both = await run("purchasing.receiveGoods", { poNumber: mixed, lines: [{ lineNumber: serviceLine, quantity: 6_000 }] });
    expect(both.fullyReceived).toBe(true);
    expect(await orderStatus(mixed)).toBe("received");

    const serviceOnly = await nextPo([{ description: "Consulting retainer", quantity: 8_000, unitPriceMinor: 150_00 }]);
    const done = await run("purchasing.receiveGoods", { poNumber: serviceOnly, lines: [{ lineNumber: 1, quantity: 8_000 }] });
    expect(done.fullyReceived).toBe(true);
    expect(await orderStatus(serviceOnly)).toBe("received");
  });

  it("a bill's repeated references to one order line consume each other's allowance", async () => {
    const poNumber = await nextPo([{ description: "Widgets", quantity: 10_000, unitPriceMinor: 200_00, sku: "RC-WIDGET" }]);
    await run("purchasing.receiveGoods", { poNumber, lines: [{ lineNumber: 1, quantity: 10_000 }] });
    await expect(
      run("purchasing.createBill", {
        vendorId,
        poNumber,
        lines: [
          { description: "Widgets part A", quantity: 6_000, unitPriceMinor: 200_00, expenseAccountCode: "5000", poLineNumber: 1 },
          { description: "Widgets part B", quantity: 6_000, unitPriceMinor: 200_00, expenseAccountCode: "5000", poLineNumber: 1 },
        ],
      }),
    ).rejects.toThrow(/three-way match failed on line 1/);
    const bill = await run("purchasing.createBill", {
      vendorId,
      poNumber,
      lines: [
        { description: "Widgets part A", quantity: 6_000, unitPriceMinor: 200_00, expenseAccountCode: "5000", poLineNumber: 1 },
        { description: "Widgets part B", quantity: 4_000, unitPriceMinor: 200_00, expenseAccountCode: "5000", poLineNumber: 1 },
      ],
    });
    // 10 000 thousandths (10 units) at 200.00 each = 2 000.00
    expect(bill.totalMinor).toBe(200_000);
  });

  it("a bill from a different vendor than the order's is refused", async () => {
    const poNumber = await nextPo([{ description: "Desks", quantity: 2_000, unitPriceMinor: 300_00, sku: "RC-DESK" }]);
    await expect(
      run("purchasing.createBill", {
        vendorId: otherVendorId,
        poNumber,
        lines: [{ description: "Desks", quantity: 2_000, unitPriceMinor: 300_00, expenseAccountCode: "5000", poLineNumber: 1 }],
      }),
    ).rejects.toThrow(/vendor mismatch: order \d+ belongs to a different vendor/);
  });

  it("returns of shipped stock are refused and returns demote the order status", async () => {
    // A dedicated item: the on-hand guard is per item across the whole org,
    // so this test must not share stock with the suites above.
    const poNumber = await nextPo([{ description: "Returnables", quantity: 10_000, unitPriceMinor: 100_00, sku: "RC-RETURN" }]);
    await run("purchasing.receiveGoods", { poNumber, lines: [{ lineNumber: 1, quantity: 10_000 }] });
    expect(await orderStatus(poNumber)).toBe("received");

    // Simulate the goods having been sold on: stock leaves, the PO's net
    // receipt history does not.
    const returnItemId = await itemIdBySku("RC-RETURN");
    await db.db.insert(stockMovements).values({
      orgId,
      itemId: returnItemId,
      quantityDelta: -10_000,
      reason: "sale",
      note: "probe sale draining stock",
      actorType: "system",
      actorId: null,
    });
    await expect(
      run("purchasing.returnGoods", { poNumber, lines: [{ lineNumber: 1, quantity: 4_000, reason: "defective units" }] }),
    ).rejects.toThrow(/only 0 thousandths of this item are on hand/);

    // Restock and return for real: status demotes from received to partial,
    // and returning more than was received net of prior returns is refused.
    await db.db.insert(stockMovements).values({
      orgId,
      itemId: returnItemId,
      quantityDelta: 10_000,
      reason: "adjustment",
      note: "probe restock",
      actorType: "system",
      actorId: null,
    });
    const back = await run("purchasing.returnGoods", { poNumber, lines: [{ lineNumber: 1, quantity: 4_000, reason: "defective units" }] });
    expect(back.returned).toBe(true);
    expect(await orderStatus(poNumber)).toBe("partial");
    await expect(
      run("purchasing.returnGoods", { poNumber, lines: [{ lineNumber: 1, quantity: 7_000, reason: "second attempt" }] }),
    ).rejects.toThrow(/only 6000 thousandths were received and not already returned/);
  });
});
