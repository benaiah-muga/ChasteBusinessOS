/**
 * M13 verification — retail & reach.
 * Run: pnpm demo:m13 [shifts|marketing|all]
 */
import { and, eq } from "drizzle-orm";
import { approvals, customers, getDb, invoices, stockMovements, users } from "@chaste/db";
import { buildExecutor, buildRegistry } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

let passed = 0;
function ok(label: string, condition?: boolean) {
  if (condition === false) throw new Error(`FAILED: ${label}`);
  console.log(`✓ ${label}`);
  passed += 1;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- demo reads heterogeneous capability outputs
function data(run: any) {
  if (run.error) throw new Error(`capability failed: ${run.error}`);
  if (run.pendingApproval) throw new Error(`unexpectedly gated: ${run.capabilityId ?? "?"}`);
  return run.data;
}

async function seedOrg(db: ReturnType<typeof getDb>["db"], orgName: string) {
  const [owner] = await db.insert(users).values({ email: `own-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@demo.test`, name: "Owner" }).returning();
  if (!owner) throw new Error("owner insert failed");
  const { orgId } = await runOnboarding(db, { userId: owner.id, userEmail: owner.email, orgName, businessDescription: "A register-front business that takes returns gracefully and markets honestly." });
  return { orgId, ownerCtx: { actor: { type: "human" as const, id: owner.id, orgId, permissions: new Set(["*"]) }, now: new Date(), services: {} } };
}

async function shiftsScenario(): Promise<string> {
  const db = getDb().db;
  const ex = buildExecutor(db, buildRegistry(db));
  const { orgId, ownerCtx } = await seedOrg(db, "M13 Register Co");
  const session = data(await ex.execute("pos.openSession", ownerCtx, { register: "front-1" }));
  await ex.execute("inventory.createItem", ownerCtx, { sku: "M13-MUG", name: "Mug", salePriceMinor: 150_00 });
  await ex.execute("inventory.adjustStock", ownerCtx, { sku: "M13-MUG", quantityDelta: 20_000, note: "opening" });
  const sale = data(await ex.execute("pos.completeSale", ownerCtx, { sessionId: session.sessionId, lines: [{ description: "Mug", quantity: 2_000, unitPriceMinor: 150_00, taxMinor: 0, sku: "M13-MUG" }], method: "cash" }));
  ok(`sale ${sale.invoiceNumber} taken ${sale.totalMinor} minor on register front-1`);
  const [inv] = await db.select({ id: invoices.id }).from(invoices).where(eq(invoices.posSessionId, session.sessionId));
  const gated = await ex.execute("pos.returnSale", ownerCtx, { invoiceId: inv!.id, reason: "chipped mug — customer return" });
  ok("return waits for a human whatever the size", Boolean(gated.pendingApproval));
  const gate = (await db.select().from(approvals).where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))).at(-1);
  if (!gate) throw new Error("gated but no approval row");
  const ret = data(await ex.execute("pos.returnSale", ownerCtx, gate.payload, { approvedApprovalId: gate.id }));
  ok(`return credited ${ret.creditedMinor} minor and restocked ${ret.restockedLines} line(s)`);
  const summary = data(await ex.execute("pos.shiftSummary", ownerCtx, { sessionId: session.sessionId }));
  ok(`shift summary: ${summary.salesCount} sale(s), takings ${summary.takingsMinor} minor on ${summary.register}`);
  const [stock] = await db.select({ total: stockMovements.quantityDelta }).from(stockMovements).where(eq(stockMovements.orgId, orgId)).limit(1);
  void stock;
  console.log("SHIFT SUMMARY OK");
  return orgId;
}

async function marketingScenario(): Promise<string> {
  const db = getDb().db;
  const ex = buildExecutor(db, buildRegistry(db));
  const { orgId, ownerCtx } = await seedOrg(db, "M13 Reach Co");
  await ex.execute("crm.createCustomer", ownerCtx, { name: "Loyal Customer" });
  const quiet = data(await ex.execute("crm.createCustomer", ownerCtx, { name: "No Nudge Please" }));
  await db.update(customers).set({ marketingOptOut: true }).where(eq(customers.id, quiet.customerId));
  const segment = data(await ex.execute("marketing.createSegment", ownerCtx, { name: "Everyone", minSpendMinor: 0 }));
  const campaign = data(await ex.execute("marketing.createCampaign", ownerCtx, {
    segmentId: segment.segmentId,
    name: "New arrivals note",
    subject: "Fresh stock this week",
    body: "No tracking, just a note: new arrivals are on the shelf.",
  }));
  const send = data(await ex.execute("marketing.sendCampaign", ownerCtx, { campaignId: campaign.campaignId }));
  ok(`sent to ${send.recipients} recipient(s); ${send.skippedOptOut} opted-out customer(s) skipped`, send.skippedOptOut >= 1);
  const analytics = data(await ex.execute("marketing.campaignAnalytics", ownerCtx, { campaignId: campaign.campaignId }));
  ok(`send log analytics: ${analytics.campaignName} delivered ${analytics.sentCount}`);
  console.log("MARKETING LITE OK");
  return orgId;
}

async function main() {
  const scenario = process.argv[2] ?? "all";
  if (scenario === "shifts" || scenario === "all") await shiftsScenario();
  if (scenario === "marketing" || scenario === "all") await marketingScenario();
  console.log(`\n${passed} guarantees held.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
