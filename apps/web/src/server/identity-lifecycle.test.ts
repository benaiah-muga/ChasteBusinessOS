import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  invitations,
  memberships,
  organizations,
  roles,
  userRoles,
  users,
  type Database,
} from "@chaste/db";
import { claimInvitation, deactivateMember } from "./identity-lifecycle";
import { purgeTenantFinancials } from "@chaste/db";

/**
 * I1 (N07/N03): the shared identity lifecycle. Invitation claims are
 * row-locked compare-and-set transitions that require a verified mailbox,
 * and deactivation removes every grant in one motion - with the last owner
 * refused and no partial effects.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

let db: Database;
const orgId = crypto.randomUUID();
const ownerUserId = crypto.randomUUID();
const memberUserId = crypto.randomUUID();
let ownerRoleId: string;
let memberRoleId: string;

async function seedUser(id: string, email: string): Promise<void> {
  await db.db.insert(users).values({ id, email, name: email.split("@")[0] });
}

async function seedInvitation(opts: {
  token: string;
  email: string;
  roleId: string;
  status?: string;
  expiresInDays?: number;
}): Promise<string> {
  const [inv] = await db.db
    .insert(invitations)
    .values({
      orgId,
      email: opts.email.toLowerCase(),
      roleId: opts.roleId,
      token: opts.token,
      status: opts.status ?? "pending",
      invitedByUserId: ownerUserId,
      expiresAt: new Date(Date.now() + (opts.expiresInDays ?? 7) * 86_400_000),
    })
    .returning({ id: invitations.id });
  return inv!.id;
}

beforeAll(async () => {
  db = createDb(url);
  await db.db.insert(organizations).values({ id: orgId, name: "Lifecycle Org", slug: `lifecycle-${orgId.slice(0, 8)}` });
  await seedUser(ownerUserId, "owner@lifecycle.test");
  await seedUser(memberUserId, "member@lifecycle.test");
  const roleRows = await db.db
    .insert(roles)
    .values([
      { orgId, key: "owner", name: "Owner", isSystem: true },
      { orgId, key: "member", name: "Member", isSystem: true },
    ])
    .returning({ id: roles.id, key: roles.key });
  ownerRoleId = roleRows.find((r) => r.key === "owner")!.id;
  memberRoleId = roleRows.find((r) => r.key === "member")!.id;
  await db.db.insert(memberships).values({ orgId, userId: ownerUserId });
  await db.db.insert(userRoles).values({ orgId, userId: ownerUserId, roleId: ownerRoleId });
});

afterAll(async () => {
  await purgeTenantFinancials(db.db, orgId);
  await db.db.delete(userRoles).where(eq(userRoles.orgId, orgId));
  await db.db.delete(invitations).where(eq(invitations.orgId, orgId));
  await db.db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.db.delete(roles).where(eq(roles.orgId, orgId));
  await db.db.delete(users).where(eq(users.id, ownerUserId));
  await db.db.delete(users).where(eq(users.id, memberUserId));
  await db.db.delete(organizations).where(eq(organizations.id, orgId));
  await db.client.end();
});

describe("invitation claims (N07/N03)", () => {
  it("claims atomically: membership, role, and accepted status in one unit", async () => {
    const token = `tok-${crypto.randomUUID()}`;
    await seedInvitation({ token, email: "Member@lifecycle.test", roleId: memberRoleId });
    const result = await claimInvitation({
      token,
      userId: memberUserId,
      email: "member@lifecycle.test",
      emailVerified: true,
    });
    expect(result).toEqual({ ok: true });
    const [member] = await db.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, memberUserId)));
    expect(member).toBeTruthy();
    const grants = await db.db.select().from(userRoles).where(eq(userRoles.userId, memberUserId));
    expect(grants).toHaveLength(1);
    expect(grants[0]!.roleId).toBe(memberRoleId);
    const [inv] = await db.db.select().from(invitations).where(eq(invitations.token, token));
    expect(inv!.status).toBe("accepted");
  });

  it("a concurrent double accept yields exactly one winner", async () => {
    const token = `tok-${crypto.randomUUID()}`;
    await seedInvitation({ token, email: "race@lifecycle.test", roleId: memberRoleId });
    const racer = crypto.randomUUID();
    await seedUser(racer, "race@lifecycle.test");
    const claim = () =>
      claimInvitation({ token, userId: racer, email: "race@lifecycle.test", emailVerified: true });
    const [first, second] = await Promise.all([claim(), claim()]);
    const winners = [first, second].filter((r) => r.ok);
    const losers = [first, second].filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ ok: false, reason: "already_accepted" });
    const grants = await db.db.select().from(userRoles).where(eq(userRoles.userId, racer));
    expect(grants).toHaveLength(1);
    await db.db.delete(users).where(eq(users.id, racer));
  });

  it("refuses an unverified mailbox: an invitation is a pre-provisioned binding (N03)", async () => {
    const token = `tok-${crypto.randomUUID()}`;
    await seedInvitation({ token, email: "unverified@lifecycle.test", roleId: memberRoleId });
    const result = await claimInvitation({
      token,
      userId: memberUserId,
      email: "unverified@lifecycle.test",
      emailVerified: false,
    });
    expect(result).toMatchObject({ ok: false, reason: "unverified_email" });
    const [inv] = await db.db.select().from(invitations).where(eq(invitations.token, token));
    expect(inv!.status).toBe("pending");
  });

  it("expires an overdue invitation and refuses it", async () => {
    const token = `tok-${crypto.randomUUID()}`;
    await seedInvitation({ token, email: "stale@lifecycle.test", roleId: memberRoleId, expiresInDays: -1 });
    const result = await claimInvitation({
      token,
      userId: memberUserId,
      email: "stale@lifecycle.test",
      emailVerified: true,
    });
    expect(result).toMatchObject({ ok: false, reason: "expired" });
    const [inv] = await db.db.select().from(invitations).where(eq(invitations.token, token));
    expect(inv!.status).toBe("expired");
  });

  it("refuses a claim by another address", async () => {
    const token = `tok-${crypto.randomUUID()}`;
    await seedInvitation({ token, email: "invited@lifecycle.test", roleId: memberRoleId });
    const result = await claimInvitation({
      token,
      userId: memberUserId,
      email: "someone.else@lifecycle.test",
      emailVerified: true,
    });
    expect(result).toMatchObject({ ok: false, reason: "email_mismatch" });
  });
});

describe("member deactivation (N07)", () => {
  it("refuses to deactivate the last owner and leaves zero partial effects", async () => {
    const result = await deactivateMember({ orgId, userId: ownerUserId });
    expect(result).toMatchObject({ ok: false, reason: "last_owner" });
    const [member] = await db.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, ownerUserId)));
    expect(member, "membership must survive a refused deactivation").toBeTruthy();
    const grants = await db.db.select().from(userRoles).where(eq(userRoles.userId, ownerUserId));
    expect(grants, "role grants must survive a refused deactivation").toHaveLength(1);
  });

  it("clears membership, role grants, and pending invitations in one motion", async () => {
    // A second owner exists, so the first may now be deactivated.
    await db.db.insert(userRoles).values({ orgId, userId: memberUserId, roleId: ownerRoleId });
    const token = `tok-${crypto.randomUUID()}`;
    await seedInvitation({ token, email: "owner@lifecycle.test", roleId: memberRoleId });

    const result = await deactivateMember({ orgId, userId: ownerUserId });
    expect(result).toEqual({ ok: true });
    const [member] = await db.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, ownerUserId)));
    expect(member).toBeUndefined();
    const grants = await db.db.select().from(userRoles).where(eq(userRoles.userId, ownerUserId));
    expect(grants).toEqual([]);
    const [inv] = await db.db.select().from(invitations).where(eq(invitations.token, token));
    expect(inv!.status).toBe("revoked");
    // Restore the owner for later teardown ordering sanity.
    await db.db.insert(memberships).values({ orgId, userId: ownerUserId }).onConflictDoNothing();
    await db.db.insert(userRoles).values({ orgId, userId: ownerUserId, roleId: ownerRoleId });
  });

  it("refuses an unknown member", async () => {
    const result = await deactivateMember({ orgId, userId: crypto.randomUUID() });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
  });
});
