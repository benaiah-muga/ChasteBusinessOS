import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  createDb,
  customers,
  items,
  journalEntries,
  journalLines,
  organizations,
  salesOrderLines,
  stockMovements,
  type Database,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { openReserved } from "@chaste/module-inventory";
import { registerSalesCapabilities, type ModuleDeps } from "./index";

/**
 * Live-database proof of sales-order fulfillment (M9.2, ADR 0036):
 * confirming reserves, delivery consumes reservations and invoices exactly
 * what shipped through the shared posting path (books stay balanced),
 * cancellation releases untouched reservations, oversell is refused, and
 * the credit guard refuses before any reservation exists.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let itemId: string;
let customerId: string;

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
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Sales Probe"));
  for (const o of orgs) {
    const entries = await db.db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.orgId, o.id));
    for (const e of entries) {
      await db.db.delete(journalLines).where(eq(journalLines.entryId, e.id));
    }
    await db.db.delete(journalEntries).where(eq(journalEntries.orgId, o.id));
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

async function booksBalanced(): Promise<boolean> {
  const [row] = await db.db
    .select({
      drift: sql<number>`coalesce(sum(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(eq(journalEntries.orgId, orgId));
  return Number(row?.drift ?? 0) === 0;
}

const UNIT_PRICE = 200_00;

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Sales Probe", slug: `so-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1100", name: "Accounts Receivable", type: "asset" },
    { orgId, code: "1200", name: "Inventory", type: "asset" },
    { orgId, code: "2100", name: "Sales Tax Payable", type: "liability" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
  ]);
  const [item] = await db.db
    .insert(items)
    .values({ orgId, sku: "SO-CHAIR", name: "Probe Chair", salePriceMinor: UNIT_PRICE })
    .returning({ id: items.id });
  itemId = item!.id;
  const [cust] = await db.db
    .insert(customers)
    .values({ orgId, name: "Probe Customer" })
    .returning({ id: customers.id });
  customerId = cust!.id;
  await db.db.insert(stockMovements).values({
    orgId,
    itemId,
    quantityDelta: 100_000, // 100 units on hand
    reason: "adjustment",
    note: "opening count",
    actorType: "system",
    actorId: null,
  });
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
});

afterAll(async () => {
  await purgeProbeOrgs();
});

describe("sales orders (M9.2)", () => {
  it("confirming reserves stock and reduces available-to-promise", async () => {
    const created = await run("sales.createOrder", {
      customerId,
      lines: [{ description: "Probe Chair", quantity: 30_000, unitPriceMinor: UNIT_PRICE, sku: "SO-CHAIR" }],
    });
    const confirmed = await run("sales.confirmOrder", { orderId: created.orderId });
    expect(confirmed).toMatchObject({ confirmed: true, backordered: false, reservedThousandths: 30_000 });
    expect(await openReserved(db.db, orgId, itemId)).toBe(30_000);
    const cancelled = await run("sales.cancelOrder", { orderId: created.orderId });
    expect(cancelled).toMatchObject({ status: "cancelled", releasedThousandths: 30_000 });
  });

  it("oversell is refused without allowBackorder", async () => {
    const created = await run("sales.createOrder", {
      customerId,
      lines: [{ description: "Probe Chair", quantity: 200_000, unitPriceMinor: UNIT_PRICE, sku: "SO-CHAIR" }],
    });
    await expect(run("sales.confirmOrder", { orderId: created.orderId })).rejects.toThrow(/insufficient stock/);
  });

  it("allowBackorder reserves what exists and flags the order", async () => {
    const created = await run("sales.createOrder", {
      customerId,
      lines: [{ description: "Probe Chair", quantity: 200_000, unitPriceMinor: UNIT_PRICE, sku: "SO-CHAIR" }],
    });
    const confirmed = await run("sales.confirmOrder", { orderId: created.orderId, allowBackorder: true });
    expect(confirmed).toMatchObject({ confirmed: true, backordered: true, reservedThousandths: 100_000 });
    const cancelled = await run("sales.cancelOrder", { orderId: created.orderId });
    expect(cancelled).toMatchObject({ status: "cancelled", releasedThousandths: 100_000 });
    expect(await openReserved(db.db, orgId, itemId)).toBe(0);
  });

  it("partial delivery consumes reservations, invoices what shipped, and keeps books balanced", async () => {
    const created = await run("sales.createOrder", {
      customerId,
      lines: [{ description: "Probe Chair", quantity: 30_000, unitPriceMinor: UNIT_PRICE, taxMinor: 60_000, sku: "SO-CHAIR" }],
    });
    await run("sales.confirmOrder", { orderId: created.orderId });

    const lines = await db.db.select({ id: salesOrderLines.id }).from(salesOrderLines).where(eq(salesOrderLines.orderId, created.orderId));
    const lineId = lines[0]!.id;

    const first = await run("sales.deliverOrder", { orderId: created.orderId, lines: [{ lineId, quantityThousandths: 18_000 }] });
    expect(first.orderStatus).toBe("confirmed");
    // 18 units × $200 = $3,600 + prorated tax (2/3 of $60... line taxMinor 60_000 = $600 → $360)
    expect(first.invoiceTotalMinor).toBe(396_000);
    const [stockRow] = await db.db
      .select({ onHand: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
      .from(stockMovements)
      .where(eq(stockMovements.itemId, itemId));
    expect(Number(stockRow!.onHand)).toBe(82_000);

    const rest = await run("sales.deliverOrder", { orderId: created.orderId });
    expect(rest.orderStatus).toBe("delivered");
    expect(rest.invoiceTotalMinor).toBe(264_000);
    expect(await openReserved(db.db, orgId, itemId)).toBe(0);
    expect(await booksBalanced()).toBe(true);
  });

  it("credit guard refuses before any reservation exists", async () => {
    await db.db.update(customers).set({ creditLimitMinor: 500_000 }).where(eq(customers.id, customerId));
    try {
      const created = await run("sales.createOrder", {
        customerId,
        lines: [{ description: "Probe Chair", quantity: 40_000, unitPriceMinor: UNIT_PRICE, sku: "SO-CHAIR" }],
      });
      await expect(run("sales.confirmOrder", { orderId: created.orderId })).rejects.toThrow(/credit limit exceeded/);
      expect(await openReserved(db.db, orgId, itemId)).toBe(0);
    } finally {
      await db.db.update(customers).set({ creditLimitMinor: null }).where(eq(customers.id, customerId));
    }
  });
});
