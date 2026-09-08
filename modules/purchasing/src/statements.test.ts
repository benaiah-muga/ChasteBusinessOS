import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  accounts,
  createDb,
  items,
  journalEntries,
  journalLines,
  organizations,
  stockMovements,
  vendorBills,
  vendors,
  type Database,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerPurchasingCapabilities, type ModuleDeps } from "./index";

/**
 * Supplier memory (M10.2, ADR 0037): receipts feed lead time, fill rate,
 * and price history; closing an order records the backordered shortfall;
 * returns reverse receipts through the same ledger; statements net bills,
 * payments, and credits with a running balance.
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
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Supplier Memory Probe"));
  for (const o of orgs) {
    const entries = await db.db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.orgId, o.id));
    for (const e of entries) {
      await db.db.delete(journalLines).where(eq(journalLines.entryId, e.id));
    }
    await db.db.delete(journalEntries).where(eq(journalEntries.orgId, o.id));
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "Supplier Memory Probe", slug: `sm-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "2000", name: "Accounts Payable", type: "liability" },
    { orgId, code: "6000", name: "Operating Expenses", type: "expense" },
  ]);
  const [vendor] = await db.db
    .insert(vendors)
    .values({ orgId, name: "Reliable Parts Co", paymentTermDays: 14 })
    .returning({ id: vendors.id });
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

describe("supplier memory + statements (M10.2)", () => {
  it("receipts feed performance, close flags backorders, returns reverse receipts", async () => {
    const [item] = await db.db
      .insert(items)
      .values({ orgId, sku: "MEM-BOLT", name: "Memory bolt", salePriceMinor: 5_00 })
      .returning({ id: items.id });

    const po = await run("purchasing.createPurchaseOrder", {
      vendorId,
      promisedAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      lines: [{ description: "Memory bolt crate", quantity: 60_000, unitPriceMinor: 2_000, sku: "MEM-BOLT" }],
    });
    const received = await run("purchasing.receiveGoods", {
      poNumber: po.poNumber,
      lines: [{ lineNumber: 1, quantity: 30_000 }],
    });
    expect(received.fullyReceived).toBe(false);

    const perf = await run("purchasing.supplierPerformance", {});
    const mine = perf.vendors.find((v: { vendorId: string }) => v.vendorId === vendorId);
    expect(mine).toMatchObject({ orders: 1, onTimeRate: 100, fillRate: 50, backorderedOrders: 0 });
    expect(mine.avgLeadTimeDays).toBe(0); // same-tick receipt

    const history = await run("purchasing.priceHistory", { sku: "MEM-BOLT" });
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]).toMatchObject({ vendorName: "Reliable Parts Co", unitPriceMinor: 2_000 });

    const returned = await run("purchasing.returnGoods", {
      poNumber: po.poNumber,
      lines: [{ lineNumber: 1, quantity: 10_000, reason: "rust spotted on half the crates" }],
    });
    expect(returned.returned).toBe(true);
    const [onHand] = await db.db
      .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
      .from(stockMovements)
      .where(eq(stockMovements.itemId, item!.id));
    expect(Number(onHand!.total)).toBe(20_000);

    const closed = await run("purchasing.closePurchaseOrder", { poNumber: po.poNumber });
    expect(closed).toMatchObject({ closed: true, backordered: true, shortThousandths: 40_000 });
  });

  it("bill terms set due dates and the supplier statement nets bills, credits, and payments", async () => {
    await run("purchasing.createBill", {
      vendorId,
      lines: [{ description: "Balance of order", quantity: 20_000, unitPriceMinor: 2_000, expenseAccountCode: "6000" }],
    });
    const [billRow] = await db.db.select({ dueAt: vendorBills.dueAt }).from(vendorBills).where(eq(vendorBills.orgId, orgId));
    expect(Math.round((billRow!.dueAt!.getTime() - ctx.now.getTime()) / 86_400_000)).toBe(14);

    const billId = (await db.db.select({ id: vendorBills.id }).from(vendorBills).where(eq(vendorBills.orgId, orgId))).at(-1)!.id;
    await run("purchasing.billCreditNote", { billId, amountMinor: 5_000, reason: "settled separately with vendor" });

    const stmt = await run("purchasing.supplierStatement", { vendorId });
    const kinds = stmt.rows.map((r: { kind: string }) => r.kind);
    expect(kinds).toContain("bill");
    expect(kinds).toContain("credit_note");
    expect(stmt.rows.at(-1)!.balanceMinor).toBe(stmt.closingBalanceMinor);
    expect(stmt.closingBalanceMinor).toBeGreaterThan(0);
  });
});
