import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
  getDb: vi.fn(),
  executeGoCapability: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/kernel", () => ({
  actorFromResolved: mocks.actorFromResolved,
  buildExecutor: mocks.buildExecutor,
  buildRegistry: mocks.buildRegistry,
}));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));

import { GET, POST } from "./route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  authSessionId: "better-auth-session",
  email: "owner@example.test",
  name: "Owner",
  permissions: new Set(["accounting.read", "accounting.write"]),
  allOrgIds: ["a5cb2579-9d6e-41ee-96d6-9af1c89bf250"],
  emailVerified: true,
};
const actionContext = {
  actor: {
    type: "human",
    id: resolved.userId,
    orgId: resolved.orgId,
    permissions: resolved.permissions,
  },
  now: new Date("2026-09-27T12:00:00.000Z"),
  services: {},
};
const customerId = "d00d512e-ab21-4f45-9199-f53d81e9597f";
const templateId = "9d2f7a5b-3c4e-4f6a-9b0c-1d2e3f4a5b6c";
const templateBody = {
  action: "create",
  intentId: "recurring-intent-1",
  customerId,
  frequency: "monthly" as const,
  memo: "Monthly retainer",
  lines: [{ description: "Retainer", quantity: 1000, unitPriceMinor: 500000, taxMinor: 0 }],
};

function request(body: unknown) {
  return new Request("http://localhost/api/recurring", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/recurring Go bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(actionContext);
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({});
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps recurring template writes on the TypeScript executor by default and preserves normalized input", async () => {
    mocks.execute.mockResolvedValue({ ok: true, data: { templateId, nextRunAt: "2026-10-01T00:00:00.000Z" } });

    const response = await POST(request(templateBody));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { templateId, nextRunAt: "2026-10-01T00:00:00.000Z" } });
    expect(mocks.execute).toHaveBeenCalledWith(
      "accounting.createRecurringTemplate",
      actionContext,
      {
        customerId,
        frequency: "monthly",
        memo: "Monthly retainer",
        lines: templateBody.lines,
      },
    );
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "create",
      body: templateBody,
      capabilityId: "accounting.createRecurringTemplate",
      input: { customerId, frequency: "monthly", memo: "Monthly retainer", lines: templateBody.lines },
      data: { templateId, nextRunAt: "2026-10-01T00:00:00.000Z" },
    },
    {
      name: "pause",
      body: { action: "pause", templateId },
      capabilityId: "accounting.pauseRecurringTemplate",
      input: { templateId },
      data: { active: false },
    },
    {
      name: "resume",
      body: { action: "resume", templateId },
      capabilityId: "accounting.resumeRecurringTemplate",
      input: { templateId },
      data: { active: true },
    },
  ])("dispatches $name through the signed Go bridge when enabled", async ({ body, capabilityId, input, data }) => {
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data }),
    });

    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: resolved,
      capabilityId,
      input,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("normalizes Go approvals and capability errors without retrying through TypeScript", async () => {
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({
        kind: "response",
        response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required", approvalId: "private-id" }, { status: 202 }),
      })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "unauthorized" }, { status: 401 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "forbidden: missing permission: accounting.write" }, { status: 403 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "template not found" }, { status: 422 }) });
    const pauseRequest = () => request({ action: "pause", templateId });

    const pending = await POST(pauseRequest());
    const unauthorized = await POST(pauseRequest());
    const denied = await POST(pauseRequest());
    const invalid = await POST(pauseRequest());

    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ error: "Approval required", pendingApproval: true });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
    expect(denied.status).toBe(422);
    expect(await denied.json()).toEqual({ error: "forbidden: missing permission: accounting.write" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toEqual({ error: "template not found" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing dispatch", result: { kind: "not-dispatched" } },
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "malformed success", result: { kind: "response", response: Response.json({ ok: true, data: { templateId: null } }) } },
    { name: "backend failure", result: { kind: "response", response: Response.json({ error: "internal error" }, { status: 500 }) } },
  ])("fails closed on $name without retrying through TypeScript", async ({ result }) => {
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request(templateBody));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "recurring template service unavailable; check template status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("fails closed when the Go dispatch throws", async () => {
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "1");
    mocks.executeGoCapability.mockRejectedValue(new Error("bridge timeout"));

    const response = await POST(request({ action: "resume", templateId }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "recurring template service unavailable; check template status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps recurring writes behind authentication, onboarding, and body validation", async () => {
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "1");
    mocks.getResolvedUser.mockResolvedValue(null);
    const anonymous = await POST(request(templateBody));
    expect(anonymous.status).toBe(401);

    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(null);
    const onboarding = await POST(request(templateBody));
    expect(onboarding.status).toBe(428);

    mocks.actorFromResolved.mockReturnValue(actionContext);
    const invalid = await POST(request({ action: "pause", templateId: "nope" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid body" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps the recurring listing GET on TypeScript even when the write flag is on", async () => {
    vi.stubEnv("GO_ACCOUNTING_RECURRING_WRITE", "1");
    mocks.execute.mockResolvedValue({ ok: true, data: { templates: [] } });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ templates: [] });
    expect(mocks.execute).toHaveBeenCalledWith("accounting.listRecurringTemplates", actionContext, {});
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });
});
