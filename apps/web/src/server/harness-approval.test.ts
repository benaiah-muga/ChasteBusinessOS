import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  approvals,
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
import { buildExecutor, buildRegistry, type ResolvedUser } from "./kernel";
import { persistHarnessComposition } from "./harness-compositions";
import {
  assertHarnessCompositionApproved,
  requestHarnessCompositionApproval,
} from "./harness-approval";

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";
const orgId = crypto.randomUUID();
let pg: Database;
let db: Database["db"];
let userId: string;
let resolved: ResolvedUser;

const supportedBundle = {
  id: "chaste-erp",
  version: "1.0.0",
  serviceIds: [CAPABILITY_BRIDGE_SERVICE_ID],
};

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  await db.insert(organizations).values({
    id: orgId,
    name: "Harness Approval Test Org",
    slug: `harness-approval-${orgId.slice(0, 8)}`,
  });
  const [user] = await db
    .insert(users)
    .values({ email: `harness-approval-${orgId.slice(0, 8)}@example.com`, name: "Harness Approver" })
    .returning();
  userId = user!.id;
  await db.insert(memberships).values({ orgId, userId });
  const [role] = await db
    .insert(roles)
    .values({ orgId, key: "owner", name: "Owner", isSystem: true })
    .returning();
  await db.insert(rolePermissions).values({ roleId: role!.id, permissionKey: "*", orgId });
  await db.insert(userRoles).values({ userId, roleId: role!.id, orgId });
  resolved = {
    userId,
    email: user!.email,
    name: user!.name,
    orgId,
    permissions: new Set(["*"]),
  };
});

afterAll(async () => {
  await db.delete(approvals).where(eq(approvals.orgId, orgId));
  await db.delete(harnessCompositions).where(eq(harnessCompositions.orgId, orgId));
  await beginLedgerMaintenance(db, (tx) => tx.delete(ledgerEvents).where(eq(ledgerEvents.orgId, orgId)));
  await db.delete(userRoles).where(eq(userRoles.orgId, orgId));
  await db.delete(rolePermissions).where(eq(rolePermissions.orgId, orgId));
  await db.delete(roles).where(eq(roles.orgId, orgId));
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

describe("harness composition approvals", () => {
  it("requests idempotently through the existing approval flow", async () => {
    const composition = await persistHarnessComposition(db, {
      orgId,
      profile: BUILTIN_PROFILES["erp-prod"],
      bundles: [supportedBundle],
    });
    const registry = buildRegistry(db);
    const executor = buildExecutor(db, registry);
    const ctx = {
      actor: { type: "agent" as const, id: null, orgId, permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    };

    const first = await requestHarnessCompositionApproval(db, executor, ctx, composition.id);
    const second = await requestHarnessCompositionApproval(db, executor, ctx, composition.id);

    expect(first).toMatchObject({ approvalId: expect.any(String), status: "pending", compositionDigest: composition.compositionDigest });
    expect(second).toEqual(first);
    const rows = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.orgId, orgId), eq(approvals.capabilityId, "harness.approveComposition")));
    expect(rows).toHaveLength(1);
    console.log("HARNESS-APPROVAL-REQUEST-OK");
  });

  it("uses the existing decision path and fails closed on rejected or mismatched identity", async () => {
    const composition = await persistHarnessComposition(db, {
      orgId,
      profile: BUILTIN_PROFILES["erp-review"],
      bundles: [supportedBundle],
    });
    const registry = buildRegistry(db);
    const executor = buildExecutor(db, registry);
    const ctx = {
      actor: { type: "agent" as const, id: null, orgId, permissions: new Set(["*"]) },
      now: new Date(),
      services: {},
    };

    const rejected = await requestHarnessCompositionApproval(db, executor, ctx, composition.id);
    const rejection = await decideApproval(db, executor, registry, resolved, {
      approvalId: rejected.approvalId,
      decision: "reject",
      comment: "composition needs review",
    });
    expect(rejection).toMatchObject({ ok: true, status: "rejected" });
    await expect(
      assertHarnessCompositionApproved(db, orgId, composition.id, composition.compositionDigest, rejected.approvalId),
    ).rejects.toThrow("not approved");

    const approved = await requestHarnessCompositionApproval(db, executor, ctx, composition.id);
    expect(approved.approvalId).not.toBe(rejected.approvalId);
    const decision = await decideApproval(db, executor, registry, resolved, {
      approvalId: approved.approvalId,
      decision: "approve",
      comment: "approved for supervised review",
    });
    expect(decision).toMatchObject({ ok: true, status: "executed" });
    await expect(
      assertHarnessCompositionApproved(db, orgId, composition.id, composition.compositionDigest, approved.approvalId),
    ).resolves.toMatchObject({ id: approved.approvalId, status: "executed" });
    await expect(
      assertHarnessCompositionApproved(db, orgId, composition.id, "0".repeat(64), approved.approvalId),
    ).rejects.toThrow("not approved");
    await expect(
      assertHarnessCompositionApproved(db, orgId, composition.id, composition.compositionDigest, rejected.approvalId),
    ).rejects.toThrow("not approved");
    console.log("HARNESS-APPROVAL-DECISION-OK");
    console.log("HARNESS-APPROVAL-FAIL-CLOSED-OK");
  });
});
