import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
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
 * N16 deepening: receipts are a first-class document with accepted,
 * rejected, returned and remaining quantities; overreceipt tolerance is an
 * explicit authority; returns draw from concrete receipts; and line
 * addressing follows stable positions that survive reordering.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let vendorId: string;

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
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Receipt Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

async function onHand(itemId: string): Promise<number> {
  const [row] = await db.db
    .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
    .from(stockMovements)
    .where(eq(stockMovements.itemId, itemId));
  return Number(row?.total ?? 0);
}

async function orderStatus(poNumber: number): Promise<string> {
  const [row] = await db.db
    .select({ status: purchaseOrders.status })
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.orgId, orgId), eq(purchaseOrders.number, poNumber)));
  return row!.status;
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Receipt Probe", slug: `rc-${orgId.slice(0, 8)}` });
  const [vendor] = await db.db.insert(vendors).values({ orgId, name: "Receipt Vendor" }).returning({ id: vendors.id });
  vendorId = vendor!.id;
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("N16 receipt model", () => {
  it("records accepted and rejected quantities; only accepted goods stock", async () => {
    const [item] = await db.db
      .insert(items)
      .values({ orgId, sku: "RC-BOLT", name: "Receipt bolt", salePriceMinor: 5_00 })
      .returning({ id: items.id });
    const po = await run("purchasing.createPurchaseOrder", {
      vendorId,
      lines: [{ description: "Bolt crate", quantity: 10_000, unitPriceMinor: 2_000, sku: "RC-BOLT" }],
    });

    await expect(
      run("purchasing.receiveGoods", {
        poNumber: po.poNumber,
        lines: [{ lineNumber: 1, quantity: 8_000, rejected: 2_000 }],
      }),
    ).rejects.toThrow(/rejected goods need a rejectionNote/);

    const receipt = await run("purchasing.receiveGoods", {
      poNumber: po.poNumber,
      lines: [{ lineNumber: 1, quantity: 8_000, rejected: 2_000, rejectionNote: "rusted corner" }],
    });
    expect(receipt.receiptNumber).toBe(1);
    expect(receipt.fullyReceived).toBe(true);
    expect(await orderStatus(po.poNumber)).toBe("received");
    expect(await onHand(item!.id)).toBe(8_000);

    const detail = await run("purchasing.listReceipts", { poNumber: po.poNumber });
    expect(detail.receipts).toHaveLength(1);
    expect(detail.receipts[0].lines[0]).toMatchObject({
      position: 1,
      acceptedThousandths: 8_000,
      rejectedThousandths: 2_000,
      returnedThousandths: 0,
      rejectionNote: "rusted corner",
    });
    expect(detail.orderLines[0]).toMatchObject({
      position: 1,
      orderedThousandths: 10_000,
      acceptedThousandths: 8_000,
      rejectedThousandths: 2_000,
      returnedThousandths: 0,
      remainingThousandths: 0,
    });
  });

  it("sells overreceipt only with explicit paired authority", async () => {
    const [item] = await db.db
      .insert(items)
      .values({ orgId, sku: "RC-ROPE", name: "Receipt rope", salePriceMinor: 3_00 })
      .returning({ id: items.id });
    const po = await run("purchasing.createPurchaseOrder", {
      vendorId,
      lines: [{ description: "Rope spool", quantity: 10_000, unitPriceMinor: 1_500, sku: "RC-ROPE" }],
    });

    await expect(
      run("purchasing.receiveGoods", { poNumber: po.poNumber, lines: [{ lineNumber: 1, quantity: 10_500 }] }),
    ).rejects.toThrow(/overreceipt needs explicit authority/);
    await expect(
      run("purchasing.receiveGoods", {
        poNumber: po.poNumber,
        overreceiptTolerancePct: 10,
        lines: [{ lineNumber: 1, quantity: 10_500 }],
      }),
    ).rejects.toThrow(/authorityReason/);

    const receipt = await run("purchasing.receiveGoods", {
      poNumber: po.poNumber,
      overreceiptTolerancePct: 10,
      authorityReason: "site manager approved the extra spool in writing",
      lines: [{ lineNumber: 1, quantity: 10_500 }],
    });
    expect(receipt.received).toBe(true);
    expect(await onHand(item!.id)).toBe(10_500);
  });

  it("addresses lines by stable position, surviving reordering", async () => {
    const [a] = await db.db.insert(items).values({ orgId, sku: "RC-A", name: "Item A", salePriceMinor: 1_00 }).returning({ id: items.id });
    const [b] = await db.db.insert(items).values({ orgId, sku: "RC-B", name: "Item B", salePriceMinor: 1_00 }).returning({ id: items.id });
    const po = await run("purchasing.createPurchaseOrder", {
      vendorId,
      lines: [
        { description: "first", quantity: 5_000, unitPriceMinor: 100, sku: "RC-A" },
        { description: "second", quantity: 5_000, unitPriceMinor: 100, sku: "RC-B" },
      ],
    });

    // Someone reorders the display rows: what used to be line 2 is now
    // presented as line 1. Receipts must follow the position, not the row.
    const poScope = sql`${poLines.poId} = (SELECT id FROM purchase_orders WHERE org_id = ${orgId} AND number = ${po.poNumber})`;
    await db.db.update(poLines).set({ position: sql`-${poLines.position}` }).where(poScope);
    await db.db
      .update(poLines)
      .set({ position: sql`CASE ${poLines.position} WHEN -1 THEN 2 ELSE 1 END` })
      .where(poScope);

    await run("purchasing.receiveGoods", { poNumber: po.poNumber, lines: [{ lineNumber: 1, quantity: 1_000 }] });
    expect(await onHand(b!.id)).toBe(1_000);
    expect(await onHand(a!.id)).toBe(0);

    const detail = await run("purchasing.listReceipts", { poNumber: po.poNumber });
    expect(detail.orderLines.find((l: { position: number }) => l.position === 1).description).toBe("second");
    expect(detail.orderLines.find((l: { position: number }) => l.position === 1).acceptedThousandths).toBe(1_000);
  });

  it("links returns to concrete receipts and tracks returned quantities", async () => {
    const [item] = await db.db
      .insert(items)
      .values({ orgId, sku: "RC-LAMP", name: "Receipt lamp", salePriceMinor: 9_00 })
      .returning({ id: items.id });
    const po = await run("purchasing.createPurchaseOrder", {
      vendorId,
      lines: [{ description: "Lamp box", quantity: 10_000, unitPriceMinor: 4_000, sku: "RC-LAMP" }],
    });
    await run("purchasing.receiveGoods", { poNumber: po.poNumber, lines: [{ lineNumber: 1, quantity: 2_000 }] });
    const second = await run("purchasing.receiveGoods", { poNumber: po.poNumber, lines: [{ lineNumber: 1, quantity: 3_000 }] });

    await expect(
      run("purchasing.returnGoods", {
        poNumber: po.poNumber,
        receiptNumber: second.receiptNumber,
        lines: [{ lineNumber: 1, quantity: 3_500, reason: "cracked shades" }],
      }),
    ).rejects.toThrow(/receipt \d+ does not carry 3500 thousandths/);
    await expect(
      run("purchasing.returnGoods", {
        poNumber: po.poNumber,
        receiptNumber: 99,
        lines: [{ lineNumber: 1, quantity: 1_000, reason: "wrong receipt" }],
      }),
    ).rejects.toThrow(/receipt 99 does not belong to order/);

    await run("purchasing.returnGoods", {
      poNumber: po.poNumber,
      receiptNumber: second.receiptNumber,
      lines: [{ lineNumber: 1, quantity: 2_000, reason: "cracked shades" }],
    });
    const scoped = await run("purchasing.listReceipts", { poNumber: po.poNumber });
    expect(scoped.receipts[0].lines[0].returnedThousandths).toBe(0);
    expect(scoped.receipts[1].lines[0].returnedThousandths).toBe(2_000);
    expect(await onHand(item!.id)).toBe(3_000);

    // Unscoped returns draw FIFO: first receipt's 2_000, then receipt 2's
    // remaining 1_000.
    await run("purchasing.returnGoods", { poNumber: po.poNumber, lines: [{ lineNumber: 1, quantity: 3_000, reason: "full recall" }] });
    const after = await run("purchasing.listReceipts", { poNumber: po.poNumber });
    expect(after.receipts[0].lines[0].returnedThousandths).toBe(2_000);
    expect(after.receipts[1].lines[0].returnedThousandths).toBe(3_000);
    expect(await onHand(item!.id)).toBe(0);
    // Remaining counts undelivered quantity: the returned goods stay with
    // the vendor's account, shown in their own column.
    expect(after.orderLines[0].returnedThousandths).toBe(5_000);
    expect(after.orderLines[0].remainingThousandths).toBe(5_000);
  });
});
