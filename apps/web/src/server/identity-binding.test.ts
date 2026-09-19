import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, memberships, organizations, purgeTenantFinancials, users, type Database } from "@chaste/db";

/**
 * N03 verified binding: domain identities are pre-provisioned (SCIM,
 * invitations) and bind by email, so a password account for that email
 * proves nothing until the mailbox is demonstrated. An unverified session
 * resolves to a bare identity - no memberships, no permissions - however
 * the address is cased; verification (or a trusted-IdP assertion) unlocks
 * the pre-provisioned access. Concurrent first sign-ins resolve to exactly
 * one domain user.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

const state = vi.hoisted(() => ({
  session: null as { user: { email: string; name: string | null; emailVerified: boolean } } | null,
}));

vi.mock("@/server/auth", () => ({
  auth: {
    api: {
      getSession: async () => state.session,
    },
  },
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));

const { getResolvedUser } = await import("@/server/session");
const { resolveActorFromAuth } = await import("@/server/kernel");

let db: Database;
const orgId = crypto.randomUUID();
const provisionedEmail = `pre-provisioned-${orgId.slice(0, 8)}@probe.test`;
const freshEmail = `fresh-${orgId.slice(0, 8)}@probe.test`;
let provisionedUserId: string;

beforeAll(async () => {
  db = createDb(url);
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Identity Binding Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
  await db.db.insert(organizations).values({ id: orgId, name: "Identity Binding Probe", slug: `ib-${orgId.slice(0, 8)}` });

  // SCIM-style pre-provisioning: a domain identity and a membership exist
  // with no auth account anywhere near them.
  const [user] = await db.db.insert(users).values({ email: provisionedEmail, name: "Provisioned Person" }).returning({ id: users.id });
  provisionedUserId = user!.id;
  await db.db.insert(memberships).values({ orgId, userId: provisionedUserId });
});

afterAll(async () => {
  state.session = null;
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Identity Binding Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
});

describe("N03 verified identity binding", () => {
  it("an unverified sign-up for a pre-provisioned email inherits nothing", async () => {
    state.session = { user: { email: provisionedEmail, name: "Attacker or Owner", emailVerified: false } };
    const resolved = await getResolvedUser();
    expect(resolved).not.toBeNull();
    expect(resolved!.userId).toBe(provisionedUserId);
    expect(resolved!.allOrgIds).toEqual([]);
    expect(resolved!.orgId).toBeNull();
    expect(resolved!.permissions.size).toBe(0);

    // Case variations of the same claim reach the same wall.
    state.session = { user: { email: provisionedEmail.toUpperCase(), name: "Attacker or Owner", emailVerified: false } };
    const cased = await getResolvedUser();
    expect(cased!.allOrgIds).toEqual([]);
    expect(cased!.permissions.size).toBe(0);
  });

  it("verification - or a trusted IdP assertion - unlocks the pre-provisioned access", async () => {
    state.session = { user: { email: provisionedEmail, name: "Provisioned Person", emailVerified: true } };
    const resolved = await getResolvedUser();
    expect(resolved!.userId).toBe(provisionedUserId);
    expect(resolved!.allOrgIds).toContain(orgId);
    expect(resolved!.orgId).toBe(orgId);
  });

  it("a verified session with no memberships still resolves to a bare identity", async () => {
    state.session = { user: { email: freshEmail, name: "Newcomer", emailVerified: true } };
    const resolved = await getResolvedUser();
    expect(resolved!.allOrgIds).toEqual([]);
    expect(resolved!.orgId).toBeNull();
    const [row] = await db.db.select({ id: users.id }).from(users).where(eq(users.email, freshEmail));
    expect(row).toBeTruthy();
  });

  it("concurrent first sign-ins resolve to exactly one domain user", async () => {
    const email = `race-${orgId.slice(0, 8)}@probe.test`;
    const [a, b] = await Promise.all([
      resolveActorFromAuth(email.toUpperCase(), "Racer A", db.db),
      resolveActorFromAuth(email, "Racer B", db.db),
    ]);
    expect(a.userId).toBe(b.userId);
    const rows = await db.db.select({ id: users.id }).from(users).where(eq(users.email, email.toLowerCase()));
    expect(rows).toHaveLength(1);
  });
});
