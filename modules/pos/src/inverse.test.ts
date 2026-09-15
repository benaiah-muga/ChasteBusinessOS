import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  customers,
  invoices,
  items,
  journalEntries,
  organizations,
  posSessions,
  stockMovements,
  type Database,
} from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerPosCapabilities, type ModuleDeps } from "./index";

/**
 * POS inverse round-trip (N12, ADR 0051): completeSale's declared inverse is
 * pos.returnSale, and buildInput against the ACTUAL sale output produces
 * input the return accepts — the return then restores stock, the drawer and
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
    const es = await db.db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.orgId, o.id));
    for (const _e of es) await db.db.delete(journalEntries).where(eq(journalEntries.orgId, o.id));
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

    // The built input must parse against returnSale's schema — a named
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
});
