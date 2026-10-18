/**
 * M2 verification: AR aging, destructive period-close gating, closed-period
 * rejection, and the agent posting into internal conversations.
 *
 * Run: pnpm demo:m2
 */
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { approvals, conversations, conversationMembers, getDb, messages, users } from "@chaste/db";
import { formatMinor } from "@chaste/erp-core";
import { buildExecutor, buildRegistry, runOnboarding } from "./lib/go-driver";

async function main() {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  const runId = randomUUID();
  const [user] = await db
    .insert(users)
    .values({ email: `m2-${runId}@demo.test`, name: "M2 Founder" })
    .returning();
  if (!user) throw new Error("user insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: user.id,
    userEmail: user.email,
    orgName: `M2 Demo Co ${runId.slice(0, 8)}`,
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
  await db.insert(conversationMembers).values({ conversationId: conv!.id, userId: user.id }).onConflictDoNothing();
  await executor.execute("messaging.sendMessage", agentCtx, {
    conversationId: conv!.id,
    body: "Invoice #1 issued to Bar & Co, follow up on payment next week.",
  });
  const convMsgs = await db.select().from(messages).where(eq(messages.conversationId, conv!.id));
  console.log("✓ agent posted to #general:", JSON.stringify(convMsgs[0]?.body.slice(0, 60)));

  // Aging shows outstanding in current bucket
  const aging = await executor.execute("accounting.arAging", agentCtx, {});
  console.log("✓ aging:", JSON.stringify(aging.data?.buckets));

  // Close the current month. Go posting capabilities always post at server
  // "now" (no historic date inputs), so the closed-period guard is proven by
  // closing the month that now falls into, then posting again. Destructive
  // class: the workmate proposing it waits for human approval; a permitted
  // human in the UI acts under their own authority (ADR 0055), so the gate is
  // proven with an agent actor.
  const period = new Date();
  for (const taskKey of ["review_journal", "review_receivables", "review_payables", "review_tax"] as const) {
    await executor.execute("accounting.updatePeriodCloseCheck", humanCtx, {
      year: period.getUTCFullYear(),
      month: period.getUTCMonth() + 1,
      taskKey,
      completed: true,
      note: "Reviewed in the M2 close workbench proof.",
    });
  }
  const close = await executor.execute("accounting.closePeriod", agentCtx, {
    year: period.getUTCFullYear(),
    month: period.getUTCMonth() + 1,
  });
  if (!close.pendingApproval) throw new Error("destructive close was not gated for the agent!");
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
  const blockedInvoice = await executor.execute(
    "accounting.createInvoice",
    humanCtx,
    {
      customerId: cust.data!.customerId as string,
      lines: [{ description: "x", quantity: 1000, unitPriceMinor: 100, taxMinor: 0 }],
    },
  );
  if (blockedInvoice.ok || !/period \d{4}-\d{2} is closed; post to the current period or reopen it/.test(blockedInvoice.error ?? "")) {
    throw new Error(`closed-period guard must refuse with the period message: ${JSON.stringify(blockedInvoice)}`);
  }
  console.log("✓ closed-period guard held:", blockedInvoice.error);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
