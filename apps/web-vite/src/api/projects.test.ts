import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchProjectBoard,
  fetchProjectMembers,
  fetchProjectsEnabled,
  fetchProjects,
  ProjectsApiError,
  submitProjectAction,
} from "./projects";

const projectId = "0d57752c-41c1-4aae-9c78-b51d9ec07d62";
const taskId = "9b73995f-15a4-49d1-94fd-ef35e2276104";
const memberId = "a9d822e7-5518-4a0f-9850-607e4a226668";

afterEach(() => vi.unstubAllGlobals());

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
});
