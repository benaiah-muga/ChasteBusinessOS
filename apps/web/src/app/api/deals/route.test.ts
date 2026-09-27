import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
  executeGoCapability: vi.fn(),
  getDb: vi.fn(),
  and: vi.fn(),
  eq: vi.fn(),
  dealRows: [] as Array<Record<string, unknown>>,
  dealSelect: vi.fn(),
  deals: {
    id: "deals.id",
    title: "deals.title",
    stage: "deals.stage",
    valueMinor: "deals.valueMinor",
    note: "deals.note",
    customerId: "deals.customerId",
    createdAt: "deals.createdAt",
    updatedAt: "deals.updatedAt",
    orgId: "deals.orgId",
  },
  customers: { name: "customers.name" },
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb, deals: mocks.deals, customers: mocks.customers }));
vi.mock("drizzle-orm", () => ({ and: mocks.and, eq: mocks.eq }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/route-guards", () => ({
  missingPermission: (user: { permissions: Set<string> }, permission: string) =>
    user.permissions.has(permission) ? null : Response.json({ error: `forbidden: missing permission: ${permission}` }, { status: 403 }),
}));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { GET, POST } from "./route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  authSessionId: "better-auth-session",
  permissions: new Set(["crm.read", "crm.write"]),
};
const actor = {
  type: "human",
  id: resolved.userId,
  orgId: resolved.orgId,
  permissions: resolved.permissions,
};
const actionContext = { actor, intentId: "deal-intent-1" };
const dealId = "f3c65071-356d-48e4-b5cb-cccd4fc06f6d";
const customerId = "7a7b152e-7e80-496b-952c-275067fef54f";

function request(body: unknown) {
  return new Request("http://localhost/api/deals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Deals route migration adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GO_CRM_DEAL_WRITES;
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.dealRows = [{ id: dealId }];
    mocks.and.mockReturnValue("and-predicate");
    mocks.eq.mockReturnValue("eq-predicate");
    mocks.dealSelect.mockImplementation(() => {
      const query = {
        from: vi.fn(() => query),
        leftJoin: vi.fn(() => query),
        where: vi.fn(() => query),
        limit: vi.fn(async () => mocks.dealRows),
      };
      return query;
    });
    const db = { select: mocks.dealSelect };
    mocks.getDb.mockReturnValue({ db });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { dealId } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps create and move on the legacy executor when the Go flag is unset", async () => {
    await POST(request({ action: "create", intentId: "deal-intent-1", title: "New warehouse", valueMinor: 4200, customerId }));
    mocks.execute.mockResolvedValueOnce({ ok: true, data: { moved: true, stage: "won" } });
    await POST(request({ action: "move", intentId: "deal-intent-1", dealId, stage: "won" }));

    expect(mocks.execute).toHaveBeenNthCalledWith(1, "crm.createDeal", actionContext, {
      title: "New warehouse",
      valueMinor: 4200,
      customerId,
    });
    expect(mocks.execute).toHaveBeenNthCalledWith(2, "crm.moveDealStage", actionContext, {
      dealId,
      stage: "won",
      lostReason: undefined,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("sends create to the signed Go capability and strips private replay metadata", async () => {
    vi.stubEnv("GO_CRM_DEAL_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { dealId }, replayed: true }),
    });

    const response = await POST(request({ action: "create", intentId: "deal-intent-1", title: "New warehouse", valueMinor: 4200, customerId }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { dealId } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: resolved,
      capabilityId: "crm.createDeal",
      input: { title: "New warehouse", valueMinor: 4200, customerId },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps move existence preflight and sends the exact stage input to Go", async () => {
    vi.stubEnv("GO_CRM_DEAL_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { moved: true, stage: "lost" }, replayed: false }),
    });

    const response = await POST(request({ action: "move", intentId: "deal-intent-1", dealId, stage: "lost", lostReason: "Budget changed" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { moved: true, stage: "lost" } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: resolved,
      capabilityId: "crm.moveDealStage",
      input: { dealId, stage: "lost", lostReason: "Budget changed" },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("normalizes Go approvals to the legacy deal response without exposing approval IDs", async () => {
    vi.stubEnv("GO_CRM_DEAL_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json(
        { ok: false, pendingApproval: true, reason: "Approval required", approvalId: "private-approval-id" },
        { status: 202 },
      ),
    });

    const response = await POST(request({ action: "create", title: "Deal", valueMinor: 0 }));

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, pendingApproval: true, reason: "Approval required" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("returns the legacy org-scoped 404 before selecting Go for a missing deal", async () => {
    vi.stubEnv("GO_CRM_DEAL_WRITES", "1");
    mocks.dealRows = [];

    const response = await POST(request({ action: "move", dealId, stage: "won" }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves authentication and capability error shapes", async () => {
    vi.stubEnv("GO_CRM_DEAL_WRITES", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "unauthorized" }, { status: 401 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "forbidden: missing permission: crm.write" }, { status: 403 }) });

    const authFailure = await POST(request({ action: "create", title: "Deal", valueMinor: 0 }));
    const permissionFailure = await POST(request({ action: "create", title: "Deal", valueMinor: 0 }));

    expect(authFailure.status).toBe(401);
    expect(await authFailure.json()).toEqual({ error: "unauthorized" });
    expect(permissionFailure.status).toBe(422);
    expect(await permissionFailure.json()).toEqual({ ok: false, error: "forbidden: missing permission: crm.write" });
    expect(permissionFailure.headers.get("cache-control")).toBe("no-store");
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "missing dispatch", result: { kind: "not-dispatched" } },
    { name: "malformed success", result: { kind: "response", response: Response.json({ ok: true, data: { dealId: 42 } }) } },
  ])("fails closed on $name without retrying the legacy write", async ({ result }) => {
    vi.stubEnv("GO_CRM_DEAL_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request({ action: "create", title: "Deal", valueMinor: 0 }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: false, error: "deals service unavailable; check deal status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps the deals list read on the legacy database path with Go writes enabled", async () => {
    vi.stubEnv("GO_CRM_DEAL_WRITES", "1");
    mocks.dealRows = [{
      id: dealId,
      title: "Old deal",
      stage: "lead",
      valueMinor: 100,
      note: null,
      customerId,
      customerName: "Acme",
      createdAt: new Date("2026-09-27T10:00:00.000Z"),
      updatedAt: new Date("2026-09-27T10:00:00.000Z"),
    }];

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deals: [{
      id: dealId,
      title: "Old deal",
      stage: "lead",
      valueMinor: 100,
      note: null,
      customerId,
      customerName: "Acme",
      createdAt: "2026-09-27T10:00:00.000Z",
      updatedAt: "2026-09-27T10:00:00.000Z",
    }] });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });
});
