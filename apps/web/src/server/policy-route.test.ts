import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  hasPermissionFor: vi.fn(),
  createGoPolicyAssertion: vi.fn(),
  getDb: vi.fn(),
  and: vi.fn(),
  eq: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@chaste/db", () => ({
  getDb: mocks.getDb,
  policies: { orgId: "orgId", capabilityPattern: "capabilityPattern" },
}));
vi.mock("drizzle-orm", () => ({ and: mocks.and, eq: mocks.eq }));
vi.mock("@chaste/kernel", () => ({ logger: mocks.logger }));
vi.mock("@/server/go-bridge", () => ({ createGoPolicyAssertion: mocks.createGoPolicyAssertion }));
vi.mock("@/server/kernel", () => ({
  actorFromResolved: mocks.actorFromResolved,
  buildExecutor: mocks.buildExecutor,
  buildRegistry: mocks.buildRegistry,
  hasPermissionFor: mocks.hasPermissionFor,
}));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));

import { GET, POST } from "../app/api/policy/route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  permissions: ["iam.admin"],
};
const goPolicy = {
  policy: { maxRiskAutonomous: "money", moneyThresholdMinor: 125_500, requiresApprovalFor: ["identity", "money"] },
  canEdit: true,
};

describe("policy route ownership adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_INTERNAL_AUTH_SECRET", "test-only-shared-secret-value-32-bytes");
    vi.stubEnv("GO_API_INTERNAL_URL", "http://127.0.0.1:8080");
    vi.stubEnv("GO_POLICY_READ", "1");
    vi.stubEnv("GO_POLICY_SHADOW", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.hasPermissionFor.mockReturnValue(true);
    mocks.createGoPolicyAssertion.mockReturnValue("signed-assertion");
    mocks.getDb.mockReturnValue({
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [goPolicy.policy],
            }),
          }),
        }),
      },
    });
    mocks.actorFromResolved.mockReturnValue({ actor: { id: resolved.userId } });
    mocks.buildRegistry.mockReturnValue({});
    mocks.execute.mockResolvedValue({ ok: true, pendingApproval: true });
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns the Go policy read for the resolved organization without caching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(goPolicy));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(goPolicy);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/__go/policy",
      expect.objectContaining({ headers: { "X-Chaste-Session-Assertion": "signed-assertion" }, cache: "no-store" }),
    );
    expect(mocks.createGoPolicyAssertion).toHaveBeenCalledWith(
      { userId: resolved.userId, orgId: resolved.orgId, canEdit: true },
      "test-only-shared-secret-value-32-bytes",
    );
  });

  it("keeps the legacy response and owner by default", async () => {
    vi.stubEnv("GO_POLICY_READ", "0");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(goPolicy);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("compares Go in development shadow mode and still returns the legacy response", async () => {
    vi.stubEnv("GO_POLICY_READ", "0");
    vi.stubEnv("GO_POLICY_SHADOW", "1");
    vi.stubEnv("NODE_ENV", "development");
    const legacyPolicy = {
      policy: { maxRiskAutonomous: "write", moneyThresholdMinor: 50_000, requiresApprovalFor: [] },
      canEdit: true,
    };
    mocks.getDb.mockReturnValue({
      db: {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => [legacyPolicy.policy] }),
          }),
        }),
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(goPolicy)));

    const response = await GET();

    expect(await response.json()).toEqual(legacyPolicy);
    expect(mocks.logger.warn).toHaveBeenCalledWith("Go policy read differs from legacy data");
  });

  it("requires a resolved organization before it contacts Go", async () => {
    mocks.getResolvedUser.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the Go policy owner is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "internal error" }, { status: 500 })));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "policy service unavailable" });
  });

  it("keeps policy writes on the legacy governed capability path", async () => {
    const request = new Request("http://localhost/api/policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxRiskAutonomous: "money", intentId: "test-policy-write-001" }),
    });

    const response = await POST(request);

    expect(response.status).toBe(202);
    expect(mocks.execute).toHaveBeenCalledWith(
      "iam.setOrgPolicy",
      expect.objectContaining({ actor: expect.any(Object) }),
      expect.objectContaining({ maxRiskAutonomous: "money", requiresApprovalFor: [] }),
    );
  });
});
