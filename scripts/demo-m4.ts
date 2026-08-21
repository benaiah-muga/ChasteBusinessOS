/**
 * M2-completion verification: vendor bill → AP posting → gated payment →
 * approval → P&L and balance sheet prove out.
 *
 * Run: pnpm demo:m3
 */
import { and, eq } from "drizzle-orm";
import { approvals, getDb, users } from "@chaste/db";
import { formatMinor } from "@chaste/erp-core";
import { buildExecutor, buildRegistry } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

async function main() {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  const [user] = await db.insert(users).values({ email: `m3-${Date.now()}@demo.test`, name: "M3 Founder" }).returning();
  if (!user) throw new Error("user insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: user.id,
    userEmail: user.email,
    orgName: "M3 Demo Co",
    businessDescription: "Coffee roastery selling beans online.",
  });

  const humanCtx = {
    actor: { type: "human" as const, id: user.id, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
  const agentCtx = { ...humanCtx, actor: { ...humanCtx.actor, type: "agent" as const } };

  // Revenue side
  const cust = await executor.execute("crm.createCustomer", agentCtx, { name: "Cafe Nero" });
  await executor.execute("accounting.createInvoice", agentCtx, {
    customerId: cust.data!.customerId as string,
    lines: [{ description: "Espresso beans 5kg", quantity: 10_000, unitPriceMinor: 9_000, taxMinor: 0 }],
  });
  console.log("✓ sales invoice posted");

  // Cost side: vendor bill for green coffee (COGS account 5000)
  const ven = await executor.execute("purchasing.createVendor", agentCtx, { name: "Green Bean Traders" });
  const bill = await executor.execute("purchasing.createBill", agentCtx, {
    vendorId: ven.data!.vendorId as string,
    vendorRef: "GBT-8841",
    lines: [{ description: "Green coffee 50kg", quantity: 50_000, unitPriceMinor: 3_000, expenseAccountCode: "5000" }],
  });
  console.log(`✓ vendor bill #${bill.data?.billNumber}: ${formatMinor(bill.data!.totalMinor as number)} → DR COGS / CR AP`);

  // Pay it — above threshold → approval required
  const pay = await executor.execute("purchasing.payBill", agentCtx, {
    billNumber: bill.data!.billNumber as number,
    amountMinor: bill.data!.totalMinor as number,
  });
  if (!pay.pendingApproval) throw new Error("payment was not gated!");
  console.log("✓ payment gated:", pay.pendingApproval.rationale);

  const [pending] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
    .limit(1);
  const approved = await executor.execute(
    "purchasing.payBill",
    humanCtx,
    pending!.payload,
    { approvedApprovalId: pending!.id },
  );
  console.log("✓ approved & paid, fullyPaid:", approved.data?.fullyPaid);
  if (!approved.ok || !approved.data) throw new Error(approved.error ?? "pay failed");

  // Reports prove the whole story
  const pnl = await executor.execute("accounting.incomeStatement", humanCtx, {});
  const bs = await executor.execute("accounting.balanceSheet", humanCtx, {});
  console.log(`✓ P&L: revenue ${formatMinor(pnl.data!.revenueMinor as number)}, expenses ${formatMinor(pnl.data!.expenseMinor as number)}, net ${formatMinor(pnl.data!.netIncomeMinor as number)}`);
  console.log(`✓ Balance sheet: assets ${formatMinor(bs.data!.assetsMinor as number)}, L+E+result balanced: ${bs.data!.balanced}`);
  if (!bs.data!.balanced) throw new Error("balance sheet does not balance!");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
