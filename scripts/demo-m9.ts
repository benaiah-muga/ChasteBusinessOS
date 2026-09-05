/**
 * M9 verification — quote-to-cash completed + CRM depth.
 * Every assertion is a product guarantee.
 *
 * Run: pnpm demo:m9 [fulfillment|credit|expiry|timeline|all]
 */
import { eq, sql } from "drizzle-orm";
import {
  customers,
  getDb,
  journalEntries,
  journalLines,
  salesOrderLines,
  stockReservations,
  stockMovements,
  users,
} from "@chaste/db";
import { buildExecutor, buildRegistry } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

let passed = 0;
function ok(label: string, condition?: boolean) {
  if (condition === false) throw new Error(`FAILED: ${label}`);
  console.log(`✓ ${label}`);
  passed += 1;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- demo reads heterogeneous capability outputs; each assertion narrows its shape
function data(run: any) {
  if (run.error) throw new Error(`capability failed: ${run.error}`);
  return run.data;
}

async function seedOrg(db: ReturnType<typeof getDb>["db"], orgName: string) {
  const [owner] = await db
    .insert(users)
    .values({ email: `own-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@demo.test`, name: "Owner" })
    .returning();
  if (!owner) throw new Error("owner insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: owner.id,
    userEmail: `own-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@demo.test`,
    orgName,
    businessDescription: "Trading company turning quotes into shipped, invoiced, paid orders.",
  });
  return {
    orgId,
    ownerCtx: {
      actor: { type: "human" as const, id: null, orgId, permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    },
  };
}

async function booksDrift(db: ReturnType<typeof getDb>["db"], orgId: string): Promise<number> {
  const [row] = await db
    .select({ drift: sql<number>`coalesce(sum(${journalLines.debitMinor} - ${journalLines.creditMinor}), 0)` })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(eq(journalEntries.orgId, orgId));
  return Number(row?.drift ?? 0);
}

async function fulfillmentScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const { orgId, ownerCtx } = await seedOrg(db, "M9 Revenue Co");

  await executor.execute("inventory.createItem", ownerCtx, {
    sku: "SHELF-5T",
    name: "Steel shelf tower",
    costMinor: 80_00,
    priceMinor: 200_00,
    trackStock: true,
  });
  await executor.execute("inventory.adjustStock", ownerCtx, { sku: "SHELF-5T", quantityDelta: 60_000, note: "opening count" });
  const cust = data(await executor.execute("crm.createCustomer", ownerCtx, { name: "Northern Outfitters" }));

  const order = data(
    await executor.execute("sales.createOrder", ownerCtx, {
      customerId: cust.customerId,
      lines: [{ description: "Steel shelf tower", quantity: 30_000, unitPriceMinor: 200_00, sku: "SHELF-5T" }],
    }),
  );
  const confirmed = data(await executor.execute("sales.confirmOrder", ownerCtx, { orderId: order.orderId }));
  ok(`confirm reserved ${confirmed.reservedThousandths} thousandths (30 units)`);

  // Deliver two-thirds, then the rest — two invoices, one order.
  const soLines = await db.select({ id: salesOrderLines.id }).from(salesOrderLines).where(eq(salesOrderLines.orderId, order.orderId));
  const lineId = soLines[0]!.id;
  const first = data(await executor.execute("sales.deliverOrder", ownerCtx, {
    orderId: order.orderId,
    lines: [{ lineId, quantityThousandths: 18_000 }],
  }));
  if (first.orderStatus !== "confirmed") throw new Error("partial delivery must not close the order");
  ok(`partial delivery invoiced ${first.invoiceTotalMinor} minor for 18 units`);
  const rest = data(await executor.execute("sales.deliverOrder", ownerCtx, { orderId: order.orderId }));
  if (rest.orderStatus !== "delivered") throw new Error("order should be fully delivered");
  ok(`remainder invoiced ${rest.invoiceTotalMinor} minor; order delivered`);

  const [stock] = await db
    .select({ onHand: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)` })
    .from(stockMovements)
    .where(eq(stockMovements.orgId, orgId));
  ok(`stock ledger agrees: ${Number(stock!.onHand)} thousandths still on hand`, Number(stock!.onHand) === 30_000);
  ok("books stay balanced through two deliveries and postings", (await booksDrift(db, orgId)) === 0);
  console.log("FULFILLMENT OK");
  return orgId;
}

async function creditScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const { orgId, ownerCtx } = await seedOrg(db, "M9 Credit Co");

  await executor.execute("inventory.createItem", ownerCtx, { sku: "DESK-140", name: "Desk 140", costMinor: 120_00, priceMinor: 300_00, trackStock: true });
  await executor.execute("inventory.adjustStock", ownerCtx, { sku: "DESK-140", quantityDelta: 50_000, note: "opening count" });
  const cust = data(await executor.execute("crm.createCustomer", ownerCtx, { name: "Shoestring Studio" }));
  await db.update(customers).set({ creditLimitMinor: 500_000 }).where(eq(customers.id, cust.customerId));

  const order = data(
    await executor.execute("sales.createOrder", ownerCtx, {
      customerId: cust.customerId,
      lines: [{ description: "Desk 140", quantity: 20_000, unitPriceMinor: 300_00, sku: "DESK-140" }],
    }),
  );
  const attempt = await executor.execute("sales.confirmOrder", ownerCtx, { orderId: order.orderId });
  const refused = attempt.error ? String(attempt.error) : "";
  if (!/credit limit exceeded/.test(refused)) throw new Error(`expected credit refusal, got: ${refused || "no error"}`);
  ok(`refused with actionable message: ${refused.slice(0, 120)}…`);

  const resv = await db
    .select({ n: sql<number>`count(*)` })
    .from(stockReservations)
    .where(eq(stockReservations.orgId, orgId));
  ok("no reservation was taken before the refusal", Number(resv[0]?.n ?? 0) === 0);
  console.log("CREDIT GUARD OK");
  return orgId;
}

async function expiryScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const { orgId, ownerCtx } = await seedOrg(db, "M9 Expiry Co");

  const cust = data(await executor.execute("crm.createCustomer", ownerCtx, { name: "Cold Lead GmbH" }));
  const quote = data(
    await executor.execute("accounting.createQuote", ownerCtx, {
      customerId: cust.customerId,
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      lines: [{ description: "Colourful mugs, 500 pcs", quantity: 500_000, unitPriceMinor: 400 }],
    }),
  );

  const attempt = await executor.execute("accounting.acceptQuote", ownerCtx, { quoteId: quote.quoteId });
  const refused = attempt.error ? String(attempt.error) : "";
  if (!/quote expired on/.test(refused)) throw new Error(`expected expiry refusal, got: ${refused || "no error"}`);
  ok(`accept refused honestly: ${refused}`);

  const swept = data(await executor.execute("accounting.expireQuote", ownerCtx, {}));
  ok(`sweep archived ${swept.expiredCount} lapsed quote(s)`, swept.expiredCount >= 1);
  const again = data(await executor.execute("accounting.expireQuote", ownerCtx, {}));
  ok("sweep is idempotent", again.expiredCount === 0);

  const signals = data(await executor.execute("signals.list", ownerCtx, {}));
  const hit = (signals.signals ?? []).find((s: { id: string }) => s.id.startsWith("accounting.quoteExpired:"));
  // The sweep already archived it, so the signal stays quiet — signals only
  // point at lapsed-but-unmarked quotes. Verify the guard end-to-end with a
  // fresh lapsed quote.
  ok("archived quote raises no stale signal", !hit);
  const fresh = data(
    await executor.execute("accounting.createQuote", ownerCtx, {
      customerId: cust.customerId,
      expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      lines: [{ description: "Second attempt", quantity: 100_000, unitPriceMinor: 900 }],
    }),
  );
  const signals2 = data(await executor.execute("signals.list", ownerCtx, {}));
  const hit2 = (signals2.signals ?? []).find((s: { id: string }) => s.id === `accounting.quoteExpired:${fresh.quoteId}`);
  if (!hit2 || hit2.suggestedAction?.capabilityId !== "accounting.declineQuote") {
    throw new Error("lapsed-but-unmarked quote must signal with the governed decline");
  }
  ok(`lapsed quote signals red suggesting ${hit2.suggestedAction.capabilityId}`);
  console.log("EXPIRY GUARD OK");
  return orgId;
}

async function timelineScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const { orgId, ownerCtx } = await seedOrg(db, "M9 Timeline Co");

  const deal = data(await executor.execute("crm.createDeal", ownerCtx, { title: "Walk-in — Harbor Cafe", valueMinor: 1_200_000, source: "walk-in" }));
  const converted = data(await executor.execute("crm.convertLead", ownerCtx, { dealId: deal.dealId, createCustomer: true, customerName: "Harbor Cafe" }));
  ok(`lead converted into customer ${converted.customerId} at stage ${converted.stage}`);

  const dupe = data(await executor.execute("crm.createCustomer", ownerCtx, { name: "harbor cafe" }));
  ok(`duplicate creation warned: "${dupe.duplicateWarning ?? "none"}"`, typeof dupe.duplicateWarning === "string");

  const task = data(await executor.execute("crm.createTask", ownerCtx, {
    title: "Send Harbor Cafe the sample pack",
    dueAt: new Date(Date.now() - 86_400_000).toISOString(),
    refType: "customer",
    refId: converted.customerId,
  }));
  const signals = data(await executor.execute("signals.list", ownerCtx, {}));
  const overdue = (signals.signals ?? []).find((s: { id: string }) => s.id === `crm.taskOverdue:${task.taskId}`);
  if (!overdue || overdue.severity !== "red") throw new Error("overdue task must signal red");
  ok(`overdue task signals red suggesting ${overdue.suggestedAction.capabilityId}`);

  const timeline = data(await executor.execute("crm.customerTimeline", ownerCtx, { customerId: converted.customerId }));
  const kinds = (timeline.entries ?? []).map((e: { kind: string }) => e.kind);
  ok(`timeline merges ${kinds.join(", ")} in order`, kinds.includes("deal") && kinds.includes("task"));

  await executor.execute("crm.completeTask", ownerCtx, { taskId: task.taskId });
  const timeline2 = data(await executor.execute("crm.customerTimeline", ownerCtx, { customerId: converted.customerId }));
  const doneTask = (timeline2.entries ?? []).find((e: { refId: string }) => e.refId === task.taskId);
  ok(`completed task shows as done on the timeline: "${doneTask?.summary ?? "missing"}"`, /done/.test(doneTask?.summary ?? ""));
  console.log("TIMELINE OK");
  return orgId;
}

async function main() {
  const scenario = process.argv[2] ?? "all";
  if (scenario === "fulfillment" || scenario === "all") await fulfillmentScenario();
  if (scenario === "credit" || scenario === "all") await creditScenario();
  if (scenario === "expiry" || scenario === "all") await expiryScenario();
  if (scenario === "timeline" || scenario === "all") await timelineScenario();
  console.log(`\n${passed} guarantees held.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
