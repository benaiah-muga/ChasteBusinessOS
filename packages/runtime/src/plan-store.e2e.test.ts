/**
 * ADR 0014 tranche 10 — durable pending plans E2E over Postgres.
 *
 * Proves the gated-plan handoff is durable and process-shared: a plan submitted
 * through one host (the "API") lands in `harness_plans`, and a second,
 * independent host (the "worker") decides it — minting the durable approval
 * grants and executing the plan's steps under the replayed actor authority.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, schema, type Db, cleanupTestData } from "@chaste/db";
import { createCommandHelpers } from "@chaste/db";
import { createRequestContext, type Actor } from "@chaste/kernel";
import { createHarnessHost, type HarnessHost } from "@chaste/ai-core";
import type { AgentPlan } from "@chaste/ai-core";
import type { AppConfig } from "@chaste/config";
import type { AutonomyLevel } from "@chaste/kernel";
import { createRuntime, type Runtime } from "./index.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const DB_URL = process.env.DATABASE_URL!;

const cfg: AppConfig = {
  region: "local",
  regions: ["local"],
  databaseUrl: DB_URL,
  auth: { sessionTokenSecret: "test-secret", expiresAfterDays: 30 },
  ai: {
    defaultInboxVisibility: "hidden",
    model: "test",
    apiKey: "test",
    baseUrl: "http://localhost",
  },
  allowFullAutonomous: true,
  defaultAutonomy: "guarded_auto" as AutonomyLevel,
} as unknown as AppConfig;

describe.skipIf(!hasDb)("Durable pending plans E2E", () => {
  let db: Db;
  let api: Runtime;
  let worker: Runtime;
  let orgId: string;
  let approverId: string;
  let agentId: string;

  function hostFor(runtime: Runtime): HarnessHost {
    return createHarnessHost({
      commands: runtime.commands,
      queries: runtime.queries,
      helpers: createCommandHelpers({ audit: runtime.audit, outbox: runtime.outbox, db: runtime.db }),
      grants: runtime.approvalGrants,
      inbox: runtime.inbox,
      trajectory: runtime.sessionLog,
      planStore: runtime.planStore,
      now: () => new Date(),
    });
  }

  function agent(): Actor {
    return {
      kind: "ai_assisted",
      userId: agentId,
      organizationId: orgId,
      permissions: new Set(["activities.write"]),
    };
  }

  function plan(): AgentPlan {
    return {
      id: crypto.randomUUID(),
      objective: "Schedule a review activity",
      assumptions: [],
      steps: [
        {
          id: "s1",
          title: "Create review activity",
          command: "activities.create",
          args: { kind: "review", title: "Quarterly review", dueAt: "2026-08-25T09:00:00Z" },
        },
      ],
      requiredApprovals: [
        { commandType: "activities.create", riskClass: "exec", reason: "creates a tracked activity" },
      ],
      risks: [{ level: "high", description: "adds an activity the org tracks" }],
      evidenceNeeded: [],
      stopConditions: [],
    };
  }

  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);

    const [org] = await db
      .insert(schema.organizations)
      .values({ name: "Plan Store Org", autonomy: "guarded_auto", region: "local" })
      .returning();
    orgId = org!.id;

    const [approver] = await db
      .insert(schema.users)
      .values({
        organizationId: orgId,
        email: "plan-approver@test.local",
        displayName: "Plan Approver",
        role: "admin",
      })
      .returning();
    approverId = approver!.id;

    const [agentUser] = await db
      .insert(schema.users)
      .values({
        organizationId: orgId,
        email: "plan-agent@test.local",
        displayName: "Plan Agent",
        role: "member",
      })
      .returning();
    agentId = agentUser!.id;

    api = await createRuntime(cfg, db);
    worker = await createRuntime(cfg, db);
  });

  afterAll(async () => {
    await cleanupTestData(db);
  });

  it("hands a gated plan from the API host to the worker host for decision", async () => {
    const sessionId = crypto.randomUUID();
    const apiHost = hostFor(api);
    const workerHost = hostFor(worker);

    const submitted = await apiHost.submitPlan({
      sessionId,
      organizationId: orgId,
      actor: agent(),
      plan: plan(),
      correlationId: crypto.randomUUID(),
      origin: "agent",
      approverUserId: approverId,
    });
    expect(submitted.status).toBe("pending_approval");
    if (submitted.status !== "pending_approval") return;
    const itemId = submitted.itemId;

    // The pending plan is persisted in the shared table.
    const [row] = await db
      .select()
      .from(schema.harnessPlans)
      .where(eq(schema.harnessPlans.itemId, itemId))
      .limit(1);
    expect(row?.status).toBe("pending");

    // A different host sees it as pending and decides it.
    expect((await workerHost.pendingPlans()).length).toBe(1);
    const decide = await workerHost.decide({
      itemId,
      organizationId: orgId,
      userId: approverId,
      resolution: "approved",
    });
    expect(decide).toMatchObject({ resolved: true, kind: "plan" });
    if (!(decide.resolved && decide.kind === "plan")) return;
    expect(decide.result.ok).toBe(true);

    // The step executed through the bus: the activity exists in Postgres.
    const [activity] = await db
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.organizationId, orgId))
      .limit(1);
    expect(activity?.title).toBe("Quarterly review");

    // The plan entry is tombstoned, and a grant was minted for the actor.
    const [resolved] = await db
      .select()
      .from(schema.harnessPlans)
      .where(eq(schema.harnessPlans.itemId, itemId))
      .limit(1);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedAt).not.toBeNull();
    const [grant] = await db
      .select()
      .from(schema.approvalGrants)
      .where(eq(schema.approvalGrants.organizationId, orgId))
      .limit(1);
    expect(grant?.grantedToUserId).toBe(agentId);

    // Replayed actor authority is intact: the step's actor is the agent.
    const [activityRow] = await db
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.id, activity?.id ?? ""))
      .limit(1);
    expect(activityRow?.createdByUserId).toBe(agentId);
    expect(await workerHost.pendingPlans()).toHaveLength(0);
  });

  it("rejects a gated plan and tombstones it without executing", async () => {
    const apiHost = hostFor(api);
    const workerHost = hostFor(worker);
    const submitted = await apiHost.submitPlan({
      sessionId: crypto.randomUUID(),
      organizationId: orgId,
      actor: agent(),
      plan: plan(),
      correlationId: crypto.randomUUID(),
      origin: "agent",
      approverUserId: approverId,
    });
    expect(submitted.status).toBe("pending_approval");
    if (submitted.status !== "pending_approval") return;

    const decide = await workerHost.decide({
      itemId: submitted.itemId,
      organizationId: orgId,
      userId: approverId,
      resolution: "rejected",
    });
    expect(decide).toMatchObject({ resolved: true, kind: "plan" });
    if (!(decide.resolved && decide.kind === "plan")) return;
    expect(decide.result.ok).toBe(false);

    const [row] = await db
      .select()
      .from(schema.harnessPlans)
      .where(eq(schema.harnessPlans.itemId, submitted.itemId))
      .limit(1);
    expect(row?.status).toBe("resolved");
  });
});
