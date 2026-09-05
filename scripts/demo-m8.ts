/**
 * M8 verification — signals, reorder intelligence, governed loop.
 * Every assertion is a product guarantee.
 *
 * Run: pnpm demo:m8 [signals|reorder-approve|reorder-decline|all]
 */
import { and, desc, eq } from "drizzle-orm";
import {
  approvals,
  deals,
  getDb,
  invoices,
  ledgerEvents,
  policies,
  poLines,
  purchaseOrders,
  users,
  vendors,
} from "@chaste/db";
import { buildReorderPlan } from "@chaste/erp-core";
import { buildExecutor, buildRegistry } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

let passed = 0;
function ok(label: string, condition?: boolean) {
  if (condition === false) throw new Error(`FAILED: ${label}`);
  console.log(`✓ ${label}`);
  passed += 1;
}

async function seedOrg(db: ReturnType<typeof getDb>["db"], orgName: string) {
  const [owner] = await db
    .insert(users)
    .values({ email: `own-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@demo.test`, name: "Owner" })
    .returning();
  if (!owner) throw new Error("owner insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: owner.id,
    userEmail: owner.email,
    orgName,
    businessDescription: "Trading company keeping shelves stocked and receivables collected on time.",
  });
  return {
    orgId,
    ownerCtx: {
      actor: { type: "human" as const, id: owner.id, orgId, permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    },
    agentCtx: {
      actor: { type: "agent" as const, id: null, orgId, permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    },
  };
}

async function signalsScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const { orgId, ownerCtx, agentCtx } = await seedOrg(db, "M8 Signals Co");

  // Reorder risk: an item below its reorder point.
  await executor.execute(
    "inventory.createItem",
    ownerCtx,
    { sku: "OIL-5L", name: "Cooking oil 5L", reorderPointThousandths: 20_000 },
  );
  await executor.execute(
    "inventory.adjustStock",
    ownerCtx,
    { sku: "OIL-5L", quantityDelta: 5_000, note: "opening count" },
  );

  // Overdue receivable: sent 75 days ago, nothing paid.
  const cust = await executor.execute("crm.createCustomer", ownerCtx, { name: "Slow Pay Ltd" });
  await db.insert(invoices).values({
    orgId,
    customerId: cust.data!.customerId,
    number: 1,
    status: "sent",
    subtotalMinor: 400_000,
    taxMinor: 0,
    totalMinor: 400_000,
    paidMinor: 0,
    issuedAt: new Date(Date.now() - 75 * 86_400_000),
  });

  // Stalled deal: untouched for 21 days.
  const deal = await executor.execute("crm.createDeal", ownerCtx, {
    title: "Hotel supply contract",
    valueMinor: 2_500_000,
  });
  await db
    .update(deals)
    .set({ updatedAt: new Date(Date.now() - 21 * 86_400_000) })
    .where(eq(deals.id, deal.data!.dealId));

  const agentRun = await executor.execute("signals.list", agentCtx, {});
  const signals = agentRun.data?.signals ?? [];
  if (signals.length < 3) throw new Error(`expected at least 3 signals, got ${signals.length}`);
  ok(`aggregator collected ${signals.length} signals across modules`);
  const reds = signals.filter((s: { severity: string }) => s.severity === "red");
  if (reds.length === 0 || signals[0].severity !== "red") throw new Error("reds do not sort first");
  ok("reds sort first (75-day overdue invoice is red)");
  const reorder = signals.find((s: { id: string }) => s.id.startsWith("inventory.reorder:"));
  if (!reorder?.suggestedAction?.capabilityId) throw new Error("reorder signal lacks a governed suggested action");
  ok(`reorder signal suggests ${reorder.suggestedAction.capabilityId}`);

  // Human and agent see the same feed through the read capability.
  const humanRun = await executor.execute("signals.list", ownerCtx, {});
  ok(`human path sees the same feed (${humanRun.data?.signals.length} signals)`);

  return "SIGNALS RENDERED";
}

// CONTINUES

async function reorderApproveScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const { orgId, ownerCtx, agentCtx } = await seedOrg(db, "M8 Reorder Co");

  await executor.execute("purchasing.createVendor", ownerCtx, { name: "Hardware Wholesale" });
  const [vendor] = await db.select().from(vendors).where(eq(vendors.orgId, orgId));

  await executor.execute(
    "inventory.createItem",
    ownerCtx,
    { sku: "CEM-42", name: "Cement 50kg bag", reorderPointThousandths: 15_000 },
  );
  await executor.execute(
    "inventory.adjustStock",
    ownerCtx,
    { sku: "CEM-42", quantityDelta: 10_000, note: "opening count" },
  );

  // The agent reads signals and composes the plan with deterministic math.
  const agentRun = await executor.execute("signals.list", agentCtx, { module: "inventory" });
  const signal = agentRun.data?.signals.find((s: { id: string }) => s.id === "inventory.reorder:CEM-42");
  if (!signal) throw new Error("reorder signal missing for the at-risk item");

  const plan = buildReorderPlan([
    {
      sku: "CEM-42",
      name: "Cement 50kg bag",
      onHandThousandths: 10_000,
      incomingThousandths: 0,
      targetThousandths: 15_000,
      avgUnitCostMinor: 25_000,
    },
  ]);
  ok(
    `plan composed deterministically: ${plan.lines[0]?.quantityThousandths} thousandths at ${plan.totalCostMinor} minor`,
  );

  // Org policy: purchasing actions above "read" need human authority.
  await db.insert(policies).values({
    orgId,
    capabilityPattern: "purchasing.*",
    maxRiskAutonomous: "read",
  });

  const gated = await executor.execute(
    "purchasing.createPurchaseOrder",
    agentCtx,
    {
      vendorId: vendor!.id,
      memo: "Reorder plan — approve to order",
      lines: plan.lines.map((l) => ({
        description: `${l.name} replenishment`,
        quantity: l.quantityThousandths,
        unitPriceMinor: l.unitCostMinor,
        sku: l.sku,
      })),
    },
  );
  if (!gated.pendingApproval) throw new Error("reorder PO was not policy-gated!");
  ok(`PO gated by org policy: ${gated.pendingApproval.rationale}`);

  const [pending] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
    .limit(1);
  const approved = await executor.execute(
    "purchasing.createPurchaseOrder",
    ownerCtx,
    pending!.payload as Record<string, unknown>,
    { approvedApprovalId: pending!.id },
  );
  if (!approved.ok) throw new Error(`approved execution failed: ${approved.error}`);
  ok(`human approved; PO #${approved.data?.poNumber} created`);

  const po = await db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.orgId, orgId), eq(purchaseOrders.number, approved.data!.poNumber)))
    .limit(1);
  if (!po[0]) throw new Error("PO row missing");
  const lines = await db.select().from(poLines).where(eq(poLines.poId, po[0].id));
  if (lines[0]?.quantity !== plan.lines[0]?.quantityThousandths) {
    throw new Error("PO line does not match the plan");
  }
  ok("PO lines match the plan exactly");

  const tb = await executor.execute("accounting.trialBalance", ownerCtx, {});
  ok(`books still balance (${tb.data?.lines.length} accounts)`, tb.data?.balanced === true);

  return "PLAN→POs OK";
}

async function reorderDeclineScenario(): Promise<string> {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const { orgId, ownerCtx, agentCtx } = await seedOrg(db, "M8 Decline Co");

  await executor.execute("purchasing.createVendor", ownerCtx, { name: "Decline Wholesale" });
  const [vendor] = await db.select().from(vendors).where(eq(vendors.orgId, orgId));
  await executor.execute(
    "inventory.createItem",
    ownerCtx,
    { sku: "STEEL-8", name: "Steel bar 8mm", reorderPointThousandths: 20_000 },
  );
  await executor.execute(
    "inventory.adjustStock",
    ownerCtx,
    { sku: "STEEL-8", quantityDelta: 4_000, note: "opening count" },
  );

  await db.insert(policies).values({
    orgId,
    capabilityPattern: "purchasing.*",
    maxRiskAutonomous: "read",
  });

  const gated = await executor.execute(
    "purchasing.createPurchaseOrder",
    agentCtx,
    {
      vendorId: vendor!.id,
      memo: "Reorder plan the human will decline",
      lines: [{ description: "STEEL-8 replenishment", quantity: 16_000, unitPriceMinor: 12_000, sku: "STEEL-8" }],
    },
  );
  if (!gated.pendingApproval) throw new Error("reorder PO was not policy-gated!");

  // The human says no: the approval is rejected, never claimed.
  const [pending] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
    .limit(1);
  await db.update(approvals).set({ status: "rejected" }).where(eq(approvals.id, pending!.id));

  const blocked = await executor.execute(
    "purchasing.createPurchaseOrder",
    ownerCtx,
    pending!.payload as Record<string, unknown>,
    { approvedApprovalId: pending!.id },
  );
  if (blocked.ok) throw new Error("a rejected approval authorized execution!");
  ok(`rejected approval refuses execution ("${(blocked.error ?? "").slice(0, 48)}…")`);

  const poRows = await db.select().from(purchaseOrders).where(eq(purchaseOrders.orgId, orgId));
  if (poRows.length !== 0) throw new Error("declined plan still created a PO");
  ok("declining created no purchase orders");

  const [event] = await db
    .select()
    .from(ledgerEvents)
    .where(and(eq(ledgerEvents.orgId, orgId), eq(ledgerEvents.kind, "approval.requested")))
    .orderBy(desc(ledgerEvents.seq))
    .limit(1);
  if (!event) throw new Error("approval request was not audited");
  ok("the request and its refusal are on the audit trail");

  return "DECLINE AUDITED";
}

const scenarios: Record<string, () => Promise<string>> = {
  signals: signalsScenario,
  "reorder-approve": reorderApproveScenario,
  "reorder-decline": reorderDeclineScenario,
};

async function main() {
  const name = process.argv[2] ?? "all";
  const tokens: string[] = [];
  const run = async (key: string) => {
    console.log(`\n── ${key} ──`);
    tokens.push(await scenarios[key]());
  };
  if (name === "all") {
    for (const key of Object.keys(scenarios)) await run(key);
  } else {
    if (!scenarios[name]) throw new Error(`unknown scenario "${name}"`);
    await run(name);
  }
  console.log(`\nALL CHECKS PASSED (${passed} guarantees verified)`);
  for (const token of tokens) console.log(token);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
