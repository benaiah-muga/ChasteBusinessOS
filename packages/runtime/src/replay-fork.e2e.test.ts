/**
 * ADR 0014 tranche 13 — durable replay/fork E2E over Postgres.
 *
 * Proves the eval tooling works on the process-shared session log: a
 * trajectory recorded through one runtime replays identically through a
 * second, independently-constructed runtime, and a fork survives a fresh
 * store instance — the exact guarantees build item 14 is for.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, schema, type Db, cleanupTestData } from "@chaste/db";
import type { Actor } from "@chaste/kernel";
import type { AppConfig } from "@chaste/config";
import type { AutonomyLevel } from "@chaste/kernel";
import {
  replaySession,
  assertReplayInvariant,
  forkSession,
  createScenarioContext,
} from "@chaste/ai-core";
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

describe.skipIf(!hasDb)("Durable replay/fork E2E", () => {
  let db: Db;
  let api: Runtime;
  let worker: Runtime;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    db = createDb(DB_URL);
    await runMigrations(DB_URL);
    await cleanupTestData(db);

    const [org] = await db
      .insert(schema.organizations)
      .values({ name: "Replay Fork Org", autonomy: "guarded_auto", region: "local" })
      .returning();
    orgId = org!.id;

    const [user] = await db
      .insert(schema.users)
      .values({
        organizationId: orgId,
        email: "replay-user@test.local",
        displayName: "Replay User",
        role: "admin",
      })
      .returning();
    userId = user!.id;

    api = await createRuntime(cfg, db);
    // A second, independent host — a fresh store instance over the same table.
    worker = await createRuntime(cfg, db);
  }, 60_000);

  afterAll(async () => {
    await cleanupTestData(db);
  });

  it("replays a trajectory recorded on one host identically on another", async () => {
    const sessionId = crypto.randomUUID();
    const ctx = createScenarioContext({ sessionId, organizationId: orgId, log: api.sessionLog });
    await ctx.record("session/start", { channel: "api", userId });
    await ctx.record("context/assembled", {
      bundleId: `bundle-${sessionId}`,
      turn: 1,
      sections: [
        { key: "policy", tier: 0, purpose: "authority", source: "policy", tokenEstimate: 60, visibility: "model" },
      ],
    });
    await ctx.record("model/request", {
      modelRoute: "planning",
      provider: "test",
      model: "test-model",
      systemPromptSections: ["Policy: act within granted permissions."],
      messages: [{ role: "user", content: "Reconcile the ledger for last month" }],
      toolSchemas: [{ name: "accounting_reconcile" }],
      evidenceRefs: [],
      memoryReads: [],
      contextBundleId: `bundle-${sessionId}`,
    });

    // Host A recorded the trajectory; host B (a fresh store instance) replays it.
    const replayed = await replaySession(worker.sessionLog, sessionId);
    expect(replayed.complete).toBe(true);
    expect(replayed.reconstructed.messages[0]?.content).toBe("Reconcile the ledger for last month");
    expect(replayed.reconstructed.modelRoutes).toEqual(["planning"]);
    expect(replayed.reconstructed.toolSchemas).toHaveLength(1);
    expect(() => assertReplayInvariant(replayed)).not.toThrow();
  }, 30_000);

  it("forks a session up to a boundary durably and the fork replays independently", async () => {
    const sessionId = crypto.randomUUID();
    const forkId = crypto.randomUUID();
    const ctx = createScenarioContext({ sessionId, organizationId: orgId, log: api.sessionLog });
    await ctx.record("session/start", { channel: "api", userId });
    await ctx.record("context/assembled", {
      bundleId: `bundle-${sessionId}`,
      turn: 1,
      sections: [{ key: "policy", tier: 0, purpose: "authority", source: "policy", tokenEstimate: 60, visibility: "model" }],
    });
    await ctx.record("model/request", {
      modelRoute: "planning",
      provider: "test",
      model: "test-model",
      systemPromptSections: ["Policy: act within granted permissions."],
      messages: [{ role: "user", content: "Draft the month-end close" }],
      toolSchemas: [{ name: "accounting_month_end" }],
      evidenceRefs: [],
      memoryReads: [],
      contextBundleId: `bundle-${sessionId}`,
    });
    // A decision point is reached; the host forks *before* committing.
    await forkSession(api.sessionLog, sessionId, {
      newSessionId: forkId,
      uptoSeq: 3,
      organizationId: orgId,
      forkedByUserId: userId,
      reason: "red-team: compare behavior before the risky step",
    });

    // The fork is readable and replayable on a completely fresh store instance.
    const forkTrace = await replaySession(worker.sessionLog, forkId);
    expect(forkTrace.complete).toBe(true);
    expect(forkTrace.totalEvents).toBe(5); // 3 copied + session/forked + session/resumed
    const events = await worker.sessionLog.list(forkId);
    expect(events.some((e) => e.type === "session/forked")).toBe(true);
    expect(events.some((e) => e.type === "session/resumed")).toBe(true);

    // The source is untouched.
    const source = await worker.sessionLog.list(sessionId);
    expect(source).toHaveLength(3);
  }, 30_000);
});