/**
 * Proactive processor tests (ADR 0014 tranche 16): condition evaluation and
 * report-body enrichment against a real Postgres (skipped without DATABASE_URL).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, cleanupTestData, runMigrations, schema, type Db } from "@chaste/db";
import { eq } from "drizzle-orm";
import { buildWatchNotificationBody, evaluateWatchCondition } from "./proactive.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const DB_URL = process.env.DATABASE_URL!;

let db: ReturnType<typeof createDb>;
let orgId: string;

describe.skipIf(!hasDb)("proactive condition evaluation", () => {
  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);

    const [org] = await db
      .insert(schema.organizations)
      .values({ name: "Proactive Test", autonomy: "confirm", region: "local" })
      .returning();
    orgId = org!.id;

    const [wh] = await db
      .insert(schema.invWarehouses)
      .values({ organizationId: orgId, code: "MAIN", name: "Main" })
      .returning();
    const [prod] = await db
      .insert(schema.invProducts)
      .values({ organizationId: orgId, sku: "FLOUR50", name: "Wheat Flour 50kg", uom: "bag", reorderLevel: 40 })
      .returning();
    await db.insert(schema.invStockLevels).values({
      organizationId: orgId,
      warehouseId: wh!.id,
      productId: prod!.id,
      quantity: 35,
    });

    const [vendor] = await db
      .insert(schema.purVendors)
      .values({ organizationId: orgId, name: "V" })
      .returning();
    await db.insert(schema.purPurchaseOrders).values({
      organizationId: orgId,
      vendorId: vendor!.id,
      number: "PO-1",
      status: "sent",
      total: "6000000",
    });

    const [customer] = await db
      .insert(schema.businessPartners)
      .values({ organizationId: orgId, type: "company", name: "C", status: "active" })
      .returning();
    await db.insert(schema.accInvoices).values({
      organizationId: orgId,
      customerId: customer!.id,
      number: "INV-1",
      status: "sent",
      currency: "UGX",
      total: "100000",
      issuedAt: new Date(Date.now() - 20 * 86_400_000),
    });
  });

  afterAll(async () => {
    if (db) {
      await cleanupTestData(db);
      await db.$client.end({ timeout: 5 });
    }
  });

  it("evaluates po.total gt", async () => {
    expect(await evaluateWatchCondition(db, orgId, "po.total gt 5000000")).toMatchObject({
      result: true,
    });
    expect(await evaluateWatchCondition(db, orgId, "po.total gt 9000000")).toMatchObject({
      result: false,
    });
  });

  it("evaluates stock.product below", async () => {
    expect(await evaluateWatchCondition(db, orgId, "stock.product.FLOUR50 below 40")).toMatchObject({
      result: true,
    });
    expect(await evaluateWatchCondition(db, orgId, "stock.product.FLOUR50 below 10")).toMatchObject({
      result: false,
    });
  });

  it("evaluates invoice.overdue gt", async () => {
    expect(await evaluateWatchCondition(db, orgId, "invoice.overdue gt 14")).toMatchObject({
      result: true,
    });
    expect(await evaluateWatchCondition(db, orgId, "invoice.overdue gt 60")).toMatchObject({
      result: false,
    });
  });

  it("treats unknown conditions as fire (noted, not blocking)", async () => {
    expect(await evaluateWatchCondition(db, orgId, "payroll not approved")).toMatchObject({
      result: true,
      note: expect.any(String),
    });
  });

  it("enriches stockout intents with a live report", async () => {
    const body = await buildWatchNotificationBody(
      db,
      orgId,
      "which products are at risk of stockout",
    );
    expect(body).toContain("FLOUR50");
    expect(body).toContain("35 in MAIN");
  });

  it("enriches overdue intents with an invoice summary", async () => {
    const body = await buildWatchNotificationBody(db, orgId, "invoices overdue by more than 14 days");
    expect(body).toContain("INV-1");
  });
});
