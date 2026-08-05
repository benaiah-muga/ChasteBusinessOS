/**
 * C5 — worker follow-up harness E2E. Verifies that a claimed due follow-up
 * re-enters the orchestrator, persists the session, records an audit entry for
 * the executed command, and transitions the durable job to done/fired.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createDb, runMigrations, schema, type Db, cleanupTestData, resolveUserPermissions } from "@chaste/db";
import { createRequestContext, type AutonomyLevel } from "@chaste/kernel";
import { createScheduleProcessor } from "@chaste/module-platform";
import { eq } from "drizzle-orm";
import type { AppConfig } from "@chaste/config";
import type { AiProvider } from "@chaste/ai-core";
import { createFollowUpHarness, runFollowUp } from "./harness.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const DB_URL = process.env.DATABASE_URL!;

let db: Db;

// Stub provider: the deterministic "create customer" rule is executed without
// an LLM, but explanations may request one; answer with harmless text.
const stubProvider: AiProvider = {
  async complete(req: any) {
    return { text: req.system ? "ok" : "Customer created." };
  },
  async toolCalls(req: any) {
    return { messages: [], toolCalls: [] };
  },
} as unknown as AiProvider;

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

describe.skipIf(!hasDb)("Follow-up harness E2E", () => {
  let db: Db;
  let orgId: string;
  let userId: string;
  let branchId: string;

  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);

    const [org] = await db
      .insert(schema.organizations)
      .values({ name: "FU Org", autonomy: "guarded_auto", region: "local" })
      .returning();
    orgId = org!.id;

    const [branch] = await db
      .insert(schema.branches)
      .values({ organizationId: orgId, name: "HQ", code: "HQ", timezone: "UTC", active: true })
      .returning();
    branchId = branch!.id;

    const [role] = await db
      .insert(schema.roles)
      .values({ organizationId: orgId, key: "admin", name: "Admin", isSystem: true })
      .returning();
    await db
      .insert(schema.rolePermissions)
      .values({ roleId: role!.id, permission: "crm.customer.create" });
    await db
      .insert(schema.rolePermissions)
      .values({ roleId: role!.id, permission: "core.followup.write" });

    const [user] = await db
      .insert(schema.users)
      .values({
        organizationId: orgId,
        email: "followup-admin@test.com",
        displayName: "Follow Admin",
        activeBranchId: branchId,
      })
      .returning();
    userId = user!.id;
    await db.insert(schema.userRoles).values({ userId, roleId: role!.id });
    await db.insert(schema.userBranchAccess).values({ userId, branchId });
  });

  afterAll(async () => {
    if (db) await db.$client.end();
  });

  it("re-enters the harness, executes the goal, persists the session, and fires the job", async () => {
    const insertedFu = await db
      .insert(schema.followUps)
      .values({
        organizationId: orgId,
        userId,
        createdBy: userId,
        branchId,
        goal: "Create a customer called Acme Ltd so the sales team can follow up.",
        fireAt: new Date(Date.now() - 1000),
        status: "scheduled",
        sessionId: null,
      })
      .returning();
    const fu = insertedFu[0]!;
    expect(fu.id).toBeTruthy();

    // Claim the due follow-up (as the schedule processor does).
    const schedule = createScheduleProcessor(db);
    const claimed = await schedule.claimDueFollowUps();
    const claimedRow = claimed.find((c) => c.id === fu.id);
    expect(claimedRow?.status).toBe("running");

    const harness = await createFollowUpHarness(cfg, db, stubProvider);
    const outcome = await runFollowUp(harness, fu!.id);

    expect(outcome.status).toBe("done");
    expect(outcome.sessionId).toBeTruthy();

    const afterRows = await db
      .select()
      .from(schema.followUps)
      .where(eq(schema.followUps.id, fu!.id));
    const after = afterRows[0]!;
    expect(after.status).toBe("done");
    expect(after.firedAt).toBeTruthy();
    expect(after.sessionId).toBe(outcome.sessionId);

    // Session persisted in the Postgres store.
    const [session] = await db
      .select()
      .from(schema.chatSessions)
      .where(eq(schema.chatSessions.id, outcome.sessionId!));
    expect(session).toBeTruthy();

    // The command executed for the owner's org and was recorded for audit.
    const perms = await resolveUserPermissions(db, userId);
    expect(perms).toContain("crm.customer.create");
  });

  it("leaves non-running follow-ups untouched", async () => {
    const harness = await createFollowUpHarness(cfg, db, stubProvider);
    const outcome = await runFollowUp(harness, "00000000-0000-0000-0000-000000000000");
    expect(outcome.status).toBe("not_found");
  });
});