/**
 * ADR 0014 tranche 12 — proactive coordinator E2E over Postgres.
 *
 * Proves watch rules and deliveries are durable and process-shared: a rule
 * created on one host (the "API") is honored by a coordinator on an
 * independent host (the "worker"); the delivery lands in `proactive_deliveries`
 * (cross-host dedupe + occurrence cursor), `request_approval` rules surface as
 * `requiredApproval` plans that are never executed, and quiet hours / the daily
 * cap suppress at delivery time while still recording for audit.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, runMigrations, schema, type Db, cleanupTestData } from "@chaste/db";
import { createProactiveCoordinator } from "@chaste/ai-core";
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

describe.skipIf(!hasDb)("Proactive coordinator E2E", () => {
  let db: Db;
  let api: Runtime;
  let worker: Runtime;
  let orgId: string;
  let approverId: string;
  let agentId: string;
  let now: Date;

  function coordinatorFor(runtime: Runtime) {
    return createProactiveCoordinator({
      watchRules: runtime.watchRules,
      wakes: runtime.wakes,
      activities: runtime.activities,
      preferences: runtime.proactivePreferences,
      deliveries: runtime.proactiveDeliveries,
      now: () => now,
    });
  }

  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);
    now = new Date();

    const [org] = await db
      .insert(schema.organizations)
      .values({ name: "Proactive Org", autonomy: "guarded_auto", region: "local" })
      .returning();
    orgId = org!.id;

    const [approver] = await db
      .insert(schema.users)
      .values({ organizationId: orgId, email: "pro-active-approver@test.local", displayName: "A", role: "admin" })
      .returning();
    approverId = approver!.id;

    const [agentUser] = await db
      .insert(schema.users)
      .values({ organizationId: orgId, email: "pro-active-agent@test.local", displayName: "B", role: "member" })
      .returning();
    agentId = agentUser!.id;

    api = await createRuntime(cfg, db);
    worker = await createRuntime(cfg, db);
  });

  afterAll(async () => {
    await cleanupTestData(db);
  });

  it("honors a watch rule created on the API host when the worker host ticks", async () => {
    const hour = String(now.getUTCHours()).padStart(2, "0");
    const created = await api.watchRules.create({
      organizationId: orgId,
      name: "Month-end reconciliation",
      trigger: { kind: "schedule", recurrence: { freq: "daily", at: `${hour}:00` }, timezone: "UTC" },
      action: {
        mode: "request_approval",
        intent: "Prepare the monthly reconciliation report",
        recipients: [approverId],
      },
      createdByUserId: agentId,
      createdAt: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
    });

    // The worker host sees the rule durably.
    expect((await worker.watchRules.listByOrg(orgId)).length).toBe(1);
    expect((await worker.watchRules.get(orgId, created.id))?.name).toBe("Month-end reconciliation");

    const workerCoordinator = coordinatorFor(worker);
    const deliveries = await workerCoordinator.deliverDue(orgId, now);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.requiredApproval).toBe(true);
    expect(deliveries[0]?.suppressed).toBe(false);
    expect(deliveries[0]?.kind).toBe("watch_rule");

    // The delivery is durable and unique across hosts.
    const [row] = await db
      .select()
      .from(schema.proactiveDeliveries)
      .where(eq(schema.proactiveDeliveries.organizationId, orgId))
      .limit(1);
    expect(row?.requiredApproval).toBe(true);
    expect(row?.dedupeKey).toBe(deliveries[0]!.dedupeKey);

    // The authority-safe handoff: a structured plan, never an execution.
    // The occurrence cursor advanced — the next collect surfaces the *next*
    // daily occurrence (a later dedupe key), never the delivered one.
    const next = await workerCoordinator.collect(orgId, now);
    expect(next).toHaveLength(1);
    expect(next[0]!.dedupeKey).not.toBe(deliveries[0]!.dedupeKey);
    const plan = workerCoordinator.buildProactivePlan(next[0]!);
    expect(plan.requiredApproval).toBe(true);
    expect(plan.intent).toBe("Prepare the monthly reconciliation report");
    expect(plan.targetUserIds).toEqual([approverId]);
  });

  it("suppresses during quiet hours and under a zero daily cap, recording for audit", async () => {
    const hour = String(now.getUTCHours()).padStart(2, "0");
    const [quietOrg] = await db
      .insert(schema.organizations)
      .values({ name: "Quiet Hours Org", autonomy: "guarded_auto", region: "local" })
      .returning();
    const quietOrgId = quietOrg!.id;

    await api.watchRules.create({
      organizationId: quietOrgId,
      name: "Quiet-hours check",
      trigger: { kind: "schedule", recurrence: { freq: "daily", at: `${hour}:00` }, timezone: "UTC" },
      action: { mode: "notify", intent: "Notify the owner", recipients: [approverId] },
      createdByUserId: agentId,
      createdAt: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
    });

    const coordinator = coordinatorFor(worker);
    await api.proactivePreferences.set({
      organizationId: quietOrgId,
      quietHours: { start: "00:00", end: "23:59", timezone: "UTC" },
      maxSuggestionsPerDay: 0,
    });

    const quiet = await coordinator.deliverDue(quietOrgId, now);
    expect(quiet).toHaveLength(1);
    expect(quiet[0]?.suppressed).toBe(true);
    expect(quiet[0]?.suppressionReason).toBe("quiet_hours");
    // Still recorded — users can inspect what was held.
    expect(await api.proactiveDeliveries.listByOrg(quietOrgId)).toHaveLength(1);
  });
});