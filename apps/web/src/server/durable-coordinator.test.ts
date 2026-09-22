import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  approvals,
  agentRuns,
  beginLedgerMaintenance,
  createDb,
  harnessCompositions,
  ledgerEvents,
  memberships,
  organizations,
  rolePermissions,
  roles,
  userRoles,
  users,
  type Database,
} from "@chaste/db";
import { BUILTIN_PROFILES, CAPABILITY_BRIDGE_SERVICE_ID } from "@chaste/harness";
import { decideApproval } from "./approvals";
import { persistHarnessComposition } from "./harness-compositions";
import { getDurableRun } from "./durable-runs";
import { startProfileAwareDurableRun } from "./durable-coordinator";
import { buildExecutor, buildRegistry, type ResolvedUser } from "./kernel";
import { requestHarnessCompositionApproval } from "./harness-approval";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const orgId = crypto.randomUUID();
const otherOrgId = crypto.randomUUID();
let pg: Database;
let db: Database["db"];
let approver: ResolvedUser;

const supportedBundle = {
  id: "chaste-erp",
  version: "1.0.0",
  serviceIds: [CAPABILITY_BRIDGE_SERVICE_ID],
};

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(organizations).values([
    { id: orgId, name: "Coordinator Test Org", slug: `coordinator-${orgId.slice(0, 8)}` },
    { id: otherOrgId, name: "Other Coordinator Org", slug: `coordinator-${otherOrgId.slice(0, 8)}` },
  ]);
  const [user] = await db
    .insert(users)
    .values({ email: `coordinator-${orgId.slice(0, 8)}@example.com`, name: "Coordinator Approver" })
    .returning();
  await db.insert(memberships).values({ orgId, userId: user!.id });
  const [role] = await db
    .insert(roles)
    .values({ orgId, key: "owner", name: "Owner", isSystem: true })
    .returning();
  await db.insert(rolePermissions).values({ roleId: role!.id, permissionKey: "*", orgId });
  await db.insert(userRoles).values({ userId: user!.id, roleId: role!.id, orgId });
  approver = {
    userId: user!.id,
    email: user!.email,
    name: user!.name,
    orgId,
    permissions: new Set(["*"]),
  };
});

afterAll(async () => {
  await db.delete(approvals).where(eq(approvals.orgId, orgId));
  await db.delete(approvals).where(eq(approvals.orgId, otherOrgId));
  await db.delete(agentRuns).where(eq(agentRuns.orgId, orgId));
  await db.delete(harnessCompositions).where(eq(harnessCompositions.orgId, orgId));
  await db.delete(harnessCompositions).where(eq(harnessCompositions.orgId, otherOrgId));
  await beginLedgerMaintenance(db, async (tx) => {
    await tx.delete(ledgerEvents).where(eq(ledgerEvents.orgId, orgId));
    await tx.delete(ledgerEvents).where(eq(ledgerEvents.orgId, otherOrgId));
  });
  await db.delete(userRoles).where(eq(userRoles.orgId, orgId));
  await db.delete(rolePermissions).where(eq(rolePermissions.orgId, orgId));
  await db.delete(roles).where(eq(roles.orgId, orgId));
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(users).where(eq(users.id, approver.userId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(organizations).where(eq(organizations.id, otherOrgId));
  await pg.client.end();
});

async function approveComposition(compositionId: string): Promise<string> {
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const request = await requestHarnessCompositionApproval(
    db,
    executor,
    {
      actor: { type: "agent", id: null, orgId, permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    },
    compositionId,
  );
  const result = await decideApproval(db, executor, registry, approver, {
    approvalId: request.approvalId,
    decision: "approve",
  });
  expect(result).toMatchObject({ ok: true, status: "executed" });
  return request.approvalId;
}

describe("profile-aware durable run coordinator", () => {
  it("resolves the approved profile and starts an execution-ready run", async () => {
    const composition = await persistHarnessComposition(db, {
      orgId,
      profile: BUILTIN_PROFILES["erp-prod"],
      bundles: [supportedBundle],
    });
    const compositionApprovalId = await approveComposition(composition.id);
    const result = await startProfileAwareDurableRun(db, {
      orgId,
      harnessCompositionId: composition.id,
      goal: "Start a supervised durable purchase run with the approved ERP profile",
      actor: { type: "agent", id: crypto.randomUUID() },
      compositionApprovalId,
      expectedProfile: { id: "erp-prod", version: "1.0.0", environment: "erp-prod" },
    });

    try {
      expect(result.runId).toBeTruthy();
      expect(result.harness.runtime.status).toBe("mounted");
      expect(result.harness.bridge.resolve("signals.list").id).toBe("signals.list");
      console.log("PROFILE-AWARE-RUN-OK");
    } finally {
      await result.dispose();
    }
  });

  it("pins the same identity in the runtime, inspection record, and durable run", async () => {
    const composition = await persistHarnessComposition(db, {
      orgId,
      profile: BUILTIN_PROFILES["erp-review"],
      bundles: [supportedBundle],
    });
    const compositionApprovalId = await approveComposition(composition.id);
    const result = await startProfileAwareDurableRun(db, {
      orgId,
      harnessCompositionId: composition.id,
      goal: "Start a review run with an identity that survives later inspection",
      actor: { type: "human", id: crypto.randomUUID() },
      compositionApprovalId,
    });

    try {
      const live = result.harness.runtime.inspect();
      const saved = await getDurableRun(db, orgId, result.runId);
      expect(live.profileDigest).toBe(composition.profileDigest);
      expect(live.compositionDigest).toBe(composition.compositionDigest);
      expect(result.composition.compositionDigest).toBe(composition.compositionDigest);
      expect(saved?.run.harnessCompositionId).toBe(composition.id);
      expect(saved?.run.harnessProfileId).toBe("erp-review");
      expect(saved?.run.harnessCompositionDigest).toBe(composition.compositionDigest);
      console.log("PROFILE-AWARE-IDENTITY-OK");
    } finally {
      await result.dispose();
    }
  });

  it("fails closed before creating a run", async () => {
    const otherComposition = await persistHarnessComposition(db, {
      orgId: otherOrgId,
      profile: BUILTIN_PROFILES["erp-prod"],
      bundles: [supportedBundle],
    });
    const unsupported = await persistHarnessComposition(db, {
      orgId,
      profile: BUILTIN_PROFILES["erp-prod"],
      bundles: [{ id: "untrusted-bundle", version: "1.0.0", serviceIds: ["unknown.service"] }],
    });
    const supported = await persistHarnessComposition(db, {
      orgId,
      profile: BUILTIN_PROFILES["erp-prod"],
      bundles: [supportedBundle],
      patches: [{ id: "coordinator-test", version: "1.0.0", values: { testCase: "supported" } }],
    });
    const unsupportedApprovalId = await approveComposition(unsupported.id);
    const supportedApprovalId = await approveComposition(supported.id);
    const before = await db.select({ id: agentRuns.id }).from(agentRuns).where(eq(agentRuns.orgId, orgId));

    await expect(
      startProfileAwareDurableRun(db, {
        orgId,
        harnessCompositionId: otherComposition.id,
        goal: "Reject a composition owned by another organization before execution",
        actor: { type: "agent", id: null },
        compositionApprovalId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("not found for organization");
    await expect(
      startProfileAwareDurableRun(db, {
        orgId,
        harnessCompositionId: unsupported.id,
        goal: "Reject an unsupported composition before creating a durable run",
        actor: { type: "agent", id: null },
        compositionApprovalId: unsupportedApprovalId,
      }),
    ).rejects.toThrow("no approved bundle resolver");
    await expect(
      startProfileAwareDurableRun(db, {
        orgId,
        harnessCompositionId: supported.id,
        goal: "Reject a profile selector that does not match the approved composition",
        actor: { type: "agent", id: null },
        compositionApprovalId: supportedApprovalId,
        expectedProfile: { id: "erp-review" },
      }),
    ).rejects.toThrow("profile mismatch");

    const after = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.orgId, orgId)));
    expect(after).toHaveLength(before.length);
    console.log("PROFILE-AWARE-FAIL-CLOSED-OK");
  });
});
