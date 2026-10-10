import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchProjectBoard,
  fetchProjectMembers,
  fetchProjectsEnabled,
  fetchProjects,
  readPendingProjectActions,
  ProjectsApiError,
  submitProjectAction,
} from "./projects";

const projectId = "0d57752c-41c1-4aae-9c78-b51d9ec07d62";
const taskId = "9b73995f-15a4-49d1-94fd-ef35e2276104";
const memberId = "a9d822e7-5518-4a0f-9850-607e4a226668";

afterEach(() => vi.unstubAllGlobals());

function stubProjectWriteLocks() {
  const tails = new Map<string, Promise<void>>();
  const request = vi.fn(async <T,>(name: string, _options: LockOptions, callback: () => Promise<T>): Promise<T> => {
    const previous = tails.get(name) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    tails.set(name, current);
    await previous;
    try { return await callback(); }
    finally {
      release();
      if (tails.get(name) === current) tails.delete(name);
    }
  });
  const testNavigator = Object.create(navigator) as Navigator;
  Object.defineProperty(testNavigator, "locks", { configurable: true, value: { request } });
  vi.stubGlobal("navigator", testNavigator);
  return request;
}

beforeEach(() => { stubProjectWriteLocks(); });

const retryScope = { actorId: "c0f4707d-1e6c-4627-9ce5-a80b7b95a16e", organizationId: "3196834e-9b90-4a20-9263-a3391fdc4329" };

function boardResponse() {
  return Response.json({
    columns: [
      {
        status: "todo",
        tasks: [
          { id: taskId, title: "First by position", parentTaskId: null, priority: "high", assigneeUserId: null, dueAt: null, position: 2 },
          { id: "ebc7ac08-244a-41aa-b463-9bb0d3ce315d", title: "Second by position", parentTaskId: taskId, priority: "medium", assigneeUserId: memberId, dueAt: "2026-10-02T00:00:00.000Z", position: 8 },
        ],
      },
      { status: "doing", tasks: [] },
      { status: "done", tasks: [] },
    ],
  });
}

describe("projects API client", () => {
  it("loads the existing project list contract through the same-origin session", async () => {
    const rows = [{
      id: projectId,
      name: "Website relaunch",
      status: "active",
      dueAt: "2026-10-10T00:00:00.000Z",
      createdAt: "2026-09-20T09:30:00.000Z",
    }];
    const fetchMock = vi.fn(async () => Response.json({ projects: rows }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchProjects()).resolves.toEqual(rows);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: expect.any(AbortSignal),
    }));
  });

  it("retains the server's column, task, and position order for the board", async () => {
    const fetchMock = vi.fn(async () => boardResponse());
    vi.stubGlobal("fetch", fetchMock);

    const columns = await fetchProjectBoard(projectId);

    expect(fetchMock).toHaveBeenCalledWith(`/api/projects?projectId=${projectId}`, expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));
    expect(columns.map((column) => column.status)).toEqual(["todo", "doing", "done"]);
    expect(columns[0]?.tasks.map(({ title, position }) => [title, position])).toEqual([
      ["First by position", 2],
      ["Second by position", 8],
    ]);
    expect(columns[0]?.tasks[1]?.parentTaskId).toBe(taskId);
  });

  it("rejects malformed board and list responses instead of rendering them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ projects: [{ id: projectId }] })));
    await expect(fetchProjects()).rejects.toEqual(expect.objectContaining({
      name: "ProjectsApiError",
      message: "The projects service returned data in an unexpected format.",
    }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ columns: [{ status: "todo", tasks: [{ id: taskId, position: -1 }] }] })));
    await expect(fetchProjectBoard(projectId)).rejects.toEqual(expect.objectContaining({
      message: "The project board returned data in an unexpected format.",
    }));
  });

  it("degrades unauthorized team lookup to an empty assignee list", async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: "forbidden: missing iam.read" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchProjectMembers()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/team", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));
  });

  it("validates the module switchboard before reporting whether projects is enabled", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      catalog: [{ id: "projects", label: "Projects", description: "Boards and tasks", href: "/projects" }],
      enabledModules: ["projects"],
      usingDefaults: false,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchProjectsEnabled()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      catalog: [{ id: "projects", label: "Projects", description: "Boards and tasks", href: "/projects" }],
      enabledModules: [],
      usingDefaults: false,
    })));
    await expect(fetchProjectsEnabled()).resolves.toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      catalog: [{ id: "projects", label: "Projects", description: "Boards and tasks", href: "/projects" }],
      enabledModules: ["unlisted-module"],
      usingDefaults: false,
    })));
    await expect(fetchProjectsEnabled()).rejects.toEqual(new ProjectsApiError(200, "The module switchboard returned an unknown module."));

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ catalog: [], enabledModules: [], usingDefaults: false })));
    await expect(fetchProjectsEnabled()).rejects.toEqual(new ProjectsApiError(200, "The module switchboard omitted the projects module."));
  });

  it("posts every governed action with the route's exact business fields and intent identity", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { projectId } }));
    vi.stubGlobal("fetch", fetchMock);
    const intentId = "projects-intent-1";

    await expect(submitProjectAction({ action: "createProject", name: "Website relaunch", dueAt: "2026-10-10T00:00:00.000Z" }, intentId))
      .resolves.toEqual({ kind: "completed", data: { projectId } });

    const cases = [
      [{ action: "createProject", name: "Website relaunch", dueAt: "2026-10-10T00:00:00.000Z" }, { projectId }],
      [{ action: "createTask", projectId, title: "Write the brief", parentTaskId: taskId, assigneeUserId: memberId, dueAt: "2026-10-10T00:00:00.000Z", priority: "high" }, { taskId }],
      [{ action: "assignTask", taskId }, { assigned: true }],
      [{ action: "moveTask", taskId, status: "doing", position: 4 }, { moved: true, status: "doing" }],
      [{ action: "archiveProject", projectId }, { archived: true }],
    ] as const;

    for (const [action, data] of cases) {
      fetchMock.mockResolvedValueOnce(Response.json({ ok: true, data }));
      const outcome = await submitProjectAction(action, intentId);
      expect(outcome.kind).toBe("completed");
      const [, init] = fetchMock.mock.calls.at(-1)!;
      expect(JSON.parse(String(init?.body))).toEqual({ ...action, intentId });
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
      });
    }
  });

  it("omits an empty assignee on the wire so the legacy capability clears assignment", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: { assigned: true } }));
    vi.stubGlobal("fetch", fetchMock);

    await submitProjectAction({ action: "assignTask", taskId, assigneeUserId: undefined }, "clear-assignment");

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ action: "assignTask", taskId, intentId: "clear-assignment" });
  });

  it("keeps 202 approval responses distinct from completed actions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { ok: false, pendingApproval: true, reason: "approval required" },
      { status: 202 },
    )));

    await expect(submitProjectAction({ action: "archiveProject", projectId }, "archive-intent"))
      .resolves.toEqual({ kind: "pending", reason: "approval required" });
  });

  it("maps a project permission refusal to a readable API error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })));

    await expect(fetchProjects()).rejects.toEqual(new ProjectsApiError(403, "You do not have permission to view or change projects."));
  });

  it("dispatches all five write contracts directly to Go when the paired selector is active", async () => {
    localStorage.clear();
    vi.stubGlobal("__GO_PROJECTS_WRITES__", true);
    const cases = [
      [{ action: "createProject", name: "Website relaunch", dueAt: "2026-10-10T00:00:00.000Z" }, "projects.createProject", { name: "Website relaunch", dueAt: "2026-10-10T00:00:00.000Z" }, { projectId }],
      [{ action: "archiveProject", projectId }, "projects.archiveProject", { projectId }, { archived: true }],
      [{ action: "createTask", projectId, title: "Write the brief", parentTaskId: taskId, assigneeUserId: memberId, dueAt: "2026-10-10T00:00:00.000Z", priority: "high" }, "projects.createTask", { projectId, title: "Write the brief", parentTaskId: taskId, assigneeUserId: memberId, dueAt: "2026-10-10T00:00:00.000Z", priority: "high" }, { taskId }],
      [{ action: "moveTask", taskId, status: "doing", position: 4 }, "projects.moveTask", { taskId, status: "doing", position: 4 }, { moved: true, status: "doing" }],
      [{ action: "assignTask", taskId, assigneeUserId: memberId }, "projects.assignTask", { taskId, assigneeUserId: memberId }, { assigned: true }],
    ] as const;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ ok: true, data: cases[0][3] }));
    vi.stubGlobal("fetch", fetchMock);

    for (const [action, capabilityId, input, output] of cases) {
      fetchMock.mockResolvedValueOnce(Response.json({ ok: true, data: output }));
      await expect(submitProjectAction(action, retryScope)).resolves.toEqual({ kind: "completed", data: output });
      const [url, init] = fetchMock.mock.calls.at(-1)!;
      expect(url).toBe("/api/capabilities/execute");
      expect(JSON.parse(String(init?.body))).toEqual({ capabilityId, input, intentId: expect.any(String) });
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("serializes matching Go intent reservations across tabs", async () => {
    localStorage.clear();
    vi.stubGlobal("__GO_PROJECTS_WRITES__", true);
    const lockRequest = stubProjectWriteLocks();
    let releaseResponses!: () => void;
    const bothRequestsStarted = new Promise<void>((resolve) => { releaseResponses = resolve; });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 2) releaseResponses();
      await bothRequestsStarted;
      return Response.json({ ok: true, data: { projectId } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "createProject", name: "Website relaunch" } as const;

    await expect(Promise.all([
      submitProjectAction(action, retryScope),
      submitProjectAction(action, retryScope),
    ])).resolves.toEqual([
      { kind: "completed", data: { projectId } },
      { kind: "completed", data: { projectId } },
    ]);

    const intentIds = fetchMock.mock.calls.map(([, init]) => (JSON.parse(String(init?.body)) as { intentId: string }).intentId);
    expect(new Set(intentIds).size).toBe(1);
    const reservations = lockRequest.mock.calls.slice(0, 2);
    expect(reservations).toHaveLength(2);
    expect(reservations[0]?.[0]).toBe(reservations[1]?.[0]);
    expect(reservations.every(([, options]) => options.mode === "exclusive")).toBe(true);
  });

  it("fails closed before Go dispatch when Web Locks are unavailable", async () => {
    localStorage.clear();
    vi.stubGlobal("__GO_PROJECTS_WRITES__", true);
    const testNavigator = Object.create(navigator) as Navigator;
    Object.defineProperty(testNavigator, "locks", { configurable: true, value: undefined });
    vi.stubGlobal("navigator", testNavigator);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(submitProjectAction({ action: "createProject", name: "Website relaunch" }, retryScope))
      .rejects.toThrow("Web Locks enabled");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it("recovers the exact pending project action after reload and clears its marker on success", async () => {
    localStorage.clear();
    vi.stubGlobal("__GO_PROJECTS_WRITES__", true);
    const action = { action: "createProject", name: "Website relaunch" } as const;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: false, pendingApproval: true, reason: "Manager review required." }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ ok: true, data: { projectId } }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await submitProjectAction(action, retryScope);
    expect(first.kind).toBe("pending");
    const saved = await readPendingProjectActions(retryScope);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.action).toEqual(action);

    await expect(submitProjectAction(action, retryScope, saved[0])).resolves.toEqual({ kind: "completed", data: { projectId } });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).intentId).toBe(saved[0]?.intentId);
    await expect(readPendingProjectActions(retryScope)).resolves.toEqual([]);
  });

  it("retains a Go 404 attempt and refuses legacy dispatch while its result is unresolved", async () => {
    localStorage.clear();
    vi.stubGlobal("__GO_PROJECTS_WRITES__", true);
    const fetchMock = vi.fn(async () => Response.json({ error: "route unavailable" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const action = { action: "archiveProject", projectId } as const;

    await expect(submitProjectAction(action, retryScope)).rejects.toMatchObject({ status: 404, mayHaveReachedServer: true });
    expect(await readPendingProjectActions(retryScope)).toHaveLength(1);
    vi.stubGlobal("__GO_PROJECTS_WRITES__", false);
    await expect(submitProjectAction({ action: "assignTask", taskId }, retryScope)).rejects.toMatchObject({ mayHaveReachedServer: true });
    await expect(submitProjectAction({ action: "assignTask", taskId }, { actorId: null, organizationId: null })).rejects.toMatchObject({ mayHaveReachedServer: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
