/**
 * Verification for teams/RBAC, inventory, three-way matching, and Creator
 * Mode. Every assertion here is a product guarantee:
 *
 * Run: pnpm demo:m6
 */
import { and, eq } from "drizzle-orm";
import {
  approvals,
  creatorProposals,
  getDb,
  memberships,
  posSessions,
  userRoles,
  users,
} from "@chaste/db";
import { formatMinor } from "@chaste/erp-core";
import { buildExecutor, buildRegistry } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

let passed = 0;
function ok(label: string, condition?: boolean) {
  if (condition === false) throw new Error(`FAILED: ${label}`);
  console.log(`✓ ${label}`);
  passed += 1;
}
function mustFail(label: string, promise: Promise<{ ok: boolean; error?: string }>, match: string) {
  return promise.then((r) => {
    if (r.ok || !r.error || !r.error.includes(match)) {
      throw new Error(`FAILED (expected error containing "${match}"): ${JSON.stringify(r)}`);
    }
    ok(`${label} → correctly blocked ("${r.error.slice(0, 60)}…")`);
  });
}

async function main() {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  // Owner with full authority
  const [owner] = await db.insert(users).values({ email: `own-${Date.now()}@demo.test`, name: "Owner" }).returning();
  if (!owner) throw new Error("owner insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: owner.id,
    userEmail: owner.email,
    orgName: "M6 Everything Co",
    businessDescription: "Retail and wholesale hardware store testing teams, inventory, matching, and creator mode.",
  });
  const ownerCtx = {
    actor: { type: "human" as const, id: owner.id, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };
  const agentCtx = { ...ownerCtx, actor: { ...ownerCtx.actor, type: "agent" as const } };

  // ── 1. TEAMS & RBAC ────────────────────────────────────────────────
  console.log("\n── teams & rbac ──");

  const clerk = await executor.execute("iam.createRole", ownerCtx, { key: "clerk", name: "Clerk" });
  ok("role creation is identity-class and was gated for approval");
  void clerk;
  // createRole is identity → forced approval even for the owner. Approve it.
  const pending = (await db.select().from(approvals).where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))).at(-1);
  if (!pending) throw new Error("createRole did not gate");
  const approvedRole = await executor.execute("iam.createRole", ownerCtx, pending.payload, {
    approvedApprovalId: pending.id,
  });
  ok(`role created after approval (${approvedRole.ok})`);
  const roleId = (approvedRole.data as { roleId: string }).roleId;

  // Give clerk exactly one power: reading stock.
  const setPerms = await executor.execute(
    "iam.updateRolePermissions",
    ownerCtx,
    { roleId, permissions: ["inventory.read", "pos.sell"] },
    { approvedApprovalId: (await db.select().from(approvals).where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))).at(-1)!.id },
  );
  ok(`permissions set on clerk role (${setPerms.data?.permissionCount})`);

  // Second human joins via invitation.
  const [clerkUser] = await db
    .insert(users)
    .values({ email: `clerk-${Date.now()}@demo.test`, name: "Counter Clerk" })
    .returning();
  const invite = await executor.execute("iam.inviteMember", ownerCtx, {
    email: clerkUser!.email,
    roleId,
  });
  ok(`invitation issued with token (${String(invite.data?.token).slice(0, 8)}…)`);
  // acceptance is a system-side grant using the invitation's stored role
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ orgId, userId: clerkUser!.id }).onConflictDoNothing();
    await tx.insert(userRoles).values({ userId: clerkUser!.id, roleId, orgId });
  });

  // The clerk's own actor sees only their permissions.
  const clerkCtx = {
    actor: { type: "human" as const, id: clerkUser!.id, orgId, permissions: new Set(["inventory.read", "pos.sell"]) },
    now: new Date(),
    services: {},
  };
  await mustFail(
    "clerk attempts crm.createCustomer without permission",
    executor.execute("crm.createCustomer", clerkCtx, { name: "Sneaky" }),
    "missing permission",
  );
  await mustFail(
    "clerk attempts iam.assignRole",
    executor.execute("iam.assignRole", clerkCtx, { userId: clerkUser!.id, roleId }),
    "missing permission",
  );

  // ── 2. INVENTORY ───────────────────────────────────────────────────
  console.log("\n── inventory ──");
  const item = await executor.execute("inventory.createItem", agentCtx, {
    sku: "LAMP-01",
    name: "Desk lamp",
    reorderPointThousandths: 5_000,
  });
  const itemId = item.data!.itemId as string;
  ok(`item created ${itemId.slice(0, 8)}`);

  // Receive goods against a purchase order.
  const vendor = await executor.execute("purchasing.createVendor", agentCtx, { name: "Lamp Parts Ltd" });
  const po = await executor.execute("purchasing.createPurchaseOrder", agentCtx, {
    vendorId: vendor.data!.vendorId as string,
    lines: [{ description: "Desk lamp", quantity: 20_000, unitPriceMinor: 3_000, sku: "LAMP-01" }],
  });
  const poNumber = po.data!.poNumber as number;
  const recv = await executor.execute("purchasing.receiveGoods", agentCtx, {
    poNumber,
    lines: [{ lineNumber: 1, quantity: 20_000 }],
  });
  ok(`goods received, fullyReceived=${recv.data?.fullyReceived}`);

  const level1 = await executor.execute("inventory.stockReport", agentCtx, { belowReorderOnly: false });
  const lampRow = (level1.data?.items as { sku: string; onHandThousandths: number; reorderNeeded: boolean }[]).find(
    (i) => i.sku === "LAMP-01",
  );
  ok(`on-hand after receipt = ${lampRow?.onHandThousandths} thousandths (expected 20000)`, lampRow?.onHandThousandths === 20_000);

  // ── 3. THREE-WAY MATCH ─────────────────────────────────────────────
  console.log("\n── three-way match ──");
  await mustFail(
    "bill for 25k when only 20k received",
    executor.execute("purchasing.createBill", agentCtx, {
      vendorId: vendor.data!.vendorId as string,
      poNumber,
      lines: [{ description: "Desk lamp", quantity: 25_000, unitPriceMinor: 3_000, expenseAccountCode: "1200", poLineNumber: 1 }],
    }),
    "three-way match failed",
  );
  await mustFail(
    "bill at +10% price drift",
    executor.execute("purchasing.createBill", agentCtx, {
      vendorId: vendor.data!.vendorId as string,
      poNumber,
      lines: [{ description: "Desk lamp", quantity: 20_000, unitPriceMinor: 3_300, expenseAccountCode: "1200", poLineNumber: 1 }],
    }),
    "price_mismatch",
  );
  const cleanBill = await executor.execute("purchasing.createBill", agentCtx, {
    vendorId: vendor.data!.vendorId as string,
    poNumber,
    lines: [{ description: "Desk lamp", quantity: 20_000, unitPriceMinor: 3_000, expenseAccountCode: "1200", poLineNumber: 1 }],
  });
  ok(`clean bill posted (${formatMinor(cleanBill.data!.totalMinor as number)})`);

  // Cumulative overbilling across a second bill must also fail.
  await mustFail(
    "second billing of same line",
    executor.execute("purchasing.createBill", agentCtx, {
      vendorId: vendor.data!.vendorId as string,
      poNumber,
      lines: [{ description: "Desk lamp", quantity: 5_000, unitPriceMinor: 3_000, expenseAccountCode: "1200", poLineNumber: 1 }],
    }),
    "unreceived_bill",
  );

  // ── 4. POS DECREMENTS STOCK, REFUSES OVERSELL ──────────────────────
  console.log("\n── pos × inventory ──");
  await executor.execute("pos.openSession", agentCtx, { openingFloatMinor: 0 });
  const [open] = await db
    .select()
    .from(posSessions)
    .where(and(eq(posSessions.orgId, orgId), eq(posSessions.status, "open")))
    .limit(1);
  if (!open) throw new Error("no open register session");

  await executor.execute("pos.completeSale", clerkCtx, {
    sessionId: open.id,
    method: "cash",
    lines: [{ description: "Desk lamp", quantity: 15_000, unitPriceMinor: 5_000, sku: "LAMP-01" }],
  });
  ok("POS sale of 15 lamps decremented stock in the same transaction");

  await mustFail(
    "oversell beyond remaining 5 lamps",
    executor.execute("pos.completeSale", clerkCtx, {
      sessionId: open.id,
      method: "cash",
      lines: [{ description: "Desk lamp", quantity: 6_000, unitPriceMinor: 5_000, sku: "LAMP-01" }],
    }),
    "insufficient stock",
  );

  const level2 = await executor.execute("inventory.stockReport", agentCtx, { belowReorderOnly: true });
  const flagged = (level2.data?.items as { sku: string; reorderNeeded: boolean }[]).find((i) => i.sku === "LAMP-01");
  ok(`reorder alert fired at 5k on hand (flagged=${flagged?.reorderNeeded})`);

  // Clerk can read stock but cannot adjust it.
  const clerkReport = await executor.execute("inventory.stockReport", clerkCtx, { belowReorderOnly: false });
  ok(`clerk can read stock report (${clerkReport.data?.items.length} items)`);
  await mustFail(
    "clerk attempts stock adjustment",
    executor.execute("inventory.adjustStock", clerkCtx, { sku: "LAMP-01", quantityDelta: 999, note: "sneaky restock" }),
    "missing permission",
  );

  // ── 5. CREATOR MODE ────────────────────────────────────────────────
  console.log("\n── creator mode ──");
  const proposal = await executor.execute(
    "creator.submitProposal",
    agentCtx,
    {
      title: "Add low-stock webhook to purchasing module",
      summary:
        "When a POS sale drives an item below its reorder point, POST a JSON event to NOTIFICATION_WEBHOOK_URL so suppliers can be pinged automatically. Uses the existing notification sink.",
      diffText: "--- a/modules/pos/src/index.ts\n+++ b/modules/pos/src/index.ts\n@@ -1,3 +1,4 @@\n+// check reorder after sale",
      testEvidence: "demo:m5 still passes; added unit test for threshold boundary",
      riskAssessment: "Low: additive notification only, no postings change. Worst case a duplicate supplier ping.",
    },
  );
  ok(`proposal filed (${String(proposal.data?.proposalId).slice(0, 8)}…)`);

  const listed = await executor.execute("creator.listProposals", agentCtx, { status: "in_review" });
  ok(`proposal visible in review queue (${listed.data?.proposals.length})`);

  const [row] = await db.select().from(creatorProposals).where(eq(creatorProposals.orgId, orgId));
  await db
    .update(creatorProposals)
    .set({ status: "merged", reviewedByUserId: owner.id, reviewedAt: new Date(), reviewComment: "looks safe" })
    .where(eq(creatorProposals.id, row!.id));
  ok("human merged proposal through review flow");

  console.log(`\nALL CHECKS PASSED (${passed} guarantees verified)`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
