import { and, eq } from "drizzle-orm";
import {
  actionReceipts,
  agentRunSteps,
  agentRuns,
  approvals,
  getDb,
  jobs,
  organizations,
  policies,
  purgeTenantFinancials,
  purchaseOrders,
  users,
} from "@chaste/db";
import { BUILTIN_PROFILES, CAPABILITY_BRIDGE_SERVICE_ID } from "@chaste/harness";
import {
  recordDurableStep,
  transitionDurableRun,
  transitionDurableStep,
} from "../../apps/web/src/server/durable-runs";
import { persistHarnessComposition } from "../../apps/web/src/server/harness-compositions";
import { startProfileAwareDurableRun } from "../../apps/web/src/server/durable-coordinator";
import { requestHarnessCompositionApproval } from "../../apps/web/src/server/harness-approval";
import { decideApproval } from "../../apps/web/src/server/approvals";
import { buildExecutor, buildRegistry } from "../../apps/web/src/server/kernel";
import {
  claimJob,
  enqueueCapabilityJob,
  processOneJob,
  systemActorFor,
} from "../../apps/web/src/server/jobs";
import { runOnboarding } from "../../apps/web/src/server/onboarding";
import { logger } from "@chaste/kernel";
import { loadRepoEnv } from "./env";

loadRepoEnv();

async function main(): Promise<void> {
  const pg = getDb();
  const db = pg.db;
  let orgId: string | null = null;
  let coordinated: Awaited<ReturnType<typeof startProfileAwareDurableRun>> | null = null;

  try {
    const [owner] = await db
      .insert(users)
      .values({
        email: `durable-${Date.now()}@gate.test`,
        name: "Durable Run Owner",
      })
      .returning();
    if (!owner) throw new Error("owner insert failed");

    const onboarding = await runOnboarding(db, {
      userId: owner.id,
      userEmail: owner.email,
      orgName: "Durable PO Gate",
      businessDescription: "A supervised durable execution proof.",
    });
    orgId = onboarding.orgId;

    const ownerCtx = {
      actor: { type: "human" as const, id: owner.id, orgId, permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    };

    const composition = await persistHarnessComposition(db, {
      orgId,
      profile: BUILTIN_PROFILES["erp-prod"],
      bundles: [{ id: "chaste-erp", version: "1.0.0", serviceIds: [CAPABILITY_BRIDGE_SERVICE_ID] }],
    });
    const approvalRegistry = buildRegistry(db);
    const approvalExecutor = buildExecutor(db, approvalRegistry);
    const compositionApproval = await requestHarnessCompositionApproval(db, approvalExecutor, {
      actor: { type: "agent", id: null, orgId, permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    }, composition.id);
    const approvalDecision = await decideApproval(db, approvalExecutor, approvalRegistry, {
      userId: owner.id,
      email: owner.email,
      name: owner.name,
      orgId,
      permissions: new Set(["*"]),
    }, {
      approvalId: compositionApproval.approvalId,
      decision: "approve",
      comment: "Approved ERP composition for supervised durable pilot",
    });
    if (!approvalDecision.ok || approvalDecision.status !== "executed") {
      throw new Error("harness composition approval did not execute");
    }
    coordinated = await startProfileAwareDurableRun(db, {
      orgId,
      harnessCompositionId: composition.id,
      goal: "Replenish cement stock through a supervised purchase order",
      actor: { type: "agent", id: null },
      compositionApprovalId: compositionApproval.approvalId,
      registryVersion: process.env.REGISTRY_VERSION ?? "1",
      expectedProfile: { id: "erp-prod", version: "1.0.0", environment: "erp-prod" },
    });
    const executor = coordinated.harness.executor;
    const agentCtx = {
      actor: { type: "agent" as const, id: null, orgId, permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    };

    const vendorResult = await executor.execute("purchasing.createVendor", ownerCtx, {
      name: "Durable Wholesale",
    });
    if (!vendorResult.ok || !vendorResult.data?.vendorId) {
      throw new Error(`vendor setup failed: ${vendorResult.error ?? "unknown error"}`);
    }
    const vendorId = vendorResult.data.vendorId;

    await db.insert(policies).values({
      orgId,
      capabilityPattern: "purchasing.*",
      maxRiskAutonomous: "read",
    });

    const payload = {
      vendorId,
      memo: "Durable reorder — supervised approval",
      lines: [
        {
          description: "Cement replenishment",
          quantity: 10_000,
          unitPriceMinor: 25_000,
          sku: "CEM-DURABLE",
        },
      ],
    };
    const runId = coordinated.runId;
    await transitionDurableRun(db, { orgId, runId, status: "running", currentStep: 1 });

    const gated = await executor.execute("purchasing.createPurchaseOrder", agentCtx, payload);
    if (!gated.pendingApproval) throw new Error("purchase order was not approval-gated");
    const [pending] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
      .limit(1);
    if (!pending) throw new Error("approval row was not persisted");
    const approvalId = pending.id;
    await recordDurableStep(db, {
      orgId,
      runId,
      stepIndex: 1,
      capabilityId: "purchasing.createPurchaseOrder",
      input: payload,
      status: "waiting_approval",
      approvalId,
    });
    await transitionDurableRun(db, { orgId, runId, status: "waiting_approval", currentStep: 1 });

    // This is the durable handoff point: the supervised approver has claimed
    // the gate, but the business effect is delegated to the worker.
    await db
      .update(approvals)
      .set({ status: "executing", decidedAt: new Date() })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")));

    const jobId = await enqueueCapabilityJob(db, {
      orgId,
      type: "purchasing.createPurchaseOrder",
      payload,
      runId,
      runStepIndex: 1,
      approvedApprovalId: approvalId,
      createdByActorType: "agent",
    });

    const t0 = new Date("2026-09-19T12:00:00.000Z");
    const abandoned = await claimJob(db, "abandoned-worker", 1_000, t0);
    if (!abandoned || abandoned.id !== jobId) throw new Error("first worker did not claim the durable job");
    await transitionDurableRun(db, { orgId, runId, status: "running", currentStep: 1 });
    await transitionDurableStep(db, {
      orgId,
      runId,
      stepIndex: 1,
      status: "running",
      approvalId,
    });

    const firstAttempt = await executor.execute(
      abandoned.type,
      {
        actor: systemActorFor(orgId, "purchasing.write"),
        intentId: abandoned.id,
        now: t0,
        services: {},
      },
      abandoned.payload,
      { approvedApprovalId: approvalId },
    );
    if (!firstAttempt.ok) throw new Error(`abandoned worker effect failed: ${firstAttempt.error}`);
    // Deliberately skip finalizeJob: this is the crash window after the
    // effect/receipt commit and before the queue acknowledgement.

    const redelivered = await processOneJob(db, logger, {
      workerId: "replacement-worker",
      leaseMs: 1_000,
      now: new Date(t0.getTime() + 2_000),
    });
    if (!redelivered) throw new Error("replacement worker did not reclaim the expired lease");

    await transitionDurableRun(db, { orgId, runId, status: "completed", currentStep: 1 });

    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
    const poRows = await db.select().from(purchaseOrders).where(eq(purchaseOrders.orgId, orgId));
    const receipts = await db.select().from(actionReceipts).where(eq(actionReceipts.orgId, orgId));
    const [step] = await db
      .select()
      .from(agentRunSteps)
      .where(and(eq(agentRunSteps.orgId, orgId), eq(agentRunSteps.runId, runId), eq(agentRunSteps.stepIndex, 1)));
    const [run] = await db.select().from(agentRuns).where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId));

    if (job?.status !== "done") throw new Error(`durable job did not finish: ${job?.status}`);
    if (poRows.length !== 1) throw new Error(`expected one PO, got ${poRows.length}`);
    if (receipts.length !== 1) throw new Error(`expected one action receipt, got ${receipts.length}`);
    if (step?.status !== "committed" || !step.receiptId) throw new Error("step checkpoint was not committed with a receipt");
    if (run?.status !== "completed") throw new Error(`run did not complete: ${run?.status}`);
    if (approval?.status !== "executed") throw new Error(`approval did not settle: ${approval?.status}`);

    console.log("DURABLE-PO-RUN-OK");
  } finally {
    if (coordinated) await coordinated.dispose();
    if (orgId) {
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
