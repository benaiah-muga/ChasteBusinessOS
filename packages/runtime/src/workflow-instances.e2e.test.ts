/**
 * ADR 0014 tranche 9 — durable workflow instances E2E over Postgres.
 *
 * Proves the `workflow_runs` checkpointing is durable and process-shared:
 * - A workflow definition persisted via runtime A (the "API" host) is started
 *   via the `workflow.instance.*` bus surface and lands in `workflow_runs`.
 * - An approval gate parks the instance at `pending_approval`; `advance` from
 *   runtime B (the "worker" host) resumes from the checkpoint and completes it,
 *   without re-running completed steps.
 * - The stored instance context survives across hosts (outputs resolve on resume).
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, schema, type Db, cleanupTestData } from "@chaste/db";
import { createCommandHelpers } from "@chaste/db";
import { executeCommand, executeQuery, createRequestContext } from "@chaste/kernel";
import type { Actor, CommandHelpers, RequestContext } from "@chaste/kernel";
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

const PERMS = [
  "core.workflow.manage",
  "core.workflow.read",
  "workflow.instance.write",
  "workflow.instance.read",
  "activities.write",
];

describe.skipIf(!hasDb)("Durable workflow instances E2E", () => {
  let db: Db;
  let api: Runtime;
  let worker: Runtime;
  let orgId: string;
  let userId: string;

  function actor(): Actor {
    return { kind: "user", userId, organizationId: orgId, permissions: new Set(PERMS) };
  }

  function ctx(runtime: Runtime): RequestContext {
    return createRequestContext({ actor: actor(), requestId: crypto.randomUUID(), origin: "e2e" });
  }

  function helpers(runtime: Runtime): CommandHelpers {
    return createCommandHelpers({ audit: runtime.audit, outbox: runtime.outbox, db: runtime.db });
  }

  async function cmd<T>(runtime: Runtime, name: string, input: unknown): Promise<T> {
    const res = await executeCommand<T>(runtime.commands, name, input, ctx(runtime), helpers(runtime));
    return res.data;
  }

  async function qry<T>(runtime: Runtime, name: string, input: unknown): Promise<T> {
    const res = await executeQuery<T>(runtime.queries, name, input, ctx(runtime));
    return res.data;
  }

  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);

    const [org] = await db
      .insert(schema.organizations)
      .values({ name: "Workflow Instances Org", autonomy: "guarded_auto", region: "local" })
      .returning();
    orgId = org!.id;

    const [user] = await db
      .insert(schema.users)
      .values({
        organizationId: orgId,
        email: "instances-e2e@test.local",
        displayName: "Instances User",
        role: "admin",
      })
      .returning();
    userId = user!.id;

    api = await createRuntime(cfg, db);
    worker = await createRuntime(cfg, db);
  });

  afterAll(async () => {
    await cleanupTestData(db);
  });

  it("runs a persisted workflow to completion and checkpoints each step", async () => {
    const def = await cmd(api, "core.workflow.create", {
      name: "Create reminder",
      trigger: "manual",
      steps: [
        {
          id: "step1",
          type: "command",
          command: "activities.create",
          input: { kind: "follow_up", title: "Follow up on quote", dueAt: "2026-08-20T09:00:00Z" },
        },
      ],
    });
    const workflowId = def.id;

    const started = await cmd(api, "workflow.instance.start", {
      workflowId,
      input: { campaign: "q3" },
    });
    expect(started.instance.status).toBe("completed");
    expect(started.instance.steps).toHaveLength(1);
    expect(started.instance.context.campaign).toBe("q3");

    const id = started.instance.id;
    const row = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, id)).limit(1);
    expect(row).toHaveLength(1);
    expect(row[0]?.status).toBe("completed");
    expect(row[0]?.createdByUserId).toBe(userId);

    // A different host observes the same instance.
    const fromWorker = await qry(worker, "workflow.instance.get", { instanceId: id });
    expect(fromWorker.status).toBe("completed");
    expect(fromWorker.context.campaign).toBe("q3");

    const listed = await qry(worker, "workflow.instance.list", { workflowId });
    expect(listed.items).toHaveLength(1);
  });

  it("parks at an approval gate and resumes across hosts without re-running", async () => {
    const def = await cmd(api, "core.workflow.create", {
      name: "Gated reminder",
      trigger: "manual",
      steps: [
        { id: "gate", type: "approval", description: "Approve reminder" },
        {
          id: "step1",
          type: "command",
          command: "activities.create",
          input: { kind: "review", title: "Review contract", dueAt: "2026-08-21T09:00:00Z" },
        },
      ],
    });
    const workflowId = def.id;

    const started = await cmd(api, "workflow.instance.start", { workflowId });
    expect(started.instance.status).toBe("pending_approval");
    expect(started.run.success).toBe(false);
    const id = started.instance.id;

    const row = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, id)).limit(1);
    expect(row[0]?.status).toBe("pending_approval");

    // Resume from the worker host; the gate is the only step, so no re-runs.
    const advanced = await cmd(worker, "workflow.instance.advance", {
      instanceId: id,
      approvedStepIds: ["gate"],
    });
    expect(advanced.instance.status).toBe("completed");
    expect(advanced.instance.steps.map((s: { stepId: string }) => s.stepId)).toEqual(["gate", "step1"]);
    expect(advanced.instance.context.step1).toBeDefined();

    // Terminated instances cannot be advanced again.
    await expect(
      cmd(worker, "workflow.instance.advance", { instanceId: id }),
    ).rejects.toThrow(/already terminated/i);
  });
});
