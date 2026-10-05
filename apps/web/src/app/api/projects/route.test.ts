import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getResolvedUser: vi.fn(),
  actorFromResolved: vi.fn(),
  buildExecutor: vi.fn(),
  buildRegistry: vi.fn(),
  execute: vi.fn(),
  getDb: vi.fn(),
  desc: vi.fn(),
  eq: vi.fn(),
  executeGoCapability: vi.fn(),
  readGoProjects: vi.fn(),
}));

vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } }));
vi.mock("@chaste/db", () => ({ getDb: mocks.getDb, projects: { id: "id", name: "name", status: "status", dueAt: "dueAt", createdAt: "createdAt", orgId: "orgId" } }));
vi.mock("drizzle-orm", () => ({ desc: mocks.desc, eq: mocks.eq }));
vi.mock("@/server/kernel", () => ({ actorFromResolved: mocks.actorFromResolved, buildExecutor: mocks.buildExecutor, buildRegistry: mocks.buildRegistry }));
vi.mock("@/server/route-guards", () => ({
  missingPermission: (user: { permissions: Set<string> }, permission: string) =>
    user.permissions.has(permission) ? null : Response.json({ error: `forbidden: missing permission: ${permission}` }, { status: 403 }),
}));
vi.mock("@/server/session", () => ({ getResolvedUser: mocks.getResolvedUser }));
vi.mock("@/server/go-bridge", () => ({ executeGoCapability: mocks.executeGoCapability }));
vi.mock("@/server/projects-bridge", () => ({ readGoProjects: mocks.readGoProjects }));

import { GET, POST } from "./route";

const resolved = {
  userId: "0b9e1bd3-8432-4059-a0b1-902ff8d520d0",
  orgId: "a5cb2579-9d6e-41ee-96d6-9af1c89bf250",
  authSessionId: "better-auth-session",
  email: "owner@example.test",
  name: "Owner",
  permissions: new Set(["projects.read", "projects.write"]),
  allOrgIds: ["a5cb2579-9d6e-41ee-96d6-9af1c89bf250"],
  emailVerified: true,
};
const actor = {
  type: "human",
  id: resolved.userId,
  orgId: resolved.orgId,
  permissions: resolved.permissions,
} as const;
const actionContext = { actor, intentId: "intent-project-1" };
const projectId = "f3c65071-356d-48e4-b5cb-cccd4fc06f6d";
const taskId = "7a7b152e-7e80-496b-952c-275067fef54f";
const userId = "d00d512e-ab21-4f45-9199-f53d81e9597f";

const goCases = [
  {
    name: "createProject",
    body: { action: "createProject", intentId: "intent-project-1", name: "Warehouse refresh" },
    capabilityId: "projects.createProject",
    input: { name: "Warehouse refresh", dueAt: undefined },
    output: { projectId },
  },
  {
    name: "createTask",
    body: { action: "createTask", intentId: "intent-project-1", projectId, title: "Measure the floor", parentTaskId: taskId, assigneeUserId: userId, dueAt: "2026-10-01T00:00:00.000Z", priority: "high" },
    capabilityId: "projects.createTask",
    input: { projectId, title: "Measure the floor", parentTaskId: taskId, assigneeUserId: userId, dueAt: "2026-10-01T00:00:00.000Z", priority: "high" },
    output: { taskId },
  },
  {
    name: "assignTask",
    body: { action: "assignTask", intentId: "intent-project-1", taskId },
    capabilityId: "projects.assignTask",
    input: { taskId, assigneeUserId: undefined },
    output: { assigned: true },
  },
  {
    name: "moveTask",
    body: { action: "moveTask", intentId: "intent-project-1", taskId, status: "doing", position: 3 },
    capabilityId: "projects.moveTask",
    input: { taskId, status: "doing", position: 3 },
    output: { moved: true, status: "doing" },
  },
  {
    name: "archiveProject",
    body: { action: "archiveProject", intentId: "intent-project-1", projectId },
    capabilityId: "projects.archiveProject",
    input: { projectId },
    output: { archived: true },
  },
] as const;

function request(body: unknown) {
  return new Request("http://localhost/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Projects route migration adapter", () => {
  const listRows = [{
    id: projectId,
    name: "Warehouse refresh",
    status: "active",
    dueAt: new Date("2026-10-01T00:00:00.000Z"),
    createdAt: new Date("2026-09-27T10:00:00.000Z"),
  }];
  const listQuery = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    limit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GO_PROJECTS_WRITE", "0");
    vi.stubEnv("GO_PROJECTS_READ", "0");
    vi.stubEnv("GO_PROJECTS_SHADOW", "0");
    mocks.getResolvedUser.mockResolvedValue(resolved);
    mocks.actorFromResolved.mockImplementation((_user, options) => ({ ...actionContext, intentId: options?.intentId }));
    mocks.getDb.mockReturnValue({ db: { select: vi.fn(() => listQuery) } });
    listQuery.from.mockReturnValue(listQuery);
    listQuery.where.mockReturnValue(listQuery);
    listQuery.orderBy.mockReturnValue(listQuery);
    listQuery.limit.mockResolvedValue(listRows);
    mocks.desc.mockReturnValue("descending-created-at");
    mocks.eq.mockReturnValue("org-scope");
    mocks.buildRegistry.mockReturnValue({ legacy: "registry" });
    mocks.buildExecutor.mockReturnValue({ execute: mocks.execute });
    mocks.execute.mockResolvedValue({ ok: true, data: { projectId } });
    mocks.executeGoCapability.mockResolvedValue({ kind: "not-dispatched" });
    mocks.readGoProjects.mockResolvedValue({ kind: "not-dispatched" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(goCases)("keeps $name on the legacy executor by default", async ({ body, capabilityId, input }) => {
    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { projectId } });
    expect(mocks.execute).toHaveBeenCalledWith(capabilityId, { ...actionContext, intentId: "intent-project-1" }, input);
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps the legacy executor when GO_PROJECTS_WRITE is unset", async () => {
    delete process.env.GO_PROJECTS_WRITE;

    const response = await POST(request(goCases[0]!.body));

    expect(response.status).toBe(200);
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).toHaveBeenCalledWith("projects.createProject", { ...actionContext, intentId: "intent-project-1" }, goCases[0]!.input);
  });

  it.each(goCases)("maps $name to the matching Go capability when opted in", async ({ body, capabilityId, input, output }) => {
    vi.stubEnv("GO_PROJECTS_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: true, data: output, replayed: true }),
    });

    const response = await POST(request(body));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, data: output });
    expect(mocks.executeGoCapability).toHaveBeenCalledWith({
      actionContext: { ...actionContext, intentId: "intent-project-1" },
      session: resolved,
      capabilityId,
      input,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("rejects anonymous and malformed requests before either write backend", async () => {
    vi.stubEnv("GO_PROJECTS_WRITE", "1");
    mocks.getResolvedUser.mockResolvedValueOnce(null);
    const anonymous = await POST(request(goCases[0]!.body));
    const malformed = await POST(request({ action: "moveTask", taskId: "not-a-uuid", status: "doing" }));

    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "unauthorized" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "invalid body" });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves the legacy public permission error shape for Go permission failures", async () => {
    vi.stubEnv("GO_PROJECTS_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ error: "forbidden: missing permission: projects.write" }, { status: 403 }),
    });

    const response = await POST(request(goCases[0]!.body));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ ok: false, error: "forbidden: missing permission: projects.write" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("returns the legacy-shaped pending approval response without internal approval identifiers", async () => {
    vi.stubEnv("GO_PROJECTS_WRITE", "1");
    mocks.executeGoCapability.mockResolvedValue({
      kind: "response",
      response: Response.json({ ok: false, pendingApproval: true, reason: "Approval required", approvalId: "internal-approval-id" }, { status: 202 }),
    });

    const response = await POST(request(goCases[0]!.body));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: false, pendingApproval: true, reason: "Approval required" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("preserves validated Go authorization and capability errors in the legacy contract", async () => {
    vi.stubEnv("GO_PROJECTS_WRITE", "1");
    mocks.executeGoCapability
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ error: "unauthorized" }, { status: 401 }) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json({ ok: false, error: "project not found" }, { status: 422 }) });

    const unauthorized = await POST(request(goCases[0]!.body));
    const capabilityFailure = await POST(request(goCases[4]!.body));

    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized" });
    expect(capabilityFailure.status).toBe(422);
    expect(await capabilityFailure.json()).toEqual({ ok: false, error: "project not found" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each([
    { name: "unknown outcome", result: { kind: "outcome-unknown" } },
    { name: "not dispatched", result: { kind: "not-dispatched" } },
    { name: "malformed success body", result: { kind: "response", response: Response.json({ ok: true, data: { projectId: 5 } }) } },
    { name: "malformed approval body", result: { kind: "response", response: Response.json({ ok: false, pendingApproval: true }, { status: 202 }) } },
    { name: "backend failure", result: { kind: "response", response: Response.json({ error: "internal error" }, { status: 500 }) } },
    { name: "thrown bridge error", result: new Error("bridge failed") },
  ])("fails closed on $name without retrying the TypeScript write", async ({ result }) => {
    vi.stubEnv("GO_PROJECTS_WRITE", "1");
    if (result instanceof Error) mocks.executeGoCapability.mockRejectedValue(result);
    else mocks.executeGoCapability.mockResolvedValue(result);

    const response = await POST(request(goCases[0]!.body));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "projects service unavailable" });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("keeps legacy list and board reads unchanged while Go writes are enabled", async () => {
    vi.stubEnv("GO_PROJECTS_WRITE", "1");
    const board = { columns: [{ status: "todo", tasks: [] }, { status: "doing", tasks: [] }, { status: "done", tasks: [] }] };
    mocks.execute.mockResolvedValue({ ok: true, data: board });

    const listResponse = await GET(new Request("http://localhost/api/projects"));
    const boardResponse = await GET(new Request(`http://localhost/api/projects?projectId=${projectId}`));

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      projects: [{ id: projectId, name: "Warehouse refresh", status: "active", dueAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-09-27T10:00:00.000Z" }],
    });
    expect(listQuery.limit).toHaveBeenCalledWith(50);
    expect(boardResponse.status).toBe(200);
    expect(await boardResponse.json()).toEqual(board);
    expect(mocks.execute).toHaveBeenCalledWith("projects.listBoard", { ...actionContext, intentId: undefined }, { projectId });
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("keeps the legacy Projects GET as the default", async () => {
    const response = await GET(new Request("http://localhost/api/projects"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      projects: [{ id: projectId, name: "Warehouse refresh", status: "active", dueAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-09-27T10:00:00.000Z" }],
    });
    expect(mocks.readGoProjects).not.toHaveBeenCalled();
  });

  it("uses the first projectId and ignores unrelated query params like URLSearchParams.get", async () => {
    const board = { columns: [{ status: "todo", tasks: [] }, { status: "doing", tasks: [] }, { status: "done", tasks: [] }] };
    mocks.execute.mockResolvedValue({ ok: true, data: board });

    const response = await GET(new Request(`http://localhost/api/projects?source=page&projectId=${projectId}&projectId=${taskId}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(board);
    expect(mocks.execute).toHaveBeenCalledWith("projects.listBoard", { ...actionContext, intentId: undefined }, { projectId });
  });

  it("rejects offset due dates at the legacy route validation boundary", async () => {
    const response = await POST(request({ action: "createProject", name: "Offset date", dueAt: "2026-10-05T12:30:00+00:00" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid body" });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.executeGoCapability).not.toHaveBeenCalled();
  });

  it("accepts the legacy minute-precision UTC due date", async () => {
    const response = await POST(request({ action: "createProject", name: "Minute date", dueAt: "2026-10-05T12:30Z" }));

    expect(response.status).toBe(200);
    expect(mocks.execute).toHaveBeenCalledWith("projects.createProject", { ...actionContext, intentId: undefined }, {
      name: "Minute date",
      dueAt: "2026-10-05T12:30Z",
    });
  });

  it("uses the signed Go reader for collection and board GETs when enabled", async () => {
    vi.stubEnv("GO_PROJECTS_READ", "1");
    const projects = { projects: [{ id: projectId, name: "Warehouse refresh", status: "active", dueAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-09-27T10:00:00.000Z" }] };
    const board = { columns: [{ status: "todo", tasks: [{ id: taskId, title: "Measure the floor", parentTaskId: null, priority: "medium", assigneeUserId: null, dueAt: null, position: 0 }] }, { status: "doing", tasks: [] }, { status: "done", tasks: [] }] };
    mocks.readGoProjects
      .mockResolvedValueOnce({ kind: "response", response: Response.json(projects) })
      .mockResolvedValueOnce({ kind: "response", response: Response.json(board) });

    const listResponse = await GET(new Request("http://localhost/api/projects"));
    const boardResponse = await GET(new Request(`http://localhost/api/projects?projectId=${projectId}`));

    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get("cache-control")).toBe("no-store");
    expect(await listResponse.json()).toEqual(projects);
    expect(boardResponse.status).toBe(200);
    expect(boardResponse.headers.get("cache-control")).toBe("no-store");
    expect(await boardResponse.json()).toEqual(board);
    expect(mocks.readGoProjects).toHaveBeenNthCalledWith(1, {
      actionContext: { ...actionContext, intentId: undefined },
      session: resolved,
      projectId: undefined,
    });
    expect(mocks.readGoProjects).toHaveBeenNthCalledWith(2, {
      actionContext: { ...actionContext, intentId: undefined },
      session: resolved,
      projectId,
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("fails closed on malformed Go read payloads", async () => {
    vi.stubEnv("GO_PROJECTS_READ", "1");
    mocks.readGoProjects.mockResolvedValue({ kind: "response", response: Response.json({ projects: [{ id: projectId }] }) });

    const response = await GET(new Request("http://localhost/api/projects"));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "projects service unavailable" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("shadows only the unaudited collection read and always returns legacy data", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("GO_PROJECTS_SHADOW", "1");
    mocks.readGoProjects.mockResolvedValue({
      kind: "response",
      response: Response.json({ projects: [{ id: projectId, name: "Warehouse refresh", status: "active", dueAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-09-27T10:00:00.000Z" }] }),
    });

    const listResponse = await GET(new Request("http://localhost/api/projects"));
    const boardResponse = await GET(new Request(`http://localhost/api/projects?projectId=${projectId}`));

    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toMatchObject({ projects: [{ id: projectId }] });
    expect(boardResponse.status).toBe(200);
    expect(mocks.readGoProjects).toHaveBeenCalledOnce();
    expect(mocks.execute).toHaveBeenCalledWith("projects.listBoard", { ...actionContext, intentId: undefined }, { projectId });
  });
});
