import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectsPage } from "./ProjectsPage";

const projectId = "0d57752c-41c1-4aae-9c78-b51d9ec07d62";
const secondProjectId = "2beae091-6921-4e49-97b1-5049196e0ac5";
const taskId = "9b73995f-15a4-49d1-94fd-ef35e2276104";
const doingTaskId = "ebc7ac08-244a-41aa-b463-9bb0d3ce315d";
const memberId = "a9d822e7-5518-4a0f-9850-607e4a226668";

const activeProject = {
  id: projectId,
  name: "Website relaunch",
  status: "active",
  dueAt: "2026-10-10T00:00:00.000Z",
  createdAt: "2026-09-20T09:30:00.000Z",
};

function board(projectStatus: "active" | "archived" = "active") {
  void projectStatus;
  return {
    columns: [
      {
        status: "todo",
        tasks: [
          { id: taskId, title: "Draft the launch brief", parentTaskId: null, priority: "high", assigneeUserId: null, dueAt: null, position: 1 },
        ],
      },
      {
        status: "doing",
        tasks: [
          { id: doingTaskId, title: "Review the copy", parentTaskId: taskId, priority: "medium", assigneeUserId: memberId, dueAt: "2026-10-05T00:00:00.000Z", position: 4 },
        ],
      },
      { status: "done", tasks: [] },
    ],
  };
}

function team() {
  return Response.json({ members: [{ userId: memberId, name: "Ada Lovelace", email: "ada@example.com" }], roles: [], catalog: [] });
}

function projectModules(enabled = true) {
  return Response.json({
    catalog: [{ id: "projects", label: "Projects", description: "Project boards and tasks", href: "/projects" }],
    enabledModules: enabled ? ["projects"] : [],
    usingDefaults: false,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Vite projects page", () => {
  it("loads the existing project list and renders columns, task details, and server order", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/modules") return projectModules();
      if (path === "/api/projects") return Response.json({ projects: [activeProject] });
      if (path.startsWith("/api/projects?projectId=")) return Response.json(board());
      if (path === "/api/team") return team();
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectsPage />);

    expect(screen.getByRole("status").textContent).toContain("Checking project availability");
    expect(await screen.findByRole("heading", { name: "Board · Website relaunch" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /Website relaunch/ }).getAttribute("aria-pressed")).toBe("true");
    expect((await screen.findByRole("region", { name: "todo task column" })).textContent).toContain("Draft the launch brief");
    expect(screen.getByRole("region", { name: "doing task column" }).textContent).toContain("Review the copy");
    expect(screen.getByRole("region", { name: "doing task column" }).textContent).toContain("Ada Lovelace");
    expect(screen.getByRole("button", { name: "Archive project" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/projects", expect.objectContaining({ credentials: "same-origin" }));
    expect(fetchMock).toHaveBeenCalledWith(`/api/projects?projectId=${projectId}`, expect.objectContaining({ credentials: "same-origin" }));
  });

  it("creates a project with the legacy date format, refreshes the list, and selects its board", async () => {
    const createdProject = { ...activeProject, id: secondProjectId, name: "Q4 rollout", dueAt: "2026-12-02T00:00:00.000Z" };
    let projects = [activeProject];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return projectModules();
      if (path === "/api/projects" && init?.method !== "POST") return Response.json({ projects });
      if (path.startsWith("/api/projects?projectId=")) return Response.json({ columns: [{ status: "todo", tasks: [] }, { status: "doing", tasks: [] }, { status: "done", tasks: [] }] });
      if (path === "/api/team") return team();
      if (path === "/api/projects" && init?.method === "POST") {
        projects = [createdProject, ...projects];
        return Response.json({ ok: true, data: { projectId: secondProjectId } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectsPage />);
    await screen.findByRole("heading", { name: "Board · Website relaunch" });

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Q4 rollout  " } });
    fireEvent.change(screen.getByLabelText(/Due date/), { target: { value: "2026-12-02" } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    expect(await screen.findByRole("heading", { name: "Board · Q4 rollout" })).not.toBeNull();
    expect(await screen.findByText("Create Q4 rollout done.")).not.toBeNull();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/projects");
    const payload = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({ action: "createProject", name: "Q4 rollout", dueAt: "2026-12-02T00:00:00.000Z" });
    expect(payload.intentId).toEqual(expect.any(String));
    expect(String(payload.intentId).length).toBeGreaterThan(0);
  });

  it("creates tasks with the selected assignee, priority, and UTC due date", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return projectModules();
      if (path === "/api/projects" && init?.method !== "POST") return Response.json({ projects: [activeProject] });
      if (path.startsWith("/api/projects?projectId=")) return Response.json(board());
      if (path === "/api/team") return team();
      if (path === "/api/projects" && init?.method === "POST") return Response.json({ ok: true, data: { taskId: "75d7ce21-ea48-4828-8c84-bad43b82d6c7" } });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectsPage />);
    await screen.findByRole("heading", { name: "Board · Website relaunch" });

    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "  Send the launch brief  " } });
    fireEvent.change(screen.getByLabelText("Assignee", { selector: "select" }), { target: { value: memberId } });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("Due (optional)"), { target: { value: "2026-10-06" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(await screen.findByRole("status")).not.toBeNull();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    const payload = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      action: "createTask",
      projectId,
      title: "Send the launch brief",
      assigneeUserId: memberId,
      dueAt: "2026-10-06T00:00:00.000Z",
      priority: "high",
    });
    expect(payload).not.toHaveProperty("parentTaskId");
    expect(payload.intentId).toEqual(expect.any(String));
  });

  it("moves tasks to the next explicit board position and retains task ordering", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return projectModules();
      if (path === "/api/projects" && init?.method !== "POST") return Response.json({ projects: [activeProject] });
      if (path.startsWith("/api/projects?projectId=")) return Response.json(board());
      if (path === "/api/team") return team();
      if (path === "/api/projects" && init?.method === "POST") return Response.json({ ok: true, data: { moved: true, status: "doing" } });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectsPage />);
    await screen.findByRole("heading", { name: "Board · Website relaunch" });

    fireEvent.change(await screen.findByRole("combobox", { name: "Move Draft the launch brief" }), { target: { value: "doing" } });

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    const payload = JSON.parse(String(post?.[1]?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({ action: "moveTask", taskId, status: "doing", position: 5 });
    expect(payload.intentId).toEqual(expect.any(String));
  });

  it("clears task assignment by omitting the empty assignee field", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return projectModules();
      if (path === "/api/projects" && init?.method !== "POST") return Response.json({ projects: [activeProject] });
      if (path.startsWith("/api/projects?projectId=")) return Response.json(board());
      if (path === "/api/team") return team();
      if (path === "/api/projects" && init?.method === "POST") return Response.json({ ok: true, data: { assigned: true } });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectsPage />);
    await screen.findByRole("heading", { name: "Board · Website relaunch" });

    fireEvent.change(await screen.findByRole("combobox", { name: "Assign Review the copy" }), { target: { value: "" } });

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ action: "assignTask", taskId: doingTaskId });
    expect(JSON.parse(String(post?.[1]?.body))).not.toHaveProperty("assigneeUserId");
  });

  it("requires archive confirmation and keeps archived task controls consistent with the legacy page", async () => {
    let project = activeProject;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return projectModules();
      if (path === "/api/projects" && init?.method !== "POST") return Response.json({ projects: [project] });
      if (path.startsWith("/api/projects?projectId=")) return Response.json(board());
      if (path === "/api/team") return team();
      if (path === "/api/projects" && init?.method === "POST") {
        project = { ...project, status: "archived" };
        return Response.json({ ok: true, data: { archived: true } });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectsPage />);
    await screen.findByRole("heading", { name: "Board · Website relaunch" });
    await screen.findByRole("combobox", { name: "Move Draft the launch brief" });

    fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
    const dialog = screen.getByRole("dialog", { name: "Archive Website relaunch?" });
    expect(dialog).not.toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive project" }));

    expect(await screen.findByText(/This project is archived/)).not.toBeNull();
    expect(screen.queryByLabelText("New task")).toBeNull();
    expect(screen.queryByRole("button", { name: "Archive project" })).toBeNull();
    expect((screen.getByRole("combobox", { name: "Move Draft the launch brief" }) as HTMLSelectElement).disabled).toBe(false);
    expect((screen.getByRole("combobox", { name: "Assign Review the copy" }) as HTMLSelectElement).disabled).toBe(false);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ action: "archiveProject", projectId });
    expect(JSON.parse(String(post?.[1]?.body)).intentId).toEqual(expect.any(String));
  });

  it("closes archive confirmation on Escape and restores focus to the opener", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/modules") return projectModules();
      if (path === "/api/projects") return Response.json({ projects: [activeProject] });
      if (path.startsWith("/api/projects?projectId=")) return Response.json(board());
      if (path === "/api/team") return team();
      return new Response(null, { status: 404 });
    }));
    render(<ProjectsPage />);
    await screen.findByRole("combobox", { name: "Move Draft the launch brief" });
    const archiveButton = screen.getByRole("button", { name: "Archive project" });

    archiveButton.focus();
    fireEvent.click(archiveButton);
    const dialog = screen.getByRole("dialog", { name: "Archive Website relaunch?" });
    expect(document.activeElement).toBe(dialog);
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(archiveButton);
    expect(document.body.style.overflow).toBe("");
  });

  it("shows the governed approval notice and does not treat a 202 as completed", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return projectModules();
      if (path === "/api/projects" && init?.method !== "POST") return Response.json({ projects: [activeProject] });
      if (path.startsWith("/api/projects?projectId=")) return Response.json(board());
      if (path === "/api/team") return team();
      if (path === "/api/projects" && init?.method === "POST") return Response.json(
        { ok: false, pendingApproval: true, reason: "approval required" },
        { status: 202 },
      );
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectsPage />);
    await screen.findByRole("heading", { name: "Board · Website relaunch" });

    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Publish the note" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));

    expect(await screen.findByText("Add “Publish the note” needs human approval. It is in the Approvals inbox.")).not.toBeNull();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/projects?projectId=")).length).toBe(1);
  });

  it("closes the archive dialog on a pending decision and leaves the project available", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return projectModules();
      if (path === "/api/projects" && init?.method !== "POST") return Response.json({ projects: [activeProject] });
      if (path.startsWith("/api/projects?projectId=")) return Response.json(board());
      if (path === "/api/team") return team();
      if (path === "/api/projects" && init?.method === "POST") return Response.json(
        { ok: false, pendingApproval: true, reason: "approval required" },
        { status: 202 },
      );
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectsPage />);
    await screen.findByRole("combobox", { name: "Move Draft the launch brief" });

    fireEvent.click(screen.getByRole("button", { name: "Archive project" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Archive project" }));

    expect(await screen.findByText("Archive Website relaunch needs human approval. It is in the Approvals inbox.")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((screen.getByRole("button", { name: "Archive project" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("loads without team permissions, and recovers from project and board errors", async () => {
    let projectReads = 0;
    let boardReads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/modules") return projectModules();
      if (path === "/api/team") return Response.json({ error: "forbidden" }, { status: 403 });
      if (path === "/api/projects") {
        projectReads += 1;
        return projectReads === 1 ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json({ projects: [activeProject] });
      }
      if (path.startsWith("/api/projects?projectId=")) {
        boardReads += 1;
        return boardReads === 1 ? Response.json({ error: "board unavailable" }, { status: 503 }) : Response.json(board());
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectsPage />);

    expect((await screen.findByRole("alert")).textContent).toContain("The projects service is unavailable. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Board · Website relaunch" })).not.toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain("The projects service is unavailable. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "todo task column" })).not.toBeNull();
    expect(screen.queryByText(/member lookup failed/i)).toBeNull();
    expect(projectReads).toBe(2);
    expect(boardReads).toBe(2);
  });

  it("shows explicit empty project and board states", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/modules") return projectModules();
      if (String(input) === "/api/projects") return Response.json({ projects: [] });
      if (String(input) === "/api/team") return new Response(null, { status: 403 });
      return new Response(null, { status: 404 });
    }));

    render(<ProjectsPage />);

    expect(await screen.findByRole("heading", { name: "No projects yet" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Select a project" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Create project" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows the module-disabled guard and makes no project or team requests", async () => {
    const fetchMock = vi.fn(async () => projectModules(false));
    vi.stubGlobal("fetch", fetchMock);

    render(<ProjectsPage />);

    expect(await screen.findByRole("heading", { name: "Projects is disabled" })).not.toBeNull();
    expect(screen.getByText(/switched off for your organization/)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/modules", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("moves tasks with drag and drop while preserving the next column position", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/modules") return projectModules();
      if (path === "/api/projects" && init?.method !== "POST") return Response.json({ projects: [activeProject] });
      if (path.startsWith("/api/projects?projectId=")) return Response.json(board());
      if (path === "/api/team") return team();
      if (path === "/api/projects" && init?.method === "POST") return Response.json({ ok: true, data: { moved: true, status: "doing" } });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ProjectsPage />);
    await screen.findByRole("heading", { name: "Board · Website relaunch" });
    await screen.findByText("Draft the launch brief");
    const dataTransfer = { effectAllowed: "", setData: vi.fn() };
    const taskCard = screen.getByText("Draft the launch brief").closest("li");
    const doingColumn = screen.getByRole("region", { name: "doing task column" });
    if (!taskCard) throw new Error("Task card was not rendered");

    fireEvent.dragStart(taskCard, { dataTransfer });
    fireEvent.dragOver(doingColumn);
    await act(async () => fireEvent.drop(doingColumn));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", taskId);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ action: "moveTask", taskId, status: "doing", position: 5 });
  });
});
