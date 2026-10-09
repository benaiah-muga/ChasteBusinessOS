import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchProjectBoard,
  fetchProjectMembers,
  fetchProjectsEnabled,
  fetchProjects,
  readPendingProjectActions,
  ProjectsApiError,
  submitProjectAction,
  type BoardColumn,
  type BoardTask,
  type Project,
  type ProjectAction,
  type ProjectActionOutcome,
  type ProjectActionOutput,
  type ProjectMember,
  type PendingProjectAction,
  type ProjectsRetryScope,
} from "../api/projects";
import "./ProjectsPage.css";

type ProjectListState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; projects: Project[] };

type BoardState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; columns: BoardColumn[] };

type ModuleState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; enabled: boolean };

type Notice = { tone: "success" | "pending" | "error"; message: string };
function errorMessage(error: unknown): string {
  if (error instanceof ProjectsApiError) return error.message;
  if (error instanceof DOMException && error.name === "TimeoutError") return "The projects service took too long. Try again.";
  return "Could not reach the projects service. Check your connection and try again.";
}

function isoFromInput(value: string): string | undefined {
  return value ? new Date(`${value}T00:00:00Z`).toISOString() : undefined;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function statusClass(status: string): string {
  if (status === "active") return "project-status-active";
  if (status === "archived") return "project-status-archived";
  return "project-status-other";
}

export function ProjectsPage({ actorId = null, organizationId = null }: Partial<ProjectsRetryScope>) {
  const retryScope = { actorId, organizationId };
  const [moduleState, setModuleState] = useState<ModuleState>({ status: "loading" });
  const [projectState, setProjectState] = useState<ProjectListState>({ status: "loading" });
  const [boardState, setBoardState] = useState<BoardState>({ status: "idle" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingActions, setPendingActions] = useState<PendingProjectAction[]>([]);
  const [projectForm, setProjectForm] = useState({ name: "", due: "" });
  const [taskForm, setTaskForm] = useState({ title: "", assignee: "", due: "", priority: "medium" as "low" | "medium" | "high" });
  const [archiveTarget, setArchiveTarget] = useState<Project | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<string | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const archiveDialogRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const projects = projectState.status === "ready" ? projectState.projects : [];
  const selected = projects.find((project) => project.id === selectedId) ?? null;

  const loadProjects = useCallback(async (signal?: AbortSignal) => {
    if (!signal) setProjectState({ status: "loading" });
    try {
      const rows = await fetchProjects(signal);
      if (signal?.aborted) return;
      setProjectState({ status: "ready", projects: rows });
      setSelectedId((current) => rows.some((project) => project.id === current) ? current : rows[0]?.id ?? null);
    } catch (error) {
      if (signal?.aborted) return;
      setProjectState({ status: "failed", message: errorMessage(error) });
    }
  }, []);

  const loadModules = useCallback(async (signal?: AbortSignal) => {
    if (!signal) setModuleState({ status: "loading" });
    try {
      const enabled = await fetchProjectsEnabled(signal);
      if (signal?.aborted) return;
      setModuleState({ status: "ready", enabled });
      if (enabled) {
        void loadProjects(signal);
        void fetchProjectMembers(signal).then((rows) => {
          if (!signal?.aborted) setMembers(rows);
        }).catch(() => {
          if (!signal?.aborted) setMembers([]);
        });
      } else {
        setProjectState({ status: "ready", projects: [] });
        setSelectedId(null);
        setMembers([]);
      }
    } catch (error) {
      if (signal?.aborted) return;
      setModuleState({ status: "failed", message: errorMessage(error) });
    }
  }, [loadProjects]);

  const loadBoard = useCallback(async (projectId: string, signal?: AbortSignal) => {
    if (selectedIdRef.current !== projectId) return;
    if (!signal) setBoardState({ status: "loading" });
    try {
      const columns = await fetchProjectBoard(projectId, signal);
      if (!signal?.aborted && selectedIdRef.current === projectId) setBoardState({ status: "ready", columns });
    } catch (error) {
      if (signal?.aborted || selectedIdRef.current !== projectId) return;
      setBoardState({ status: "failed", message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadModules(controller.signal);
    return () => controller.abort();
  }, [loadModules]);

  const refreshPendingActions = useCallback(async () => {
    try { setPendingActions(await readPendingProjectActions(retryScope)); }
    catch (error) { setNotice({ tone: "error", message: errorMessage(error) }); }
  }, [actorId, organizationId]);

  useEffect(() => { void refreshPendingActions(); }, [refreshPendingActions]);

  useEffect(() => {
    if (moduleState.status !== "ready" || !moduleState.enabled || !selectedId) {
      setBoardState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setBoardState({ status: "loading" });
    void loadBoard(selectedId, controller.signal);
    return () => controller.abort();
  }, [moduleState, selectedId, loadBoard]);

  useEffect(() => {
    if (!archiveTarget) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    archiveDialogRef.current?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setArchiveTarget(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, [archiveTarget]);

  async function postAction<Action extends ProjectAction>(
    action: Action,
    label: string,
    retry?: PendingProjectAction,
  ): Promise<ProjectActionOutcome<ProjectActionOutput<Action>> | null> {
    if (busy) return null;
    setBusy(true);
    try {
      const result = await submitProjectAction(action, retryScope, retry);
      if (result.kind === "pending") {
        setNotice({ tone: "pending", message: `${label} needs human approval. It is in the Approvals inbox.` });
      } else {
        setNotice({ tone: "success", message: `${label} done.` });
      }
      await refreshPendingActions();
      return result;
    } catch (error) {
      setNotice({ tone: "error", message: errorMessage(error) });
      await refreshPendingActions();
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function retryPendingAction(pending: PendingProjectAction): Promise<void> {
    const action = pending.action;
    const label = action.action === "createProject" ? `Create ${action.name}`
      : action.action === "createTask" ? `Add “${action.title}”`
        : action.action === "archiveProject" ? "Archive project"
          : action.action === "moveTask" ? `Move task to ${action.status}` : "Assign task";
    const result = await postAction(action, label, pending);
    if (result?.kind !== "completed") return;
    if (action.action === "createProject") {
      if (projectForm.name.trim() === action.name && isoFromInput(projectForm.due) === action.dueAt) {
        setProjectForm({ name: "", due: "" });
      }
      await loadProjects();
      if ("projectId" in result.data && typeof result.data.projectId === "string") setSelectedId(result.data.projectId);
    } else if (action.action === "createTask") {
      if (selectedId === action.projectId
        && taskForm.title.trim() === action.title
        && (taskForm.assignee || undefined) === action.assigneeUserId
        && isoFromInput(taskForm.due) === action.dueAt
        && taskForm.priority === (action.priority ?? "medium")) {
        setTaskForm({ title: "", assignee: "", due: "", priority: "medium" });
      }
      await loadBoard(action.projectId);
    } else if (action.action === "archiveProject") {
      setArchiveTarget(null);
      await loadProjects();
    } else if (selectedId) {
      await loadBoard(selectedId);
    }
  }

  async function createProject(): Promise<void> {
    const name = projectForm.name.trim();
    if (!name) {
      setNotice({ tone: "error", message: "Give the project a name." });
      return;
    }
    const result = await postAction({ action: "createProject", name, dueAt: isoFromInput(projectForm.due) }, `Create ${name}`);
    if (result?.kind === "completed") {
      setProjectForm({ name: "", due: "" });
      await loadProjects();
      if ("projectId" in result.data) setSelectedId(result.data.projectId);
    }
  }

  async function createTask(): Promise<void> {
    if (!selectedId) return;
    const title = taskForm.title.trim();
    if (!title) {
      setNotice({ tone: "error", message: "Give the task a title." });
      return;
    }
    const result = await postAction({
      action: "createTask",
      projectId: selectedId,
      title,
      assigneeUserId: taskForm.assignee || undefined,
      dueAt: isoFromInput(taskForm.due),
      priority: taskForm.priority,
    }, `Add “${title}”`);
    if (result?.kind === "completed") {
      setTaskForm({ title: "", assignee: "", due: "", priority: "medium" });
      await loadBoard(selectedId);
    }
  }

  async function moveTask(task: BoardTask, fromStatus: string, status: string): Promise<void> {
    if (selected?.status !== "active" || status === fromStatus || !selectedId || boardState.status !== "ready") return;
    const target = boardState.columns.find((column) => column.status === status);
    const position = target && target.tasks.length > 0
      ? Math.max(...target.tasks.map((entry) => entry.position)) + 1
      : 0;
    const result = await postAction({ action: "moveTask", taskId: task.id, status: status as "todo" | "doing" | "done", position }, `Move “${task.title}” to ${status}`);
    if (result?.kind === "completed") await loadBoard(selectedId);
  }

  function clearDragState(): void {
    setDraggingTaskId(null);
    setOverStatus(null);
  }

  function dropTask(status: string): void {
    if (selected?.status !== "active" || !draggingTaskId || busy || boardState.status !== "ready") return;
    const source = boardState.columns.flatMap((column) => column.tasks).find((task) => task.id === draggingTaskId);
    const fromStatus = boardState.columns.find((column) => column.tasks.some((task) => task.id === draggingTaskId))?.status;
    if (source && fromStatus) void moveTask(source, fromStatus, status);
    clearDragState();
  }

  async function assignTask(task: BoardTask, assigneeUserId: string): Promise<void> {
    if (selected?.status !== "active" || !selectedId) return;
    const who = members.find((member) => member.userId === assigneeUserId)?.name ?? (assigneeUserId ? "a member" : "nobody");
    const result = await postAction({ action: "assignTask", taskId: task.id, assigneeUserId: assigneeUserId || undefined }, `Assign “${task.title}” to ${who}`);
    if (result?.kind === "completed") await loadBoard(selectedId);
  }

  async function archiveProject(): Promise<void> {
    if (!archiveTarget) return;
    const target = archiveTarget;
    const result = await postAction({ action: "archiveProject", projectId: target.id }, `Archive ${target.name}`);
    setArchiveTarget(null);
    if (result?.kind === "completed") await loadProjects();
  }

  const boardColumns = boardState.status === "ready" ? boardState.columns : [];
  const memberName = (userId: string) => members.find((member) => member.userId === userId)?.name ?? "a member";

  if (moduleState.status === "loading") {
    return <main className="projects-page"><p className="projects-loading" role="status">Checking project availability…</p></main>;
  }
  if (moduleState.status === "failed") {
    return (
      <main className="projects-page">
        <section className="projects-error" role="alert" aria-labelledby="projects-module-error-title">
          <div>
            <p className="projects-eyebrow">Workspace settings unavailable</p>
            <h1 id="projects-module-error-title">Could not check project availability</h1>
            <p>{moduleState.message}</p>
          </div>
          <button type="button" onClick={() => void loadModules()}>Try again</button>
        </section>
      </main>
    );
  }
  if (!moduleState.enabled) {
    return (
      <main className="projects-page">
        <section className="projects-disabled" aria-labelledby="projects-disabled-title">
          <span aria-hidden="true">!</span>
          <h1 id="projects-disabled-title">Projects is disabled</h1>
          <p>This module is switched off for your organization. An org admin can re-enable it under Team &amp; roles → Modules.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="projects-page">
      <header className="projects-page-header">
        <div>
          <p className="projects-eyebrow">Workspace</p>
          <h1>Projects</h1>
          <p>Give work a home: projects, a small kanban board, owners, and deadlines.</p>
        </div>
      </header>

      {notice && (
        <div className={`projects-notice projects-notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
          <span>{notice.message}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {pendingActions.length > 0 && (
        <section className="projects-notice projects-notice-pending" aria-label="Unresolved project actions">
          <span>Some project actions have an unresolved result. Retry the exact saved action before submitting it again.</span>
          <ul>
            {pendingActions.map((pending) => (
              <li key={pending.intentId}>
                <button type="button" disabled={busy} onClick={() => void retryPendingAction(pending)}>
                  Retry saved {pending.action.action} action
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {projectState.status === "loading" && <p className="projects-loading" role="status">Loading projects…</p>}
      {projectState.status === "failed" && (
        <section className="projects-error" role="alert" aria-labelledby="projects-error-title">
          <div>
            <p className="projects-eyebrow">Projects unavailable</p>
            <h2 id="projects-error-title">Could not load projects</h2>
            <p>{projectState.message}</p>
          </div>
          <button type="button" onClick={() => void loadProjects()}>Try again</button>
        </section>
      )}

      {projectState.status === "ready" && (
        <div className="projects-layout">
          <aside className="projects-sidebar" aria-label="Projects and project creation">
            <section className="projects-card" aria-labelledby="new-project-heading">
              <header className="projects-card-heading"><h2 id="new-project-heading">New project</h2></header>
              <form className="projects-form projects-form-stack" onSubmit={(event) => { event.preventDefault(); void createProject(); }}>
                <label className="projects-field" htmlFor="project-name">
                  <span>Name</span>
                  <input
                    id="project-name"
                    maxLength={120}
                    placeholder="Q3 website relaunch"
                    value={projectForm.name}
                    onChange={(event) => setProjectForm({ ...projectForm, name: event.currentTarget.value })}
                  />
                </label>
                <label className="projects-field" htmlFor="project-due">
                  <span>Due date <small>(optional)</small></span>
                  <input id="project-due" type="date" value={projectForm.due} onChange={(event) => setProjectForm({ ...projectForm, due: event.currentTarget.value })} />
                </label>
                <button className="projects-primary-button" type="submit" disabled={busy || !projectForm.name.trim()}>
                  {busy ? "Saving…" : "Create project"}
                </button>
              </form>
            </section>

            <section className="projects-card" aria-labelledby="projects-list-heading">
              <header className="projects-card-heading"><h2 id="projects-list-heading">Projects</h2><span>{projects.length}</span></header>
              {projects.length === 0 ? (
                <div className="projects-empty projects-empty-compact">
                  <span aria-hidden="true">□</span>
                  <h3>No projects yet</h3>
                  <p>Create your first project above. Tasks live on its board.</p>
                </div>
              ) : (
                <ul className="projects-list">
                  {projects.map((project) => (
                    <li key={project.id}>
                      <button
                        type="button"
                        aria-pressed={project.id === selectedId}
                        onClick={() => setSelectedId(project.id)}
                        className={`projects-list-button${project.id === selectedId ? " projects-list-button-current" : ""}`}
                      >
                        <span className="projects-list-title"><strong>{project.name}</strong><span className={`project-status ${statusClass(project.status)}`}>{project.status}</span></span>
                        <span className="projects-list-date">{project.dueAt ? `Due ${formatDate(project.dueAt)}` : "No due date"}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>

          <section className="projects-card projects-board-card" aria-labelledby="project-board-heading">
            <header className="projects-card-heading projects-board-heading">
              <h2 id="project-board-heading">{selected ? `Board · ${selected.name}` : "Board"}</h2>
              {selected?.status === "active" && (
                <button className="projects-quiet-button" type="button" disabled={busy} onClick={() => setArchiveTarget(selected)}>
                  Archive project
                </button>
              )}
            </header>

            {!selected ? (
              <div className="projects-empty">
                <span aria-hidden="true">□</span>
                <h3>Select a project</h3>
                <p>Pick a project on the left to see its board.</p>
              </div>
            ) : (
              <>
                {selected.status !== "active" ? <p className="projects-read-only">This project is {selected.status}. Its board is read-only, and new tasks are refused.</p> : (
                  <form className="projects-form projects-task-form" onSubmit={(event) => { event.preventDefault(); void createTask(); }}>
                    <label className="projects-field projects-task-title" htmlFor="task-title">
                      <span>New task</span>
                      <input id="task-title" maxLength={200} placeholder="Draft the launch brief" value={taskForm.title} onChange={(event) => setTaskForm({ ...taskForm, title: event.currentTarget.value })} />
                    </label>
                    <label className="projects-field projects-task-assignee" htmlFor="task-assignee">
                      <span>Assignee</span>
                      <select id="task-assignee" value={taskForm.assignee} onChange={(event) => setTaskForm({ ...taskForm, assignee: event.currentTarget.value })}>
                        <option value="">Unassigned</option>
                        {members.map((member) => <option key={member.userId} value={member.userId}>{member.name ?? member.email}</option>)}
                      </select>
                    </label>
                    <label className="projects-field projects-task-priority" htmlFor="task-priority">
                      <span>Priority</span>
                      <select id="task-priority" value={taskForm.priority} onChange={(event) => setTaskForm({ ...taskForm, priority: event.currentTarget.value as "low" | "medium" | "high" })}>
                        <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
                      </select>
                    </label>
                    <label className="projects-field projects-task-due" htmlFor="task-due">
                      <span>Due <small>(optional)</small></span>
                      <input id="task-due" type="date" value={taskForm.due} onChange={(event) => setTaskForm({ ...taskForm, due: event.currentTarget.value })} />
                    </label>
                    <button className="projects-primary-button projects-add-task" type="submit" disabled={busy || !taskForm.title.trim()}>{busy ? "Saving…" : "Add task"}</button>
                  </form>
                )}

                {boardState.status === "loading" && <p className="projects-loading projects-board-loading" role="status">Loading project board…</p>}
                {boardState.status === "failed" && (
                  <div className="projects-inline-error" role="alert">
                    <span>{boardState.message}</span>
                    <button type="button" onClick={() => void loadBoard(selected.id)}>Try again</button>
                  </div>
                )}
                {boardState.status === "ready" && (
                  <div className="projects-columns">
                    {boardColumns.map((column) => (
                      <section
                        key={column.status}
                        className={`projects-column${overStatus === column.status && draggingTaskId ? " projects-column-drop-target" : ""}`}
                        role="region"
                        aria-label={`${column.status} task column`}
                        onDragOver={(event) => { event.preventDefault(); if (!busy && selected.status === "active") setOverStatus(column.status); }}
                        onDragLeave={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget as Node)) setOverStatus((current) => current === column.status ? null : current);
                        }}
                        onDrop={(event) => { event.preventDefault(); dropTask(column.status); }}
                      >
                        <h3>{column.status}<span>{column.tasks.length}</span></h3>
                        <ul className="projects-task-list">
                          {column.tasks.map((task) => (
                            <li
                              key={task.id}
                              className={`projects-task-card${draggingTaskId === task.id ? " projects-task-card-dragging" : ""}`}
                              draggable={!busy && selected.status === "active"}
                              onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", task.id); setDraggingTaskId(task.id); }}
                              onDragEnd={clearDragState}
                            >
                              <div className="projects-task-heading">
                                <p>{task.parentTaskId && <span className="projects-subtask-marker" aria-label="Subtask">↳ </span>}{task.title}</p>
                                <button className="projects-drag-handle" type="button" draggable={!busy && selected.status === "active"} aria-label={`Drag ${task.title} to another status`} title="Drag to another status">Move</button>
                              </div>
                              <p className="projects-task-meta">
                                <span className={`projects-priority projects-priority-${task.priority}`}>{task.priority}</span>
                                {task.dueAt && <span>Due {formatDate(task.dueAt)}</span>}
                                {task.assigneeUserId && <span className="projects-assignee">♙ {memberName(task.assigneeUserId)}</span>}
                              </p>
                              <div className="projects-task-controls">
                                <label className="sr-only" htmlFor={`move-${task.id}`}>Move {task.title}</label>
                                <select id={`move-${task.id}`} aria-label={`Move ${task.title}`} value={column.status} disabled={busy || selected.status !== "active"} onChange={(event) => void moveTask(task, column.status, event.currentTarget.value)}>
                                  <option value="todo">todo</option><option value="doing">doing</option><option value="done">done</option>
                                </select>
                                <label className="sr-only" htmlFor={`assign-${task.id}`}>Assign {task.title}</label>
                                <select id={`assign-${task.id}`} aria-label={`Assign ${task.title}`} value={task.assigneeUserId ?? ""} disabled={busy || selected.status !== "active"} onChange={(event) => void assignTask(task, event.currentTarget.value)}>
                                  <option value="">Unassigned</option>
                                  {members.map((member) => <option key={member.userId} value={member.userId}>{member.name ?? member.email}</option>)}
                                </select>
                              </div>
                            </li>
                          ))}
                        </ul>
                        {column.tasks.length === 0 && <p className="projects-column-empty">Nothing here</p>}
                      </section>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}

      {archiveTarget && (
        <div className="projects-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setArchiveTarget(null); }}>
          <section ref={archiveDialogRef} className="projects-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-dialog-title" aria-describedby="archive-dialog-description" tabIndex={-1}>
            <p className="projects-eyebrow">Project archive</p>
            <div className="projects-dialog-heading">
              <h2 id="archive-dialog-title">Archive {archiveTarget.name}?</h2>
              <button className="projects-dialog-close" type="button" aria-label="Close dialog" onClick={() => setArchiveTarget(null)}>×</button>
            </div>
            <p id="archive-dialog-description">The project is retired and its board becomes read-only. Nothing is deleted. History stays queryable, and tasks keep their final state.</p>
            <div className="projects-dialog-actions">
              <button className="projects-quiet-button" type="button" disabled={busy} onClick={() => setArchiveTarget(null)}>Cancel</button>
              <button className="projects-danger-button" type="button" disabled={busy} onClick={() => void archiveProject()}>{busy ? "Archiving…" : "Archive project"}</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
