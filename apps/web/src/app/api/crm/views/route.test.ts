import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
  getDb: vi.fn(),
  canonicalInputHash: vi.fn(),
  executeGoCapability: vi.fn(),
  logger: { warn: vi.fn() },
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@chaste/kernel", () => ({ canonicalInputHash: mocks.canonicalInputHash, logger: mocks.logger }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { GET, POST } from "./route";

const userId = "0b9e1bd3-8432-4059-a0b1-902ff8d520d0";
const orgId = "a5cb2579-9d6e-41ee-96d6-9af1c89bf250";
const view = {
  id: "2d864228-385a-47bd-8a2e-1174a826083a",
  name: "My active customers",
  filters: { status: "active", owner: "all", staleOnly: false, duplicateOnly: false, tag: "" },
  isShared: true,
  isPinned: true,
  createdByUserId: userId,
  updatedAt: "2026-09-29T10:11:12.123Z",
};
const resolved = { userId, orgId, authSessionId: "better-auth-session", permissions: new Set(["crm.read"]) };
const actor = { type: "human", id: userId, orgId, permissions: resolved.permissions };
const saveBody = {
  id: view.id,
  name: "Updated view",
  filters: view.filters,
  isShared: true,
  isPinned: false,
};

describe("CRM saved views read bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_INTERNAL_AUTH_SECRET", "test-only-shared-secret-value-32-bytes");
    vi.stubEnv("GO_API_INTERNAL_URL", "http://127.0.0.1:8080");
    vi.stubEnv("GO_CRM_VIEW_READS", "0");
    vi.stubEnv("GO_CRM_VIEW_WRITES", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue({ actor });
    mocks.getDb.mockReturnValue({ db: { handle: "legacy-db" } });
    mocks.buildRegistry.mockReturnValue({ handle: "legacy-registry" });
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { views: [view] } });
    mocks.canonicalInputHash.mockResolvedValue("c".repeat(64));
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps the legacy saved views reader as the default", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ views: [view] });
    expect(mocks.execute).toHaveBeenCalledWith("crm.listCustomerViews", { actor }, {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dispatches a signed Go read and validates the response when enabled", async () => {
    vi.stubEnv("GO_CRM_VIEW_READS", "1");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ views: [view] }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ views: [view] });
    expect(mocks.execute).not.toHaveBeenCalled();
    const [url, options] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://127.0.0.1:8080/__go/crm?views=1");
    const token = (options.headers as Record<string, string>)["X-Chaste-Session-Assertion"] ?? "";
    const claims = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(claims).toMatchObject({
      aud: "go.crm.read",
      sub: userId,
      org_id: orgId,
      capability_id: "crm.listCustomerViews",
      input_sha256: "c".repeat(64),
      actor_id: userId,
      actor_type: "human",
      auth_session_id: resolved.authSessionId,
    });
    expect(claims.permissions).toEqual(["crm.read"]);
  });

  it("fails closed without falling back after Go dispatch", async () => {
    vi.stubEnv("GO_CRM_VIEW_READS", "1");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ views: [{ id: "invalid" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects extra response fields at every saved-view level", async () => {
    vi.stubEnv("GO_CRM_VIEW_READS", "1");
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ views: [{ ...view, filters: { ...view.filters, unrecognized: true } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET();

    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves auth and onboarding checks before Go dispatch", async () => {
    vi.stubEnv("GO_CRM_VIEW_READS", "1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.getResolvedUser.mockResolvedValue(null);
    const unauthorized = await GET();
    expect(unauthorized.status).toBe(401);

    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(null);
    const onboarding = await GET();
    expect(onboarding.status).toBe(428);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps saved-view writes on the legacy executor by default", async () => {
    mocks.execute.mockResolvedValue({ ok: true, data: { viewId: view.id, previous: null } });

    const response = await POST(new Request("http://localhost/api/crm/views", {
      method: "POST",
      body: JSON.stringify({ ...saveBody, intentId: "view-save-intent" }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { viewId: view.id, previous: null } });
    expect(mocks.actorFromResolved).toHaveBeenCalledWith(resolved, { intentId: "view-save-intent" });
    expect(mocks.execute).toHaveBeenCalledWith("crm.saveCustomerView", { actor }, saveBody);
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches signed human saved-view writes to Go when enabled", async () => {
    vi.stubEnv("GO_CRM_VIEW_WRITES", "1");
    const data = { viewId: view.id, previous: null };
    mocks.executeGoCapability.mockResolvedValue({ kind: "response", response: Response.json({ ok: true, data }) });

    const response = await POST(new Request("http://localhost/api/crm/views", {
      method: "POST",
      body: JSON.stringify({ ...saveBody, intentId: "view-save-intent" }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: { actor },
      session: resolved,
      capabilityId: "crm.saveCustomerView",
      input: saveBody,
    });
  });

  it("preserves the pending-approval response for Go saved-view writes", async () => {
    vi.stubEnv("GO_CRM_VIEW_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required", approvalId: "approval-id" }, { status: 202 }),
    });

    const response = await POST(new Request("http://localhost/api/crm/views", { method: "POST", body: JSON.stringify(saveBody) }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ pendingApproval: true, error: "Approval required" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed after a Go write dispatch without retrying through TypeScript", async () => {
    vi.stubEnv("GO_CRM_VIEW_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({ kind: "outcome-unknown" });

    const response = await POST(new Request("http://localhost/api/crm/views", { method: "POST", body: JSON.stringify(saveBody) }));

    expect(response.status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
