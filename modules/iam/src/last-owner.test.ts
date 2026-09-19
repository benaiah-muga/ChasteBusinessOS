import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accounts,
  createDb,
  memberships,
  organizations,
  roles,
  userRoles,
  users,
  type Database,
} from "@chaste/db";
import { purgeTenantFinancials } from "@chaste/db";
import { CapabilityRegistry, type ActionContext } from "@chaste/kernel";
import { registerIamCapabilities, type ModuleDeps } from "./index";

/**
 * I1 (N07): role reassignment can never strand the organization without an
 * owner. The last owner refuses any lesser reassignment; once a second
 * owner exists, demotion proceeds.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
let deps: ModuleDeps;
const orgId = crypto.randomUUID();
const ownerUserId = crypto.randomUUID();
const secondUserId = crypto.randomUUID();
let ownerRoleId: string;
let memberRoleId: string;

function ctxFor(userId: string): ActionContext {
  return {
    actor: { type: "human", id: userId, orgId, permissions: new Set(["*"]) },
    now: new Date("2026-09-16T00:00:00.000Z"),
    services: {},
  };
}

async function run<I>(id: string, ctx: ActionContext, input: I): Promise<unknown> {
  const registry = new CapabilityRegistry();
  registerIamCapabilities(registry, deps);
  const cap = registry.get(id);
  if (!cap) throw new Error(`missing capability ${id}`);
  return cap.execute(ctx, input);
}

beforeAll(async () => {
  db = createDb(url);
  deps = { db: db.db };
  await db.db.insert(organizations).values({ id: orgId, name: "IAM Owner Probe", slug: `iam-own-${orgId.slice(0, 8)}` });
  await db.db.insert(users).values([
    { id: ownerUserId, email: "owner@iam.test", name: "Owner" },
    { id: secondUserId, email: "second@iam.test", name: "Second" },
  ]);
  const roleRows = await db.db
    .insert(roles)
    .values([
      { orgId, key: "owner", name: "Owner", isSystem: true },
      { orgId, key: "member", name: "Member", isSystem: true },
    ])
    .returning({ id: roles.id, key: roles.key });
  ownerRoleId = roleRows.find((r) => r.key === "owner")!.id;
  memberRoleId = roleRows.find((r) => r.key === "member")!.id;
  await db.db.insert(memberships).values([
    { orgId, userId: ownerUserId },
    { orgId, userId: secondUserId },
  ]);
  await db.db.insert(userRoles).values({ orgId, userId: ownerUserId, roleId: ownerRoleId });
  await db.db.insert(accounts).values({ orgId, code: "1000", name: "Cash", type: "asset" });
});

afterAll(async () => {
  await purgeTenantFinancials(db.db, orgId);
  await db.db.delete(userRoles).where(eq(userRoles.orgId, orgId));
  await db.db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.db.delete(roles).where(eq(roles.orgId, orgId));
  await db.db.delete(users).where(eq(users.id, ownerUserId));
  await db.db.delete(users).where(eq(users.id, secondUserId));
  await db.db.delete(accounts).where(eq(accounts.orgId, orgId));
  await db.db.delete(organizations).where(eq(organizations.id, orgId));
  await db.client.end();
});

describe("iam.assignRole last-owner protection (N07)", () => {
  it("refuses to demote the last owner", async () => {
    await expect(
      run("iam.assignRole", ctxFor(ownerUserId), { userId: ownerUserId, roleId: memberRoleId }),
    ).rejects.toThrow(/last owner/);
    const grants = await db.db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.userId, ownerUserId), eq(userRoles.orgId, orgId)));
    expect(grants).toHaveLength(1);
    expect(grants[0]!.roleId).toBe(ownerRoleId);
  });

  it("allows demotion once a second owner exists", async () => {
    await run("iam.assignRole", ctxFor(ownerUserId), { userId: secondUserId, roleId: ownerRoleId });
    await run("iam.assignRole", ctxFor(ownerUserId), { userId: ownerUserId, roleId: memberRoleId });
    const owners = await db.db
      .select()
      .from(userRoles)
      .where(and(eq(userRoles.orgId, orgId), eq(userRoles.roleId, ownerRoleId)));
    expect(owners.map((r) => r.userId)).toEqual([secondUserId]);
  });

  it("two concurrent demotions of the last two owners leave exactly one owner standing", async () => {
    // whichever order the two removals serialize in - naturally sequential
    // or overlapping on the owner-grant locks - the loser must recount
    // against the winner's commit and refuse, never strand the org.
    await run("iam.assignRole", ctxFor(secondUserId), { userId: ownerUserId, roleId: ownerRoleId });
    const outcomes = await Promise.allSettled([
      run("iam.assignRole", ctxFor(secondUserId), { userId: secondUserId, roleId: memberRoleId }),
      run("iam.assignRole", ctxFor(ownerUserId), { userId: ownerUserId, roleId: memberRoleId }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/last owner/);
    const owners = await db.db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(and(eq(userRoles.orgId, orgId), eq(userRoles.roleId, ownerRoleId)));
    expect(owners).toHaveLength(1);
  });
});
