import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  CapabilityRegistry,
  DefaultPolicyEngine,
  InMemoryLedger,
  KernelExecutor,
  defineCapability,
  type ActionContext,
} from "@chaste/kernel";
import { createDb, type Database } from "@chaste/db";
import {
  approvals,
  ledgerEvents,
  memberships,
  organizations,
  rolePermissions,
  roles,
  userRoles,
  users,
} from "@chaste/db";
import { decideApproval } from "./approvals";
import { DbApprovalFlow, type ResolvedUser } from "./kernel";

/**
 * Regression tests for the approval decision pipeline. The original
 * implementation read the row, checked `pending`, executed, then updated
 * status afterwards: two concurrent approvers could both pass the check and
 * a gated money capability would fire twice. The pipeline now claims the
 * gate atomically (UPDATE ... WHERE status = 'pending') before executing.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database["db"];
let pg: Database;
let registry: CapabilityRegistry;
const orgId = crypto.randomUUID();
let userId: string;
let resolved: ResolvedUser;

/** Execution counter on the fake gated capability; must never exceed 1 per gate. */
let executions = 0;

beforeAll(async () => {
  pg = createDb(url);
  db = pg.db;
  registry = new CapabilityRegistry();

  await db.insert(organizations).values({
    id: orgId,
    name: "Approvals Test Org",
    slug: `approvals-test-${orgId.slice(0, 8)}`,
  });
  const [user] = await db
    .insert(users)
    .values({ email: `approvals-test-${orgId.slice(0, 8)}@example.com`, name: "Approver" })
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

  const gatedMoney = defineCapability<{ amountMinor: number }, { movedMinor: number }>({
    id: "test.payMoney",
    title: "Test gated payment",
    intent: "Test-only money movement used by the approvals concurrency regression suite",
    module: "test",
    risk: "money",
    permission: "test.pay",
    moneyThresholdMinor: 0,
    moneyAmount: (input) => input.amountMinor,
    input: z.object({ amountMinor: z.number().int().positive() }),
    output: z.object({ movedMinor: z.number() }),
    execute: async (_ctx, input) => {
      // 666 passes validation and the gate, then fails in the outside world:
      // exercises the "execution failed after claim" finalization path.
      if (input.amountMinor === 666) throw new Error("bank declined the payment");
      executions += 1;
      return { movedMinor: input.amountMinor };
    },
  });
  registry.register(gatedMoney);
});

afterEach(async () => {
  // Isolation: some tests intentionally leave pending gates behind.
  await db.delete(approvals).where(eq(approvals.orgId, orgId));
});

afterAll(async () => {
  await db.delete(ledgerEvents).where(eq(ledgerEvents.orgId, orgId));
  await db.delete(approvals).where(eq(approvals.orgId, orgId));
  await db.delete(userRoles).where(eq(userRoles.orgId, orgId));
  await db.delete(rolePermissions).where(eq(rolePermissions.orgId, orgId));
  await db.delete(roles).where(eq(roles.orgId, orgId));
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await pg.client.end();
});

function makeExecutor(): KernelExecutor {
  return new KernelExecutor({
    registry,
    policy: new DefaultPolicyEngine(),
    approvals: new DbApprovalFlow(db, {
      approvalRequested: async () => {},
      ticketFiled: async () => {},
    }),
    ledger: new InMemoryLedger(),
  });
}

/** Agent requests a gated action, producing a pending approval row. */
async function createPendingApproval(amountMinor: number): Promise<string> {
  const executor = makeExecutor();
  const ctx: ActionContext = {
    actor: { type: "agent", id: userId, orgId, permissions: new Set(["test.pay"]) },
    now: new Date(),
    services: {},
  };
  const result = await executor.execute("test.payMoney", ctx, { amountMinor });
  expect(result.pendingApproval).toBeTruthy();
  const [row] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
    .limit(1);
  expect(row?.status).toBe("pending");
  return row!.id;
}

describe("decideApproval", () => {
  it("executes exactly once when two approvers race on the same gate", async () => {
    const approvalId = await createPendingApproval(100);
    executions = 0;
    const executorA = makeExecutor();
    const executorB = makeExecutor();

    const [x, y] = await Promise.all([
      decideApproval(db, executorA, registry, resolved, { approvalId, decision: "approve" }),
      decideApproval(db, executorB, registry, resolved, { approvalId, decision: "approve" }),
    ]);

    const losers = [x, y].filter((r) => !r.ok);
    expect([x, y].filter((r) => r.ok)).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ code: 409 });

    // The whole point of the fix: the gated capability runs once, not twice.
    expect(executions).toBe(1);

    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row!.status).toBe("executed");
  });

  it("approve after reject conflicts instead of resurrecting the gate", async () => {
    const approvalId = await createPendingApproval(101);
    const executor = makeExecutor();

    const reject = await decideApproval(db, executor, registry, resolved, {
      approvalId,
      decision: "reject",
      comment: "no",
    });
    expect(reject).toEqual({ ok: true, status: "rejected" });

    const approve = await decideApproval(db, executor, registry, resolved, {
      approvalId,
      decision: "approve",
    });
    expect(approve).toMatchObject({ ok: false, code: 409 });
  });

  it("double reject returns conflict and keeps the first decision", async () => {
    const approvalId = await createPendingApproval(102);
    const executor = makeExecutor();
    const first = await decideApproval(db, executor, registry, resolved, { approvalId, decision: "reject" });
    const second = await decideApproval(db, executor, registry, resolved, { approvalId, decision: "reject" });
    expect(first).toEqual({ ok: true, status: "rejected" });
    expect(second).toMatchObject({ ok: false, code: 409 });
  });

  it("an approver without the capability's permission is refused and the gate stays pending", async () => {
    const approvalId = await createPendingApproval(103);
    const executor = makeExecutor();
    const outsider: ResolvedUser = { ...resolved, permissions: new Set(["unrelated.permission"]) };

    const result = await decideApproval(db, executor, registry, outsider, {
      approvalId,
      decision: "approve",
    });
    expect(result).toMatchObject({ ok: false, code: 403 });

    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row!.status).toBe("pending");
  });

  it("unknown approval id is 404", async () => {
    const executor = makeExecutor();
    const result = await decideApproval(db, executor, registry, resolved, {
      approvalId: crypto.randomUUID(),
      decision: "approve",
    });
    expect(result).toMatchObject({ ok: false, code: 404 });
  });

  it("a failed execution marks the approval failed instead of executed", async () => {
    const approvalId = await createPendingApproval(666);
    const executor = makeExecutor();
    const result = await decideApproval(db, executor, registry, resolved, {
      approvalId,
      decision: "approve",
    });
    expect(result.ok).toBe(false);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row!.status).toBe("failed");
  });

  it("submit stamps an expiry so gates cannot wait forever", async () => {
    await createPendingApproval(200);
    const [row] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
      .limit(1);
    expect(row!.expiresAt).toBeTruthy();
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it("an expired gate is marked expired and refuses to execute", async () => {
    const approvalId = await createPendingApproval(201);
    // Simulate a gate raised last week.
    await db
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(approvals.id, approvalId));
    executions = 0;
    const executor = makeExecutor();
    const result = await decideApproval(db, executor, registry, resolved, {
      approvalId,
      decision: "approve",
    });
    expect(result).toMatchObject({ ok: false, code: 410 });
    expect(executions).toBe(0);
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row!.status).toBe("expired");
  });

  it("the kernel-side verify refuses an expired gate even with a claimed id", async () => {
    const approvalId = await createPendingApproval(202);
    await db
      .update(approvals)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(approvals.id, approvalId));
    const flow = new DbApprovalFlow(db, {
      approvalRequested: async () => {},
      ticketFiled: async () => {},
    });
    const ctx = { actor: { type: "agent" as const, id: userId, orgId, permissions: new Set(["test.pay"]) }, now: new Date(), services: {} };
    const valid = await flow.verify(
      approvalId,
      { capabilityId: "test.payMoney", riskClass: "money", payload: { amountMinor: 202 }, rationale: "r" },
      ctx,
    );
    expect(valid).toBe(false);
  });
});
