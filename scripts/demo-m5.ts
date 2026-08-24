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
  console.log(`✓ cash sale #${sale1.data?.invoiceNumber}: ${formatMinor(sale1.data!.totalMinor as number)} → DR Cash / CR Revenue`);

  await executor.execute("pos.completeSale", ctx, {
    sessionId,
    method: "card",
    lines: [{ description: "Coffee beans bag", quantity: 1000, unitPriceMinor: 1800 }],
  });
  console.log("✓ card sale $18.00 posted (drawer untouched)");

  // Close with a $2 short drawer, must be flagged honestly
  const closed = await executor.execute("pos.closeSession", ctx, { sessionId, countedCashMinor: 12_800 });
  console.log(`✓ closed: expected ${formatMinor(closed.data!.expectedCashMinor as number)}, counted $128.00, variance ${formatMinor(closed.data!.varianceMinor as number)}, flagged: ${closed.data!.flagged}`);
  if (!closed.data!.flagged) throw new Error("variance was not flagged!");

  const [row] = await db.select().from(posSessions).where(and(eq(posSessions.id, sessionId), eq(posSessions.orgId, orgId)));
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
