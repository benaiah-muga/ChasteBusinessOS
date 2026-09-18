import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, organizations, purgeTenantFinancials, scimTokens, type Database } from "@chaste/db";

/**
 * SCIM token expiry/rotation policy (0054): new tokens live 90 days by
 * default (1–365 configurable), rotation is create-new + deactivate-old,
 * and the IdP route refuses expired tokens regardless of the active flag.
 * Route handlers are exercised directly with a mocked session resolution.
 */

const url = process.env.DATABASE_URL ?? "postgresql://chaste:chaste_dev@localhost:5433/chaste_os_v2";

const state = vi.hoisted(() => ({
  current: null as {
    userId: string;
    email: string;
    name: string | null;
    orgId: string | null;
    permissions: Set<string>;
  } | null,
}));

vi.mock("@/server/session", () => ({
  getResolvedUser: async () => state.current,
}));

const { GET: tokensGET, POST: tokensPOST } = await import("@/app/api/scim/tokens/route");
const { GET: usersGET } = await import("@/app/api/scim/v2/Users/route");

let db: Database;
const orgId = crypto.randomUUID();
let adminUserId: string;
const createdTokenIds: string[] = [];

function bearer(raw: string): Request {
  return new Request("http://localhost/api/scim/v2/Users", { headers: { authorization: `Bearer ${raw}` } });
}

beforeAll(async () => {
  db = createDb(url);
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Scim Expiry Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
  await db.db.insert(organizations).values({ id: orgId, name: "Scim Expiry Probe", slug: `sx-${orgId.slice(0, 8)}` });
  const { users } = await import("@chaste/db");
  const [user] = await db.db.insert(users).values({ email: `scim-${orgId.slice(0, 8)}@probe.test`, name: "Scim Admin" }).returning({ id: users.id });
  adminUserId = user!.id;
  state.current = { userId: adminUserId, email: `scim-${orgId.slice(0, 8)}@probe.test`, name: "Scim Admin", orgId, permissions: new Set(["iam.admin"]) };
});

afterAll(async () => {
  state.current = null;
  const orgs = await db.db.select({ id: organizations.id }).from(organizations).where(eq(organizations.name, "Scim Expiry Probe"));
  for (const o of orgs) {
    await purgeTenantFinancials(db.db, o.id);
    await db.db.delete(organizations).where(eq(organizations.id, o.id));
  }
});

describe("SCIM token expiry and rotation", () => {
  it("creates tokens with the default 90-day window and refuses out-of-policy windows", async () => {
    const created = await tokensPOST(new Request("http://localhost/api/scim/tokens", { method: "POST", body: JSON.stringify({ label: "IdP" }) }));
    expect(created.status).toBe(201);
    const body = (await created.json()) as { token: string; id: string; expiresAt: string };
    createdTokenIds.push(body.id);
    const days = (new Date(body.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);

    for (const bad of [0, 400, 12.5]) {
      const refused = await tokensPOST(new Request("http://localhost/api/scim/tokens", { method: "POST", body: JSON.stringify({ expiresInDays: bad }) }));
      expect(refused.status).toBe(400);
    }

    const custom = await tokensPOST(new Request("http://localhost/api/scim/tokens", { method: "POST", body: JSON.stringify({ expiresInDays: 7, label: "Short-lived" }) }));
    const customBody = (await custom.json()) as { token: string; id: string; expiresAt: string };
    createdTokenIds.push(customBody.id);
    const customDays = (new Date(customBody.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(customDays).toBeGreaterThan(6);
    expect(customDays).toBeLessThanOrEqual(7);
  });

  it("refuses expired tokens and honors rotation, whatever the active flag says", async () => {
    const fresh = (await (await tokensPOST(new Request("http://localhost/api/scim/tokens", { method: "POST", body: JSON.stringify({ expiresInDays: 30 }) }))).json()) as { token: string; id: string };
    createdTokenIds.push(fresh.id);
    const ok = await usersGET(bearer(fresh.token));
    expect(ok.status).toBe(200);

    // Rotation: the old token is deactivated, the new one works.
    const rotated = (await (await tokensPOST(new Request("http://localhost/api/scim/tokens", { method: "POST", body: JSON.stringify({ expiresInDays: 30 }) }))).json()) as { token: string; id: string };
    createdTokenIds.push(rotated.id);
    await db.db.update(scimTokens).set({ active: false }).where(eq(scimTokens.id, fresh.id));
    expect((await usersGET(bearer(fresh.token))).status).toBe(401);
    expect((await usersGET(bearer(rotated.token))).status).toBe(200);

    // An expired-but-active token is dead.
    const raw = `scim_${crypto.randomUUID().replaceAll("-", "")}`;
    const { createHash } = await import("node:crypto");
    await db.db.insert(scimTokens).values({
      orgId,
      tokenHash: createHash("sha256").update(raw).digest("hex"),
      label: "expired",
      active: true,
      expiresAt: new Date(Date.now() - 3_600_000),
    });
    expect((await usersGET(bearer(raw))).status).toBe(401);

    // Pre-policy tokens (null expiry) keep working until deactivated.
    const legacyRaw = `scim_${crypto.randomUUID().replaceAll("-", "")}`;
    await db.db.insert(scimTokens).values({
      orgId,
      tokenHash: createHash("sha256").update(legacyRaw).digest("hex"),
      label: "legacy",
      active: true,
      expiresAt: null,
    });
    expect((await usersGET(bearer(legacyRaw))).status).toBe(200);
    const listed = (await (await tokensGET()).json()) as { tokens: Array<{ id: string; expiresAt: string | null }> };
    for (const id of createdTokenIds) {
      expect(listed.tokens.find((t) => t.id === id)?.expiresAt).toBeTruthy();
    }
  });
});
