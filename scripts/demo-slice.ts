/**
 * M1 vertical slice, driven entirely through the capability pipeline:
 * onboarding → createCustomer → createInvoice → recordPayment (gated by policy)
 * → human approval → execution → trial balance proves the books balance.
 *
 * Run: pnpm demo:slice   (.env + pgvector container must be up)
 */
import { eq } from "drizzle-orm";
import { approvals, getDb, users } from "@chaste/db";
import { formatMinor } from "@chaste/erp-core";
import { buildExecutor, buildRegistry } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

async function main() {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  // A fresh user + org every run
  const email = `slice-${Date.now()}@demo.test`;
  const [domainUser] = await db.insert(users).values({ email, name: "Demo Founder" }).returning();
  if (!domainUser) throw new Error("user insert failed");

  const { orgId } = await runOnboarding(db, {
    userId: domainUser.id,
    userEmail: email,
    orgName: "Glow Works Demo",
    businessDescription:
      "We design and sell handmade lighting fixtures online and to interior designers. Most orders are 10-50 units. Returning wholesale buyers get a 2% discount.",
  });
  console.log("✓ org onboarded:", orgId);

  const ctx = {
    actor: { type: "human" as const, id: domainUser.id, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };

  const agentCtx = { ...ctx, actor: { ...ctx.actor, type: "agent" as const } };

  // 1. Agent creates a customer
  const cust = await executor.execute("crm.createCustomer", agentCtx, { name: "Acme Interiors", email: "ap@acme.test" });
  console.log("✓ agent created customer:", cust.data?.customerId);
  if (!cust.ok || !cust.data) throw new Error(cust.error ?? "customer failed");

  // 2. Agent issues an invoice: 20 lamps @ $120 + $60 tax
  const inv = await executor.execute("accounting.createInvoice", agentCtx, {
    customerId: cust.data.customerId,
    memo: "Order #1042, pendant lamps",
    lines: [{ description: "Pendant lamp", quantity: 20000, unitPriceMinor: 12_000, taxMinor: 6_000 }],
  });
  console.log(`✓ invoice #${inv.data?.invoiceNumber} posted: ${formatMinor(inv.data?.totalMinor ?? 0)} → entry ${inv.data?.entryId?.slice(0, 8)}`);
  if (!inv.ok || !inv.data) throw new Error(inv.error ?? "invoice failed");

  // 3. Agent records a large payment → policy forces human approval
  const pay = await executor.execute("accounting.recordPayment", agentCtx, {
    invoiceNumber: inv.data.invoiceNumber,
    amountMinor: 246_000,
    method: "bank_transfer",
  });
  if (pay.ok) throw new Error("policy breach: agent moved $2,460 without approval!");
  console.log("✓ policy gate held:", pay.pendingApproval?.rationale);
  console.log("  → waiting in Approvals inbox");

  // 4. Human approves; execution proceeds under their authority
  const [pending] = await db.select().from(approvals).where(eq(approvals.orgId, orgId)).limit(1);
  if (!pending) throw new Error("approval row missing");
  const approved = await executor.execute(
    "accounting.recordPayment",
    ctx,
    pending.payload,
    { approvedApprovalId: pending.id },
  );
  console.log("✓ human approved → payment posted, fullyPaid:", approved.data?.fullyPaid);
  if (!approved.ok || !approved.data) throw new Error(approved.error ?? "payment failed");

  // 5. Books must balance
  const tb = await executor.execute("accounting.trialBalance", agentCtx, {});
  console.log("✓ trial balance:");
  for (const line of tb.data?.lines ?? []) {
    if (line.debitMinor || line.creditMinor) {
      console.log(`    ${line.code} ${line.name.padEnd(25)} DR ${formatMinor(line.debitMinor)}  CR ${formatMinor(line.creditMinor)}`);
    }
  }
  console.log("  balanced:", tb.data?.balanced);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
