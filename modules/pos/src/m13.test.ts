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
  payments,
  posSessions,
  stockMovements,
  type Database,
  purgeTenantFinancials,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerPosCapabilities, type ModuleDeps } from "./index";

/**
 * POS returns (M13.1): a returned sale credits the invoice, restores stock,
 * posts a balanced refund entry, refuses over-returns, and always gates.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let sessionId: string;
let itemId: string;

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

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "POS Return Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
  await db.db.insert(organizations).values({ id: orgId, name: "POS Return Probe", slug: `pr-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "2100", name: "Sales Tax Payable", type: "liability" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
  ]);
  await db.db.insert(customers).values({ orgId, name: "Walk-in" });
  const [item] = await db.db.insert(items).values({ orgId, sku: "RET-GADGET", name: "Return gadget", salePriceMinor: 200_00 }).returning({ id: items.id });
  itemId = item!.id;
  await db.db.insert(stockMovements).values({ orgId, itemId, quantityDelta: 10_000, reason: "adjustment", unitCostMinor: 80_00, actorType: "system", actorId: null });
  const [session] = await db.db.insert(posSessions).values({ orgId, register: "main" }).returning({ id: posSessions.id });
  sessionId = session!.id;
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} };
});

afterAll(async () => {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "POS Return Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
});

describe("pos returns (M13.1)", () => {
  it("always gates: moneyAmount is null regardless of input", () => {
    expect(makeRegistry().get("pos.returnSale")?.moneyAmount?.({ invoiceId: "x", reason: "r" } as never)).toBeNull();
  });

  it("a returned sale refunds, credits, restocks, and keeps books balanced", async () => {
    const sale = await run("pos.completeSale", {
      sessionId,
      lines: [{ description: "Return gadget", quantity: 2_000, unitPriceMinor: 200_00, taxMinor: 0, sku: "RET-GADGET" }],
      method: "cash",
    });
    expect(sale.totalMinor).toBe(400_00);

    const [inv] = await db.db.select({ id: invoices.id }).from(invoices).where(eq(invoices.posSessionId, sessionId));
    const returned = await run("pos.returnSale", { invoiceId: inv!.id, reason: "customer changed mind" });
    expect(returned.creditedMinor).toBe(400_00);
    expect(returned.restockedLines).toBe(1);

    const [stock] = await db.db
      .select({ total: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
      .from(stockMovements)
      .where(eq(stockMovements.itemId, itemId));
    expect(Number(stock!.total)).toBe(10_000); // back to opening

    const [drift] = await db.db
      .select({ d: sql<number>`coalesce(sum(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(eq(journalEntries.orgId, orgId));
    expect(Number(drift!.d)).toBe(0);

    await expect(run("pos.returnSale", { invoiceId: inv!.id, reason: "try to return twice" })).rejects.toThrow(/nothing left to return/);
  });

  it("shift summary reports session totals", async () => {
    const summary = await run("pos.shiftSummary", { sessionId });
    expect(summary).toMatchObject({ register: "main", salesCount: 1, takingsMinor: 400_00 });
  });

  it("allocates split payments exactly and adds only the cash share to the drawer", async () => {
    const [splitSession] = await db.db.insert(posSessions).values({ orgId, register: "split-test" }).returning({ id: posSessions.id });
    const sale = await run("pos.completeSale", {
      sessionId: splitSession!.id,
      lines: [{ description: "Return gadget", quantity: 1_000, unitPriceMinor: 200_00, taxMinor: 0, sku: "RET-GADGET" }],
      tenders: [
        { method: "cash", amountMinor: 75_00 },
        { method: "card", amountMinor: 125_00 },
      ],
      cashReceivedMinor: 80_00,
    });
    expect(sale).toMatchObject({ totalMinor: 200_00, changeGivenMinor: 5_00 });
    expect(sale.tenders).toEqual([
      { method: "cash", amountMinor: 75_00 },
      { method: "card", amountMinor: 125_00 },
    ]);

    const rows = await db.db.select({ method: payments.method, amountMinor: payments.amountMinor }).from(payments).where(eq(payments.invoiceId, sale.invoiceId));
    expect(rows).toEqual(expect.arrayContaining([
      { method: "cash", amountMinor: 75_00 },
      { method: "card", amountMinor: 125_00 },
    ]));
    const [session] = await db.db.select({ expectedCashMinor: posSessions.expectedCashMinor }).from(posSessions).where(eq(posSessions.id, splitSession!.id));
    expect(session?.expectedCashMinor).toBe(75_00);
  });

  it("leaves the cash drawer unchanged when a split sale is refunded to mobile money", async () => {
    const [refundSession] = await db.db.insert(posSessions).values({ orgId, register: "refund-destination-test" }).returning({ id: posSessions.id });
    const sale = await run("pos.completeSale", {
      sessionId: refundSession!.id,
      lines: [{ description: "Return gadget", quantity: 1_000, unitPriceMinor: 200_00, taxMinor: 0, sku: "RET-GADGET" }],
      tenders: [
        { method: "cash", amountMinor: 50_00 },
        { method: "card", amountMinor: 150_00 },
      ],
    });
    const returned = await run("pos.returnSale", {
      invoiceId: sale.invoiceId,
      reason: "customer requested mobile refund",
      refundMethod: "mobile_money",
    });
    expect(returned).toMatchObject({ creditedMinor: 200_00, refundMethod: "mobile_money" });
    const [drawer] = await db.db.select({ expectedCashMinor: posSessions.expectedCashMinor }).from(posSessions).where(eq(posSessions.id, refundSession!.id));
    expect(drawer?.expectedCashMinor).toBe(50_00);
  });

  it("rejects a split payment with an uncovered balance", async () => {
    await expect(run("pos.completeSale", {
      sessionId,
      lines: [{ description: "Return gadget", quantity: 1_000, unitPriceMinor: 200_00, taxMinor: 0, sku: "RET-GADGET" }],
      tenders: [{ method: "card", amountMinor: 150_00 }],
    })).rejects.toThrow(/tender allocations must exactly cover/);
  });

  it("requires and preserves an explanation when the counted drawer differs", async () => {
    const [varianceSession] = await db.db.insert(posSessions).values({ orgId, register: "variance-test" }).returning({ id: posSessions.id });
    await expect(run("pos.closeSession", { sessionId: varianceSession!.id, countedCashMinor: 100_00 })).rejects.toThrow(/reason is required/);
    const closed = await run("pos.closeSession", {
      sessionId: varianceSession!.id,
      countedCashMinor: 100_00,
      varianceReason: "A cash refund was not in the starting count.",
    });
    expect(closed).toMatchObject({ expectedCashMinor: 0, varianceMinor: 100_00, flagged: true });
    const [session] = await db.db.select({ varianceReason: posSessions.varianceReason }).from(posSessions).where(eq(posSessions.id, varianceSession!.id));
    expect(session?.varianceReason).toBe("A cash refund was not in the starting count.");
  });
});
