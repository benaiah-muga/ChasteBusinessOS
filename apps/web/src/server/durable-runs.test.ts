import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentRunSteps, agentRuns, createDb, harnessCompositions, organizations, type Database } from "@chaste/db";
import { BUILTIN_PROFILES } from "@chaste/harness";
import {
  createDurableRun,
  getDurableRun,
  recordDurableStep,
  transitionDurableRun,
} from "./durable-runs";
import { persistHarnessComposition } from "./harness-compositions";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const orgId = crypto.randomUUID();
let pg: Database;
let db: Database["db"];

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(organizations).values({
    id: orgId,
    name: "Durable Run Test Org",
    slug: `durable-run-${orgId.slice(0, 8)}`,
  });
});

afterAll(async () => {
  await db.delete(agentRunSteps).where(eq(agentRunSteps.orgId, orgId));
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(harnessCompositions).where(eq(harnessCompositions.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

describe("durable agent runs", () => {
  it("persists the run lifecycle and idempotent version-pinned steps", async () => {
    const composition = await persistHarnessComposition(db, {
      orgId,
      profile: BUILTIN_PROFILES["erp-prod"],
      bundles: [{ id: "erp", version: "1.0.0", serviceIds: ["chaste.capability.bridge"] }],
    });
    const runId = await createDurableRun(db, {
      orgId,
      goal: "Create one approved purchase order for the shortage",
      actor: { type: "agent", id: crypto.randomUUID() },
      registryVersion: "test-registry-1",
      modelRef: "scripted/test-model",
      harnessCompositionId: composition.id,
    });
    await transitionDurableRun(db, { orgId, runId, status: "running" });

    const first = await recordDurableStep(db, {
      orgId,
      runId,
      stepIndex: 0,
      capabilityId: "purchasing.createPurchaseOrder",
      capabilityVersion: "test-registry-1",
      input: { vendorId: "vendor-1", quantity: 5_000 },
      status: "committed",
      output: { poNumber: 42 },
    });
    const retry = await recordDurableStep(db, {
      orgId,
      runId,
      stepIndex: 0,
      capabilityId: "purchasing.createPurchaseOrder",
      capabilityVersion: "test-registry-1",
      input: { quantity: 5_000, vendorId: "vendor-1" },
      status: "committed",
      output: { poNumber: 42 },
    });
    await transitionDurableRun(db, { orgId, runId, status: "completed", currentStep: 1 });

    const saved = await getDurableRun(db, orgId, runId);
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(saved?.run.status).toBe("completed");
    expect(saved?.run.registryVersion).toBe("test-registry-1");
    expect(saved?.run.harnessCompositionId).toBe(composition.id);
    expect(saved?.run.harnessProfileId).toBe("erp-prod");
    expect(saved?.run.harnessProfileVersion).toBe("1.0.0");
    expect(saved?.run.harnessCompositionDigest).toBe(composition.compositionDigest);
    expect(saved?.steps).toHaveLength(1);
    expect(saved?.steps[0]?.output).toEqual({ poNumber: 42 });
    console.log("DURABLE-RUN-CONTRACT-OK");
    console.log("DURABLE-RUN-IDENTITY-OK");
  });

  it("rejects a same-step retry with a changed payload", async () => {
    const runId = await createDurableRun(db, {
      orgId,
      goal: "Reject changed durable input",
      actor: { type: "human", id: crypto.randomUUID() },
    });
    await recordDurableStep(db, {
      orgId,
      runId,
      stepIndex: 0,
      capabilityId: "signals.list",
      input: { module: "inventory" },
      status: "committed",
    });
    await expect(
      recordDurableStep(db, {
        orgId,
        runId,
        stepIndex: 0,
        capabilityId: "signals.list",
        input: { module: "purchasing" },
        status: "committed",
      }),
    ).rejects.toThrow("different input");
  });
});
