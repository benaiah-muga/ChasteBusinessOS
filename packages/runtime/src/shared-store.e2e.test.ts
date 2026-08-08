/**
 * ARCH-4 — shared-store E2E. Proves the Postgres-backed stores are durable and
 * process-shared: state minted through one `createRuntime` (the "API" host) is
 * observed by a second, independent `createRuntime` (the "worker" host).
 *
 * Coverage:
 * - Standing rule ("always") minted via runtime A is honored by runtime B.
 * - A timer wake scheduled via runtime A is due in runtime B.
 * - A skill upserted via runtime A is loadable + enabled via runtime B.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createDb, runMigrations, schema, type Db, cleanupTestData } from "@chaste/db";
import { eq } from "drizzle-orm";
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

describe.skipIf(!hasDb)("Runtime shared stores E2E", () => {
  let db: Db;
  let api: Runtime;
  let worker: Runtime;
  let orgId: string;
  let userId: string;
  let sessionId: string;

  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);

    const [org] = await db
      .insert(schema.organizations)
      .values({ name: "Shared Store Org", autonomy: "guarded_auto", region: "local" })
      .returning();
    orgId = org!.id;

    const [user] = await db
      .insert(schema.users)
      .values({
        organizationId: orgId,
        email: "shared-store@test.local",
        displayName: "Shared Store User",
        role: "admin",
      })
      .returning();
    userId = user!.id;
    sessionId = crypto.randomUUID();

    // Two independent hosts over the same Postgres schema.
    api = await createRuntime(cfg, db);
    worker = await createRuntime(cfg, db);
  });

  afterAll(async () => {
    await cleanupTestData(db);
  });

  it("honors a standing rule minted through the API host in the worker host", async () => {
    const approval = await api.inbox.addApproval({
      sessionId,
      organizationId: orgId,
      userId,
      title: "Approve customer creation",
      body: "Create Customer #S-42",
      toolCallId: crypto.randomUUID(),
      data: {
        commandId: "crm.customer.create",
        taskId: null,
        standingTarget: "S-42",
      },
    });
    await api.inbox.resolve(approval.id, "always");

    const decision = await worker.inbox.standingRuleFor({
      sessionId,
      commandId: "crm.customer.create",
      target: "S-42",
    });
    expect(decision).toEqual({
      allowed: true,
      rule: "crm.customer.create → S-42",
      sessionId,
    });

    const rules = await api.inbox.inspectStandingRules();
    expect(rules.byOwner.get(sessionId)?.get("crm.customer.create")?.has("S-42")).toBe(true);
  });

  it("makes a timer wake scheduled through the API host due in the worker host", async () => {
    const fireAt = new Date(Date.now() - 1000);
    const wake = await api.wakes.addTimer(sessionId, fireAt, {
      note: "recheck open quotes",
    });

    const due = await worker.wakes.due();
    expect(due.map((w) => w.id)).toContain(wake.id);
    expect(due.find((w) => w.id === wake.id)?.note).toBe("recheck open quotes");

    // The wake record itself was persisted by the API host.
    const persisted = await db
      .select()
      .from(schema.aiWakes)
      .where(eq(schema.aiWakes.id, wake.id))
      .limit(1);
    expect(persisted.length).toBe(1);
  });

  it("shares a skill upserted through the API host with the worker host", async () => {
    await api.skills.upsert({
      name: "quote-review",
      scope: "organization",
      organizationId: orgId,
      title: "Quote Review",
      summary: "Reviews an open quote before approval.",
      instructions: "Inspect the quote, flag anomalies, then approve or return.",
      files: [],
      enabled: true,
    });

    const fetched = await worker.skills.get("quote-review", { organizationId: orgId });
    expect(fetched?.organizationId).toBe(orgId);
    expect(fetched?.enabled).toBe(true);
    expect(fetched?.instructions).toContain("flag anomalies");

    await worker.skills.setEnabled("quote-review", { organizationId: orgId }, false);
    const disabled = await api.skills.get("quote-review", { organizationId: orgId });
    expect(disabled?.enabled).toBe(false);
  });
});
