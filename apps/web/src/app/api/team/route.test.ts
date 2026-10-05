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
  permissions: new Set(["iam.read", "iam.admin"]),
  allOrgIds: ["a5cb2579-9d6e-41ee-96d6-9af1c89bf250"],
  emailVerified: true,
};
const actionContext = {
  actor: { type: "human", id: resolved.userId, orgId: resolved.orgId, permissions: resolved.permissions },
  now: new Date("2026-09-27T12:00:00.000Z"),
  services: {},
};
const teamData = {
  members: [{ userId: "member-1", name: "Ada Lovelace", email: "ada@example.test", roleKeys: ["owner"] }],
  roles: [{ id: "role-1", key: "owner", name: "Owner", isSystem: true, permissions: ["*"] }],
};
const catalog = [{ permission: "iam.admin" }, { permission: "iam.read" }, { permission: "iam.read" }, { permission: "accounting.read" }];
const catalogResult = ["accounting.read", "iam.admin", "iam.read"];

function request(body: unknown) {
  return new Request("http://localhost/api/team", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/team Go bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_IAM_TEAM", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockImplementation((_session, options) => ({
      ...actionContext,
      ...(options?.intentId ? { intentId: options.intentId } : {}),
    }));
    mocks.getDb.mockReturnValue({ db: {} });
    mocks.buildRegistry.mockReturnValue({ all: () => catalog });
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: teamData });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps GET on TypeScript by default and preserves the full capability catalog", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...teamData, catalog: catalogResult });
    expect(mocks.execute).toHaveBeenCalledWith("iam.listMembers", actionContext, {});
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("dispatches listMembers to Go and keeps the full TypeScript permission catalog", async () => {
    vi.stubEnv("GO_IAM_TEAM", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: teamData, replayed: true }),
    });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ...teamData, catalog: catalogResult });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext,
      session: resolved,
      capabilityId: "iam.listMembers",
      input: {},
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("maps Go list authorization failures to the legacy 422 error response", async () => {
    vi.stubEnv("GO_IAM_TEAM", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ error: "forbidden: missing permission: iam.read" }, { status: 403 }),
    });

    const response = await GET();

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "forbidden: missing permission: iam.read" });
  });

  it.each([
    {
      action: "createRole",
      body: { action: "createRole", key: "bookkeeper", name: "Bookkeeper", intentId: "team-intent-1" },
      capabilityId: "iam.createRole",
      input: { key: "bookkeeper", name: "Bookkeeper" },
      output: { roleId: "role-bookkeeper" },
      replayed: true,
    },
    {
      action: "setPermissions",
      body: { action: "setPermissions", roleId: "role-bookkeeper", permissions: ["accounting.read", "iam.read"], intentId: "set-permissions-intent" },
      capabilityId: "iam.updateRolePermissions",
      input: { roleId: "role-bookkeeper", permissions: ["accounting.read", "iam.read"] },
      output: { permissionCount: 2 },
      replayed: false,
    },
    {
      action: "assignRole",
      body: { action: "assignRole", userId: "member-1", roleId: "role-bookkeeper", intentId: "assign-role-intent" },
      capabilityId: "iam.assignRole",
      input: { userId: "member-1", roleId: "role-bookkeeper" },
      output: { assigned: true },
      replayed: false,
    },
    {
      action: "invite",
      body: { action: "invite", email: "new@example.test", roleId: "role-bookkeeper", intentId: "invite-intent" },
      capabilityId: "iam.inviteMember",
      input: { email: "new@example.test", roleId: "role-bookkeeper" },
      output: { invitationId: "inv-1", token: "invite-token", expiresAt: "2026-10-04T12:00:00.000Z" },
      replayed: false,
    },
  ])("dispatches $action with the legacy capability mapping and validates its output", async ({ body, capabilityId, input, output, replayed }) => {
    vi.stubEnv("GO_IAM_TEAM", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: output, ...(replayed ? { replayed } : {}) }),
    });

    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: output });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: expect.objectContaining({ actor: actionContext.actor, now: actionContext.now }),
      session: resolved,
      capabilityId,
      input,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("keeps writes on TypeScript by default and preserves normalized capability input", async () => {
    mocks.execute.mockResolvedValue({ ok: true, data: { roleId: "role-bookkeeper" } });

    const response = await POST(request({ action: "createRole", key: "bookkeeper", name: "Bookkeeper", intentId: "legacy-intent" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { roleId: "role-bookkeeper" } });
    expect(mocks.execute).toHaveBeenCalledWith(
      "iam.createRole",
      expect.objectContaining({ actor: actionContext.actor, intentId: "legacy-intent" }),
      { key: "bookkeeper", name: "Bookkeeper" },
    );
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("normalizes approval, unauthorized, forbidden, and capability errors from Go", async () => {
    vi.stubEnv("GO_IAM_TEAM", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, pendingApproval: true, reason: "Human review required", approvalId: "private" }, { status: 202 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "unauthorized" }, { status: 401 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "forbidden: missing permission: iam.admin" }, { status: 403 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "role not found" }, { status: 422 }) });
    const post = () => POST(request({ action: "assignRole", userId: "member-1", roleId: "role-1", intentId: "error-mapping-intent" }));

    const pending = await post();
    const unauthorized = await post();
    const forbidden = await post();
    const refused = await post();

    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ ok: false, pendingApproval: true, reason: "Human review required" });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
    expect(forbidden.status).toBe(422);
    expect(await forbidden.json()).toEqual({ ok: false, error: "forbidden: missing permission: iam.admin" });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ ok: false, error: "role not found" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing dispatch", result: { kind: "not-dispatched" } },
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "malformed list output", result: { kind: "response", response: Response.json({ ok: true, data: { members: [], roles: "invalid" } }) } },
  ])("fails closed on Go GET $name without falling back", async ({ result }) => {
    vi.stubEnv("GO_IAM_TEAM", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "team service unavailable; check team status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "malformed action output", result: { kind: "response", response: Response.json({ ok: true, data: { assigned: "yes" } }) } },
    { name: "unexpected status", result: { kind: "response", response: Response.json({ error: "internal error" }, { status: 500 }) } },
  ])("fails closed on Go POST $name without retrying through TypeScript", async ({ result }) => {
    vi.stubEnv("GO_IAM_TEAM", "1");
    mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request({ action: "assignRole", userId: "member-1", roleId: "role-1", intentId: "unknown-outcome-intent" }));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "team service unavailable; check team status before retrying" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves authentication and request validation before either dispatch path", async () => {
    vi.stubEnv("GO_IAM_TEAM", "1");
    mocks.getResolvedUser.mockResolvedValue(null);
    const anonymous = await POST(request({ action: "invite", email: "new@example.test", roleId: "role-1" }));
    expect(anonymous.status).toBe(401);

    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockReturnValue(null);
    const onboarding = await POST(request({ action: "invite", email: "new@example.test", roleId: "role-1", intentId: "onboarding-intent" }));
    expect(onboarding.status).toBe(401);

    mocks.actorFromResolved.mockReturnValue(actionContext);
    const invalid = await POST(request({ action: "createRole", key: "Bad Key", name: "Bad", intentId: "invalid-action-intent" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "invalid body" });

    const invalidEmail = await POST(request({ action: "invite", email: "person@localhost", roleId: "role-1", intentId: "invalid-email-intent" }));
    expect(invalidEmail.status).toBe(400);
    expect(await invalidEmail.json()).toEqual({ error: "invalid body" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing", body: { action: "assignRole", userId: "member-1", roleId: "role-1" } },
    { name: "blank", body: { action: "assignRole", userId: "member-1", roleId: "role-1", intentId: " \t " } },
    { name: "overlong", body: { action: "assignRole", userId: "member-1", roleId: "role-1", intentId: "i".repeat(201) } },
    { name: "control-containing", body: { action: "assignRole", userId: "member-1", roleId: "role-1", intentId: "bad\nkey" } },
  ])("rejects $name intent IDs before either Team executor", async ({ body }) => {
    vi.stubEnv("GO_IAM_TEAM", "1");
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid body" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
