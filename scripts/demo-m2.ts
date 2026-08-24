/**
 * M2 verification: AR aging, destructive period-close gating, closed-period
 * rejection, and the agent posting into internal conversations.
 *
 * Run: pnpm demo:m2
 */
import { and, eq } from "drizzle-orm";
import { approvals, conversations, getDb, messages, users } from "@chaste/db";
import { formatMinor } from "@chaste/erp-core";
import { buildExecutor, buildRegistry } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

async function main() {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  const [user] = await db
    .insert(users)
    .values({ email: `m2-${Date.now()}@demo.test`, name: "M2 Founder" })
    .returning();
  if (!user) throw new Error("user insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: user.id,
    userEmail: user.email,
    orgName: "M2 Demo Co",
    businessDescription: "Small furniture workshop selling direct online.",
  });

  const humanCtx = {
    actor: { type: "human" as const, id: user.id, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
  const agentCtx = { ...humanCtx, actor: { ...humanCtx.actor, type: "agent" as const } };

  // Invoice now → aging current bucket
  const cust = await executor.execute("crm.createCustomer", agentCtx, { name: "Bar & Co" });
  const inv = await executor.execute("accounting.createInvoice", agentCtx, {
    customerId: cust.data!.customerId as string,
    lines: [{ description: "Chair", quantity: 4000, unitPriceMinor: 15_000, taxMinor: 0 }],
  });
  console.log(`✓ invoice #${inv.data?.invoiceNumber}: ${formatMinor(inv.data!.totalMinor as number)}`);

  // Agent posts into a conversation
  const [conv] = await db
    .insert(conversations)
    .values({ orgId, title: "general", createdByUserId: user.id })
    .returning();
  await executor.execute("messaging.sendMessage", agentCtx, {
    conversationId: conv!.id,
    body: "Invoice #1 issued to Bar & Co, follow up on payment next week.",
  });
  const convMsgs = await db.select().from(messages).where(eq(messages.conversationId, conv!.id));
  console.log("✓ agent posted to #general:", JSON.stringify(convMsgs[0]?.body.slice(0, 60)));

  // Aging shows outstanding in current bucket
  const aging = await executor.execute("accounting.arAging", agentCtx, {});
  console.log("✓ aging:", JSON.stringify(aging.data?.buckets));

  // Close last month (destructive → forced approval even for humans)
  const lastMonth = new Date(Date.now() - 45 * 86_400_000);
  const close = await executor.execute("accounting.closePeriod", humanCtx, {
    year: lastMonth.getUTCFullYear(),
    month: lastMonth.getUTCMonth() + 1,
  });
  if (!close.pendingApproval) throw new Error("destructive close was not gated!");
  console.log('✓ close period gated:', close.pendingApproval.rationale);

  const [pending] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
    .limit(1);
  const approved = await executor.execute(
    "accounting.closePeriod",
    humanCtx,
    pending!.payload,
    { approvedApprovalId: pending!.id },
  );
  console.log("✓ approved:", approved.ok);

  // Posting into the closed period must fail
  const oldDate = new Date(lastMonth);
  const blocked = await executor.execute(
    "crm.createCustomer",
    { ...humanCtx, now: oldDate },
    { name: "Should Fail" },
  );
  void blocked; // crm doesn't check periods, use invoice instead:

  const blockedInvoice = await executor.execute(
    "accounting.createInvoice",
    { ...humanCtx, now: oldDate },
    {
      customerId: cust.data!.customerId as string,
      lines: [{ description: "x", quantity: 1000, unitPriceMinor: 100, taxMinor: 0 }],
    },
  );
  if (blockedInvoice.ok) throw new Error("posting into closed period was allowed!");
  console.log("✓ closed-period guard held:", blockedInvoice.error);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
