import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, customers, invoiceLines, invoices, items, organizations, type Database } from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerAnalyticsCapabilities, type AnalyticsDeps } from "./index";

/**
 * Live proof of analytics.explainChange (M12.1): the decomposition over
 * real invoice rows sums exactly and drills to invoice ids.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
let db: Database;
let deps: AnalyticsDeps;
const orgId = crypto.randomUUID();
let ctx: ActionContext;

function makeRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registerAnalyticsCapabilities(registry, deps);
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
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Explain Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
  await db.db.insert(organizations).values({ id: orgId, name: "Explain Probe", slug: `ec-${orgId.slice(0, 8)}` });
  ctx = { actor: { type: "human", id: null, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} };

  const custA = crypto.randomUUID();
  const custB = crypto.randomUUID();
  await db.db.insert(customers).values([
    { id: custA, orgId, name: "Explain Alpha" },
    { id: custB, orgId, name: "Explain Beta" },
  ]);
  const widget = crypto.randomUUID();
  const gadget = crypto.randomUUID();
  await db.db.insert(items).values([
    { id: widget, orgId, sku: "EX-WIDGET", name: "Explain widget", salePriceMinor: 100_00 },
    { id: gadget, orgId, sku: "EX-GADGET", name: "Explain gadget", salePriceMinor: 50_00 },
  ]);

  async function invoice(number: number, customerId: string, day: number, lines: Array<{ itemId: string; qty: number; price: number }>) {
    const issuedAt = new Date(Date.UTC(2026, 0, day));
    const [inv] = await db.db
      .insert(invoices)
      .values({ orgId, customerId, number, status: "sent", subtotalMinor: 0, taxMinor: 0, totalMinor: 0, issuedAt })
      .returning({ id: invoices.id });
    let total = 0;
    for (const l of lines) {
      const amt = Math.round((l.qty * l.price) / 1000);
      total += amt;
      await db.db.insert(invoiceLines).values({ invoiceId: inv!.id, description: "line", quantity: 1_000, unitPriceMinor: l.price });
      void l.itemId; void amt;
    }
    await db.db.update(invoices).set({ subtotalMinor: total, totalMinor: total }).where(eq(invoices.id, inv!.id));
  }
  void widget; void gadget;

  // Prior period (early Jan): Alpha 500, Beta 300.
  await invoice(1, custA, 3, [{ itemId: widget, qty: 1, price: 500_00 }]);
  await invoice(2, custB, 4, [{ itemId: gadget, qty: 1, price: 300_00 }]);
  // Current period (late Jan): Alpha 250 (down 250), Beta 310 (up 10).
  await invoice(3, custA, 25, [{ itemId: widget, qty: 1, price: 250_00 }]);
  await invoice(4, custB, 26, [{ itemId: gadget, qty: 1, price: 310_00 }]);
});

afterAll(async () => {
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Explain Probe"));
  for (const o of orgs) await db.db.delete(organizations).where(eq(organizations.id, o.id));
});

describe("analytics.explainChange (M12.1)", () => {
  it("decomposes the customer delta exactly and drills to invoices", async () => {
    const result = await run("analytics.explainChange", {
      dimension: "customer",
      periodAFrom: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      periodATo: new Date(Date.UTC(2026, 0, 15)).toISOString(),
      periodBFrom: new Date(Date.UTC(2026, 0, 20)).toISOString(),
      periodBTo: new Date(Date.UTC(2026, 1, 15)).toISOString(),
    });
    expect(result.deltaMinor).toBe(-240_00);
    const sum = result.contributions.reduce((s: number, c: { deltaMinor: number }) => s + c.deltaMinor, 0);
    expect(sum).toBe(result.deltaMinor);
    const alpha = result.contributions.find((c: { key: string }) => c.key === "Explain Alpha");
    expect(alpha!.deltaMinor).toBe(-250_00);
    expect(result.drill.length).toBeGreaterThan(0);
    expect(result.drill[0].invoiceIds.length).toBeGreaterThan(0);
  });
});
