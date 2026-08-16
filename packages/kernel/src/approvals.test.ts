import { describe, expect, it } from "vitest";
import {
  InMemoryApprovalGrantStore,
  grantCovers,
  type ApprovalGrantRecord,
} from "./approvals.js";

const now = () => new Date("2026-08-16T12:00:00Z");

function grant(overrides: Partial<ApprovalGrantRecord> = {}): ApprovalGrantRecord {
  return {
    id: "grant-1",
    organizationId: "o1",
    grantedBy: "approver-1",
    grantedToUserId: "u1",
    grantedAt: now().toISOString(),
    scope: { commandType: "messaging.email.send" },
    status: "active",
    ...overrides,
  };
}

describe("grantCovers", () => {
  const req = {
    organizationId: "o1",
    userId: "u1",
    commandType: "messaging.email.send",
    now,
  };

  it("covers an active grant matching org, actor, and scope", () => {
    const check = grantCovers(grant(), req);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.grant.id).toBe("grant-1");
  });

  it("rejects grants for another organization", () => {
    expect(grantCovers(grant({ organizationId: "o2" }), req).ok).toBe(false);
  });

  it("rejects grants for another actor", () => {
    expect(grantCovers(grant({ grantedToUserId: "u2" }), req).ok).toBe(false);
  });

  it("rejects revoked grants", () => {
    expect(grantCovers(grant({ status: "revoked" }), req).ok).toBe(false);
  });

  it("rejects expired grants", () => {
    const past = new Date(now().getTime() - 1000).toISOString();
    expect(grantCovers(grant({ expiresAt: past }), req).ok).toBe(false);
  });

  it("rejects scope mismatches on command, resource type, and resource id", () => {
    expect(grantCovers(grant({ scope: { commandType: "inventory.create" } }), req).ok).toBe(false);
    expect(
      grantCovers(grant({ scope: { resourceType: "invoice" } }), { ...req, resourceType: "purchase_order" })
        .ok,
    ).toBe(false);
    expect(
      grantCovers(grant({ scope: { resourceId: "inv-1" } }), { ...req, resourceId: "inv-2" }).ok,
    ).toBe(false);
  });

  it("a grant without scope fields covers the grantee broadly", () => {
    expect(grantCovers(grant({ scope: {} }), { ...req, commandType: "anything.else" }).ok).toBe(true);
  });

  it("a scope match on resource type/id is honored when both are set", () => {
    const check = grantCovers(grant({ scope: { resourceType: "invoice", resourceId: "inv-1" } }), {
      ...req,
      resourceType: "invoice",
      resourceId: "inv-1",
    });
    expect(check.ok).toBe(true);
  });
});

describe("InMemoryApprovalGrantStore", () => {
  it("creates, gets, lists, and revokes grants", async () => {
    const store = new InMemoryApprovalGrantStore({ now });
    const created = await store.create({
      organizationId: "o1",
      grantedBy: "approver-1",
      grantedToUserId: "u1",
      scope: { commandType: "messaging.email.send" },
      policyBasis: "default-risk-policy",
      evidenceShown: [{ id: "e1", type: "approval", ref: "inbox-1" }],
    });

    expect(await store.get(created.id)).toEqual(created);
    expect((await store.list("o1")).map((g) => g.id)).toEqual([created.id]);
    expect(await store.list("o2")).toEqual([]);

    expect(await store.revoke(created.id, { by: "approver-1", reason: "org policy change" })).toBe(
      true,
    );
    expect(await store.revoke(created.id, { by: "approver-1" })).toBe(false);

    const revoked = await store.get(created.id);
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.revokeReason).toBe("org policy change");
    expect(revoked?.revokedBy).toBe("approver-1");
  });

  it("check() returns the covering active grant", async () => {
    const store = new InMemoryApprovalGrantStore({ now });
    const created = await store.create({
      organizationId: "o1",
      grantedBy: "approver-1",
      grantedToUserId: "u1",
      scope: { commandType: "messaging.email.send" },
    });

    const check = await store.check({
      organizationId: "o1",
      userId: "u1",
      commandType: "messaging.email.send",
      now,
    });
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.grant.id).toBe(created.id);
  });

  it("check() reports not_found when no grant applies", async () => {
    const store = new InMemoryApprovalGrantStore({ now });
    const check = await store.check({ organizationId: "o1", userId: "u1", now });
    expect(check).toEqual({ ok: false, reason: "not_found" });
  });

  it("check() ignores grants for a different actor", async () => {
    const store = new InMemoryApprovalGrantStore({ now });
    await store.create({
      organizationId: "o1",
      grantedBy: "approver-1",
      grantedToUserId: "u1",
      scope: { commandType: "messaging.email.send" },
    });
    const check = await store.check({
      organizationId: "o1",
      userId: "u2",
      commandType: "messaging.email.send",
      now,
    });
    expect(check.ok).toBe(false);
  });
});