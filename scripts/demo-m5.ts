/**
 * POS + CRM pipeline verification:
 * open register → cash & card sales → close with variance → flagged;
 * deals → stage moves → weighted forecast.
 *
 * Run: pnpm demo:m5
 */
import { and, eq } from "drizzle-orm";
import { getDb, posSessions, users } from "@chaste/db";
import { formatMinor } from "@chaste/erp-core";
import { buildExecutor, buildRegistry } from "../apps/web/src/server/kernel";
import { runOnboarding } from "../apps/web/src/server/onboarding";

async function main() {
  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  const [user] = await db.insert(users).values({ email: `m5-${Date.now()}@demo.test`, name: "M5 Founder" }).returning();
  if (!user) throw new Error("user insert failed");
  const { orgId } = await runOnboarding(db, {
    userId: user.id,
    userEmail: user.email,
    orgName: "M5 Corner Shop",
    businessDescription: "Corner shop selling coffee and snacks over the counter.",
  });

  const ctx = {
    actor: { type: "human" as const, id: user.id, orgId, permissions: new Set(["*"]) },
    now: new Date(),
    services: {},
  };

  // ── POS ──
  const opened = await executor.execute("pos.openSession", ctx, { openingFloatMinor: 10_000 });
  if (!opened.ok || !opened.data) throw new Error(opened.error);
  const sessionId = (opened.data as { sessionId: string }).sessionId;
  console.log("✓ register opened with $100 float");

  const sale1 = await executor.execute("pos.completeSale", ctx, {
    sessionId,
    method: "cash",
    lines: [
      { description: "Flat white", quantity: 1000, unitPriceMinor: 450 },
      { description: "Croissant", quantity: 2000, unitPriceMinor: 350 },
    ],
  });
  if (!sale1.ok || !sale1.data) throw new Error(sale1.error ?? "cash sale returned no result");
  const cashSale = sale1.data as { invoiceNumber: number; totalMinor: number };
  if (!Number.isSafeInteger(cashSale.invoiceNumber) || cashSale.totalMinor !== 1_150) {
    throw new Error(`unexpected cash sale result: ${JSON.stringify(cashSale)}`);
  }
  console.log(`✓ cash sale #${cashSale.invoiceNumber}: ${formatMinor(cashSale.totalMinor)} → DR Cash / CR Revenue`);

  const sale2 = await executor.execute("pos.completeSale", ctx, {
    sessionId,
    method: "card",
    lines: [{ description: "Coffee beans bag", quantity: 1000, unitPriceMinor: 1800 }],
  });
  if (!sale2.ok || !sale2.data) throw new Error(sale2.error ?? "card sale returned no result");
  const cardSale = sale2.data as { invoiceNumber: number; totalMinor: number };
  if (!Number.isSafeInteger(cardSale.invoiceNumber) || cardSale.totalMinor !== 1_800) {
    throw new Error(`unexpected card sale result: ${JSON.stringify(cardSale)}`);
  }
  console.log("✓ card sale $18.00 posted (drawer untouched)");

  // Close with a $2 short drawer. The card sale must not count as drawer cash.
  const closed = await executor.execute("pos.closeSession", ctx, {
    sessionId,
    countedCashMinor: 10_950,
    varianceReason: "Drawer count was $2 short",
  });
  if (!closed.ok || !closed.data) throw new Error(closed.error ?? "register close returned no result");
  const closeResult = closed.data as { expectedCashMinor: number; varianceMinor: number; flagged: boolean };
  if (closeResult.expectedCashMinor !== 11_150 || closeResult.varianceMinor !== -200 || !closeResult.flagged) {
    throw new Error(`unexpected close result: ${JSON.stringify(closeResult)}`);
  }
  console.log(`✓ closed: expected ${formatMinor(closeResult.expectedCashMinor)}, counted $109.50, variance ${formatMinor(closeResult.varianceMinor)}, flagged: ${closeResult.flagged}`);

  const [row] = await db.select().from(posSessions).where(and(eq(posSessions.id, sessionId), eq(posSessions.orgId, orgId)));
  if (
    !row ||
    row.status !== "closed" ||
    row.countedCashMinor !== 10_950 ||
    row.expectedCashMinor !== 11_150 ||
    row.varianceMinor !== -200 ||
    row.varianceReason !== "Drawer count was $2 short"
  ) {
    throw new Error(`unexpected persisted POS close state: ${JSON.stringify(row)}`);
  }
  console.log("✓ session persisted:", row?.status, `variance=${row?.varianceMinor}`);

  // Second sale against closed session must fail
  const blocked = await executor.execute("pos.completeSale", ctx, {
    sessionId,
    method: "cash",
    lines: [{ description: "x", quantity: 1000, unitPriceMinor: 100 }],
  });
  if (blocked.ok) throw new Error("sale on closed session allowed!");
  console.log("✓ closed-session guard held:", blocked.error);

  // ── CRM pipeline ──
  const d1 = await executor.execute("crm.createDeal", ctx, { title: "Office coffee subscription", valueMinor: 240_000 });
  const d2 = await executor.execute("crm.createDeal", ctx, { title: "Wholesale beans for hotel", valueMinor: 900_000 });
  await executor.execute("crm.moveDealStage", ctx, { dealId: d1.data!.dealId as string, stage: "proposal" });
  await executor.execute("crm.moveDealStage", ctx, { dealId: d2.data!.dealId as string, stage: "negotiation" });
  const pipe = await executor.execute("crm.pipelineReport", ctx, {});
  console.log("✓ pipeline:", JSON.stringify(pipe.data));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
