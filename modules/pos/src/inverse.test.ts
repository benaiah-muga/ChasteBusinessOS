import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  accounts,
  createDb,
  customers,
  invoiceLines,
  invoices,
  items,
  journalEntries,
  journalLines,
  organizations,
  posReturnLines,
  posReturns,
  posSessions,
  stockMovements,
  type Database,
  purgeTenantFinancials,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerPosCapabilities, type ModuleDeps } from "./index";

/**
 * POS inverse round-trip (N12, ADR 0051): completeSale's declared inverse is
 * pos.returnSale, and buildInput against the ACTUAL sale output produces
 * input the return accepts - the return then restores stock, the drawer and
 * the money together. A journal mirror alone could never do all three.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;
let sessionId: string;
let itemId: string;

const SKU = "POS-INV-PROBE";

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
  const orgs = await db.db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, "POS Inverse Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await purgeProbeOrgs();
  await db.db.insert(organizations).values({ id: orgId, name: "POS Inverse Probe", slug: `pi-${orgId.slice(0, 8)}` });
  await db.db.insert(accounts).values([
    { orgId, code: "1000", name: "Cash", type: "asset" },
    { orgId, code: "2100", name: "Sales Tax Payable", type: "liability" },
    { orgId, code: "4000", name: "Sales Revenue", type: "income" },
  ]);
  await db.db.insert(customers).values({ orgId, name: "Walk-in" });
  const [item] = await db.db
    .insert(items)
    .values({ orgId, sku: SKU, name: "Inverse Probe Widget" })
    .returning({ id: items.id });
  itemId = item!.id;
  await db.db.insert(stockMovements).values({
    orgId,
    itemId,
    quantityDelta: 5000,
    reason: "adjustment",
    note: "opening stock",
    actorType: "human",
  });
  ctx = {
    actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
  const session = await run("pos.openSession", { register: "inverse-probe", openingFloatMinor: 5_000 });
  sessionId = session.sessionId;
});

afterAll(async () => {
  await purgeProbeOrgs();
  await db.db.$client.end();
});

function onHand(): Promise<number> {
  return db.db
    .select({ total: stockMovements.quantityDelta })
    .from(stockMovements)
    .where(and(eq(stockMovements.orgId, orgId), eq(stockMovements.itemId, itemId)))
    .then((rows) => rows.reduce((s, r) => s + r.total, 0));
}

describe("N12 POS inverse round-trip", () => {
  it("completeSale's inverse builds valid returnSale input that undoes stock, drawer and money", async () => {
    const before = await onHand();
    const sale = await run("pos.completeSale", {
      sessionId,
      lines: [{ description: SKU, quantity: 2000, unitPriceMinor: 10_000, taxMinor: 0, sku: SKU }],
      method: "cash",
    });
    expect(sale.invoiceId).toBeTruthy();
    expect(await onHand()).toBe(before - 2000);

    let [session] = await db.db.select().from(posSessions).where(eq(posSessions.id, sessionId));
    const expectedAfterSale = session!.expectedCashMinor;
    expect(expectedAfterSale).toBe(20_000);

    // The conformance proof: exercise the declared inverse against the
    // actual output. buildInput is typed, so this is also compile-checked.
    const saleCap = makeRegistry().require("pos.completeSale");
    const saleInput = { sessionId, lines: [{ description: SKU, quantity: 2000, unitPriceMinor: 10_000, taxMinor: 0, sku: SKU }], method: "cash" as const };
    const inverseInput = saleCap.inverse!.buildInput(saleInput, sale);
    expect(inverseInput).toMatchObject({ invoiceId: sale.invoiceId });

    // The built input must parse against returnSale's schema - a named
    // capability is not enough, the generated input has to be accepted.
    const returnCap = makeRegistry().require("pos.returnSale");
    const parsed = returnCap.input.parse(inverseInput);

    const result = await run("pos.returnSale", parsed);
    expect(result.creditedMinor).toBe(20_000);
    expect(result.restockedLines).toBe(1);
    expect(await onHand()).toBe(before);

    [session] = await db.db.select().from(posSessions).where(eq(posSessions.id, sessionId));
    // Cash physically left the drawer: expected drops back with the refund.
    expect(session!.expectedCashMinor).toBe(expectedAfterSale - 20_000);

    const [inv] = await db.db.select().from(invoices).where(eq(invoices.id, sale.invoiceId));
    expect(inv!.creditedMinor).toBe(20_000);
    expect(inv!.status).not.toBe("void");

    const [refundEntry] = await db.db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, result.refundEntryId));
    expect(refundEntry!.sourceType).toBe("pos_return");
  });

  it("a returned sale cannot be returned twice past its total", async () => {
    const sale = await run("pos.completeSale", {
      sessionId,
      lines: [{ description: SKU, quantity: 1000, unitPriceMinor: 4_000, taxMinor: 0, sku: SKU }],
      method: "card",
    });
    await run("pos.returnSale", { invoiceId: sale.invoiceId, reason: "customer changed their mind" });
    await expect(
      run("pos.returnSale", { invoiceId: sale.invoiceId, reason: "second return attempt" }),
    ).rejects.toThrow(/nothing left to return/);
  });

  it("returns selected quantities, restores matching stock, and allocates line tax across repeat returns", async () => {
    const before = await onHand();
    const sale = await run("pos.completeSale", {
      sessionId,
      lines: [
        { description: "Taxed widget", quantity: 2000, unitPriceMinor: 1000, taxMinor: 3, sku: SKU },
        { description: "Taxed widget", quantity: 3000, unitPriceMinor: 500, taxMinor: 5, sku: SKU },
      ],
      method: "card",
    });
    expect(sale.totalMinor).toBe(3508);
    expect(await onHand()).toBe(before - 5000);
    const saleLines = await db.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, sale.invoiceId));
    const firstLine = saleLines.find((line) => line.quantity === 2000)!;
    const secondLine = saleLines.find((line) => line.quantity === 3000)!;

    const firstHalf = await run("pos.returnSale", {
      invoiceId: sale.invoiceId,
      reason: "return one taxed unit",
      refundMethod: "card",
      lines: [{ invoiceLineId: firstLine.id, quantity: 1000 }],
    });
    expect(firstHalf).toMatchObject({ refundMinor: 1002, creditedMinor: 1002, restockedLines: 1 });
    expect(await onHand()).toBe(before - 4000);

    const firstRemainder = await run("pos.returnSale", {
      invoiceId: sale.invoiceId,
      reason: "return remaining first unit",
      refundMethod: "card",
      lines: [{ invoiceLineId: firstLine.id, quantity: 1000 }],
    });
    expect(firstRemainder.refundMinor).toBe(1001);
    expect(await onHand()).toBe(before - 3000);

    const secondPart = await run("pos.returnSale", {
      invoiceId: sale.invoiceId,
      reason: "return two of three units",
      refundMethod: "card",
      lines: [{ invoiceLineId: secondLine.id, quantity: 1000 }],
    });
    expect(secondPart.refundMinor).toBe(502);
    expect(await onHand()).toBe(before - 2000);

    const secondRemainder = await run("pos.returnSale", {
      invoiceId: sale.invoiceId,
      reason: "return remaining two units",
      refundMethod: "card",
      lines: [{ invoiceLineId: secondLine.id, quantity: 2000 }],
    });
    expect(secondRemainder.refundMinor).toBe(1003);
    expect(secondRemainder.creditedMinor).toBe(3508);
    expect(await onHand()).toBe(before);
    await expect(run("pos.returnSale", {
      invoiceId: sale.invoiceId,
      reason: "try to return an extra unit",
      lines: [{ invoiceLineId: secondLine.id, quantity: 1000 }],
    })).rejects.toThrow(/nothing left to return/);

    const headers = await db.db.select().from(posReturns).where(eq(posReturns.invoiceId, sale.invoiceId));
    expect(headers.reduce((sum, row) => sum + row.refundMinor, 0)).toBe(3508);
    expect(headers.every((row) => row.refundMethod === "card")).toBe(true);
    const returnIds = headers.map((row) => row.id);
    const returnedLines = await db.db.select().from(posReturnLines).where(and(eq(posReturnLines.orgId, orgId), inArray(posReturnLines.returnId, returnIds)));
    expect(returnedLines.reduce((sum, row) => sum + row.quantity, 0)).toBe(5000);
    expect(returnedLines.reduce((sum, row) => sum + row.subtotalMinor, 0)).toBe(3500);
    expect(returnedLines.reduce((sum, row) => sum + row.taxMinor, 0)).toBe(8);
    const [unbalanced] = await db.db
      .select({ amount: sql<number>`coalesce(sum(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)` })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(eq(journalEntries.orgId, orgId), inArray(journalEntries.id, headers.map((row) => row.entryId))));
    expect(Number(unbalanced?.amount ?? 0)).toBe(0);

    const summary = await run("pos.shiftSummary", { sessionId });
    expect(summary.refundTotals).toEqual(expect.arrayContaining([{ method: "card", amountMinor: 3508 }]));
  });

  it("keeps older stock sales on the safe full-return path when lines are not linked", async () => {
    const before = await onHand();
    const sale = await run("pos.completeSale", {
      sessionId,
      lines: [{ description: SKU, quantity: 1000, unitPriceMinor: 5000, taxMinor: 0, sku: SKU }],
      method: "card",
    });
    await db.db.update(invoiceLines).set({ itemId: null }).where(eq(invoiceLines.invoiceId, sale.invoiceId));
    const [saleLine] = await db.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, sale.invoiceId));
    await expect(run("pos.returnSale", {
      invoiceId: sale.invoiceId,
      reason: "try partial return on an old sale",
      lines: [{ invoiceLineId: saleLine!.id, quantity: 500 }],
    })).rejects.toThrow(/full return option/);

    const returned = await run("pos.returnSale", { invoiceId: sale.invoiceId, reason: "return older sale in full" });
    expect(returned).toMatchObject({ refundMinor: 5000, creditedMinor: 5000, restockedLines: 1 });
    expect(await onHand()).toBe(before);
  });
});
