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
vi.mock("@/server/crm-assist", () => ({ draftCrmFollowUp: vi.fn() }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { GET, POST } from "./route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  authSessionId: "better-auth-session",
  permissions: new Set(["crm.read"]),
};
const dealId = "f3c65071-356d-48e4-b5cb-cccd4fc06f6d";
const customerId = "7a7b152e-7e80-496b-952c-275067fef54f";
const actor = {
  type: "human",
  id: resolved.userId,
  orgId: resolved.orgId,
  permissions: resolved.permissions,
};
const timeline = { entries: [{ kind: "invoice", date: "2026-09-27T10:00:00.000Z", refId: "invoice-1", summary: "Invoice #1 (draft, 12.34)" }] };
const tasks = { tasks: [{ id: "task-1", title: "Call customer", dueAt: null, doneAt: null, refType: "customer", refId: "customer-1", assigneeUserId: null, assigneeName: null, customerName: "Acme" }] };

describe("CRM route migration adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_INTERNAL_AUTH_SECRET", "test-only-shared-secret-value-32-bytes");
    vi.stubEnv("GO_API_INTERNAL_URL", "http://127.0.0.1:8080");
    vi.stubEnv("GO_CRM_READ", "0");
    vi.stubEnv("GO_CRM_SHADOW", "0");
    vi.stubEnv("GO_CRM_DEAL_WRITES", "0");
    vi.stubEnv("NODE_ENV", "test");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue({ actor });
    mocks.getDb.mockReturnValue({ db: { handle: "legacy-db" } });
    mocks.buildRegistry.mockReturnValue({ handle: "legacy-registry" });
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: timeline });
    mocks.canonicalInputHash.mockResolvedValue("c".repeat(64));
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps timeline and task GET query modes on legacy by default", async () => {
    vi.stubEnv("GO_CRM_DEAL_WRITES", "1");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.execute.mockResolvedValueOnce({ ok: true, data: timeline }).mockResolvedValueOnce({ ok: true, data: tasks });

    const timelineResponse = await GET(new Request(`http://localhost/api/crm?timeline=${resolved.userId}`));
    const tasksResponse = await GET(new Request("http://localhost/api/crm?tasks=anything&open=1"));

    expect(timelineResponse.status).toBe(200);
    expect(await timelineResponse.json()).toEqual(timeline);
    expect(tasksResponse.status).toBe(200);
    expect(await tasksResponse.json()).toEqual(tasks);
    expect(mocks.execute).toHaveBeenNthCalledWith(1, "crm.customerTimeline", { actor }, { customerId: resolved.userId });
    expect(mocks.execute).toHaveBeenNthCalledWith(2, "crm.listTasks", { actor }, { openOnly: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("preserves timeline precedence and the default GET response", async () => {
    const response = await GET(new Request(`http://localhost/api/crm?timeline=${resolved.userId}&tasks=1`));
    expect(await response.json()).toEqual(timeline);
    expect(mocks.execute).toHaveBeenCalledWith("crm.customerTimeline", { actor }, { customerId: resolved.userId });

    vi.clearAllMocks();
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue({ actor });
    const empty = await GET(new Request("http://localhost/api/crm"));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "nothing requested" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("returns the signed Go timeline response only for the requested mode", async () => {
    vi.stubEnv("GO_CRM_READ", "1");
    const fetchMock = vi.fn().mockResolvedValue(Response.json(timeline));
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request(`http://localhost/api/crm?timeline=${resolved.userId}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(timeline);
    expect(mocks.execute).not.toHaveBeenCalled();
    const [requestedURL, options] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(requestedURL.toString()).toBe(`http://127.0.0.1:8080/__go/crm?timeline=${resolved.userId}`);
    expect(options.cache).toBe("no-store");
    expect(options.credentials).toBe("omit");
    const token = (options.headers as Record<string, string>)["X-Chaste-Session-Assertion"] ?? "";
    const claims = JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(claims).toMatchObject({
      aud: "go.crm.read",
      sub: resolved.userId,
      org_id: resolved.orgId,
      capability_id: "crm.customerTimeline",
      input_sha256: "c".repeat(64),
      actor_id: resolved.userId,
      actor_type: "human",
      auth_session_id: resolved.authSessionId,
    });
    expect(claims.permissions).toEqual(["crm.read"]);
  });

  it("returns the Go open-task mode and forwards permission errors", async () => {
    vi.stubEnv("GO_CRM_READ", "1");
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json(tasks)).mockResolvedValueOnce(
      Response.json({ error: "forbidden: missing permission: crm.read" }, { status: 422 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await GET(new Request("http://localhost/api/crm?tasks=1&open=1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(tasks);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8080/__go/crm?tasks=1&open=1");

    mocks.actorFromResolved.mockReturnValue({ actor: { ...actor, permissions: new Set() } });
    const denied = await GET(new Request("http://localhost/api/crm?tasks=1"));
    expect(denied.status).toBe(422);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(await denied.json()).toEqual({ error: "forbidden: missing permission: crm.read" });
  });

  it("fails closed if Go is selected but its response is unavailable or invalid", async () => {
    vi.stubEnv("GO_CRM_READ", "1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "internal error" }, { status: 500 })));

    const response = await GET(new Request(`http://localhost/api/crm?timeline=${resolved.userId}`));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "CRM service unavailable" });
  });

  it("returns legacy data in development shadow mode and logs differences", async () => {
    vi.stubEnv("GO_CRM_SHADOW", "1");
    vi.stubEnv("NODE_ENV", "development");
    mocks.execute.mockResolvedValue({ ok: true, data: timeline });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ entries: [] })));

    const response = await GET(new Request(`http://localhost/api/crm?timeline=${resolved.userId}`));
    expect(await response.json()).toEqual(timeline);
    expect(mocks.logger.warn).toHaveBeenCalledWith("Go CRM read differs from legacy data", { mode: "timeline" });
  });

  it("keeps POST writes on the legacy capability executor when Go reads are enabled", async () => {
    vi.stubEnv("GO_CRM_READ", "1");
    vi.stubEnv("GO_CRM_DEAL_WRITES", "1");
    mocks.execute.mockResolvedValue({ ok: true, data: { taskId: "task-created" } });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const request = new Request("http://localhost/api/crm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "createTask", title: "Call Acme" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { taskId: "task-created" } });
    expect(mocks.execute).toHaveBeenCalledWith("crm.createTask", { actor }, expect.objectContaining({ title: "Call Acme" }));
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps convertLead on the legacy executor when the Go flag is unset", async () => {
    mocks.execute.mockResolvedValue({ ok: true, data: { dealId, customerId, stage: "qualified" } });
    const response = await POST(new Request("http://localhost/api/crm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "convertLead", dealId, customerId, createCustomer: false }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { dealId, customerId, stage: "qualified" } });
    expect(mocks.execute).toHaveBeenCalledWith("crm.convertLead", { actor }, {
      dealId,
      customerId,
      createCustomer: false,
      customerName: undefined,
    });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("sends convertLead to Go and removes replay metadata from the public response", async () => {
    vi.stubEnv("GO_CRM_DEAL_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: { dealId, customerId, stage: "qualified" }, replayed: true }),
    });

    const response = await POST(new Request("http://localhost/api/crm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "convertLead", dealId, customerId, createCustomer: false, customerName: "Acme" }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { dealId, customerId, stage: "qualified" } });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: { actor },
      session: resolved,
      capabilityId: "crm.convertLead",
      input: { dealId, customerId, createCustomer: false, customerName: "Acme" },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("normalizes Go approval and capability errors to the legacy CRM response shapes", async () => {
    vi.stubEnv("GO_CRM_DEAL_WRITES", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required", approvalId: "private-approval-id" }, { status: 202 }),
      })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "unauthorized" }, { status: 401 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "forbidden: missing permission: crm.write" }, { status: 403 }) });
    const convertRequest = () => new Request("http://localhost/api/crm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "convertLead", dealId, createCustomer: true, customerName: "Acme" }),
    });

    const pending = await POST(convertRequest());
    const unauthorized = await POST(convertRequest());
    const denied = await POST(convertRequest());

    expect(pending.status).toBe(202);
    expect(pending.headers.get("cache-control")).toBe("no-store");
    expect(await pending.json()).toEqual({ error: "Approval required", pendingApproval: true });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
    expect(denied.status).toBe(422);
    expect(await denied.json()).toEqual({ error: "forbidden: missing permission: crm.write" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "missing dispatch", result: { kind: "not-dispatched" } },
    { name: "malformed success", result: { kind: "response", response: Response.json({ ok: true, data: { dealId: 42 } }) } },
  ])("fails closed on $name without retrying convertLead through TypeScript", async ({ result }) => {
    vi.stubEnv("GO_CRM_DEAL_WRITES", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(new Request("http://localhost/api/crm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "convertLead", dealId, createCustomer: true, customerName: "Acme" }),
    }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "CRM service unavailable; check deal status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("rejects anonymous requests before either backend", async () => {
    vi.stubEnv("GO_CRM_DEAL_WRITES", "1");
    mocks.getResolvedUser.mockResolvedValue(null);

    const response = await POST(new Request("http://localhost/api/crm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "convertLead", dealId, createCustomer: true }),
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
