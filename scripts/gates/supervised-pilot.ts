import { and, eq } from "drizzle-orm";
import {
  approvals,
  getDb,
  organizations,
  poLines,
  policies,
  purchaseOrders,
  purgeTenantFinancials,
  users,
} from "@chaste/db";
import { buildExecutor, buildRegistry } from "../../apps/web/src/server/kernel";
import { runOnboarding } from "../../apps/web/src/server/onboarding";
import { systemActorFor } from "../../apps/web/src/server/jobs";
import { loadRepoEnv } from "./env";

loadRepoEnv();

type PilotContext = {
  orgId: string;
  ownerId: string;
  ownerCtx: Parameters<ReturnType<typeof buildExecutor>["execute"]>[1];
  agentCtx: Parameters<ReturnType<typeof buildExecutor>["execute"]>[1];
};

async function seedPilot(db: ReturnType<typeof getDb>["db"], label: string): Promise<PilotContext> {
  const [owner] = await db
    .insert(users)
    .values({ email: `pilot-${label}-${Date.now()}@gate.test`, name: `${label} Pilot Owner` })
    .returning();
  if (!owner) throw new Error(`${label}: owner insert failed`);
  const { orgId } = await runOnboarding(db, {
    userId: owner.id,
    userEmail: owner.email,
    orgName: `${label} Pilot Co`,
    businessDescription: "A supervised purchasing pilot.",
  });
  return {
    orgId,
    ownerId: owner.id,
    ownerCtx: {
      actor: { type: "human", id: owner.id, orgId, permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    },
    agentCtx: {
      actor: { type: "agent", id: null, orgId, permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    },
  };
}

async function createVendor(
  executor: ReturnType<typeof buildExecutor>,
  ctx: PilotContext["ownerCtx"],
): Promise<string> {
  const result = await executor.execute("purchasing.createVendor", ctx, { name: "Pilot Wholesale" });
  if (!result.ok || !result.data?.vendorId) throw new Error(`vendor setup failed: ${result.error ?? "unknown"}`);
  return result.data.vendorId;
}

async function main(): Promise<void> {
  const pg = getDb();
  const db = pg.db;
  const orgIds: string[] = [];
  try {
    const human = await seedPilot(db, "human");
    const agent = await seedPilot(db, "agent");
    orgIds.push(human.orgId, agent.orgId);
    const humanExecutor = buildExecutor(db, buildRegistry(db));
    const agentExecutor = buildExecutor(db, buildRegistry(db));
    const humanVendorId = await createVendor(humanExecutor, human.ownerCtx);
    const agentVendorId = await createVendor(agentExecutor, agent.ownerCtx);
    const payload = (vendorId: string) => ({
      vendorId,
      memo: "Pilot replenishment",
      lines: [{ description: "Pilot cement", quantity: 4_000, unitPriceMinor: 22_000, sku: "PILOT-CEM" }],
    });

    const humanResult = await humanExecutor.execute(
      "purchasing.createPurchaseOrder",
      human.ownerCtx,
      payload(humanVendorId),
    );
    if (!humanResult.ok) throw new Error(`human adapter failed: ${humanResult.error}`);

    await db.insert(policies).values({
      orgId: agent.orgId,
      capabilityPattern: "purchasing.*",
      maxRiskAutonomous: "read",
    });
    const agentRequest = await agentExecutor.execute(
      "purchasing.createPurchaseOrder",
      agent.agentCtx,
      payload(agentVendorId),
    );
    if (!agentRequest.pendingApproval) throw new Error("agent adapter bypassed supervision");
    const [pending] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.orgId, agent.orgId), eq(approvals.status, "pending")))
      .limit(1);
    if (!pending) throw new Error("agent approval row missing");
    await db.update(approvals).set({ status: "executing", decidedAt: new Date() }).where(eq(approvals.id, pending.id));
    const agentResult = await agentExecutor.execute(
      "purchasing.createPurchaseOrder",
      {
        actor: systemActorFor(agent.orgId, "purchasing.write"),
        intentId: crypto.randomUUID(),
        now: new Date(),
        services: {},
      },
      pending.payload,
      { approvedApprovalId: pending.id },
    );
    if (!agentResult.ok) throw new Error(`agent adapter failed after approval: ${agentResult.error}`);

    const [humanPo] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.orgId, human.orgId));
    const [agentPo] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.orgId, agent.orgId));
    if (!humanPo || !agentPo) throw new Error("pilot did not create both purchase orders");
    const [humanLine] = await db.select().from(poLines).where(eq(poLines.poId, humanPo.id));
    const [agentLine] = await db.select().from(poLines).where(eq(poLines.poId, agentPo.id));
    if (
      humanPo.status !== agentPo.status ||
      humanLine?.quantity !== agentLine?.quantity ||
      humanLine?.unitPriceMinor !== agentLine?.unitPriceMinor ||
      humanPo.totalMinor !== agentPo.totalMinor
    ) {
      throw new Error("human and agent postconditions diverged");
    }
    console.log("SUPERVISED-PILOT-OK");
  } finally {
    for (const orgId of orgIds) {
      await purgeTenantFinancials(db, orgId);
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    await pg.client.end();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
