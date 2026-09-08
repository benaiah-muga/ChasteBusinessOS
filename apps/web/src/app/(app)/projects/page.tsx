"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ActionNotice,
  Badge,
  Button,
  Card,
  CardTitle,
  ConfirmDialog,
  EmptyState,
  LoadingPage,
  type ActionNoticeState,
} from "@/components/ui";
import { IconCalendar, IconInbox, IconPlus, IconUsers } from "@/components/icons";
import { cn, formatDate, statusTone } from "@/lib/format";
import { callApi, postApi } from "@/lib/api";
import { ModuleDisabled, useModuleEnabled } from "../_shell/module-context";
import { AppFrame } from "../_shell/app-frame";

interface Project {
  id: string;
  name: string;
  status: string;
  dueAt: string | null;
  createdAt: string;
}

interface BoardTask {
  id: string;
  title: string;
  parentTaskId: string | null;
  priority: string;
  assigneeUserId: string | null;
  dueAt: string | null;
  position: number;
}

/** Column/status shapes mirror projects.listBoard's output (todo | doing | done). */
interface BoardColumn {
  status: string;
  tasks: BoardTask[];
}

interface Member {
  userId: string;
  name: string | null;
  email: string;
}

/** `date` inputs yield YYYY-MM-DD; the capabilities want full ISO datetimes. */
function isoFromInput(value: string): string | undefined {
  return value ? new Date(`${value}T00:00:00Z`).toISOString() : undefined;
}

export default function ProjectsPage() {
  const __enabled = useModuleEnabled("projects");
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [notice, setNotice] = useState<ActionNoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [projectForm, setProjectForm] = useState({ name: "", due: "" });
  const [taskForm, setTaskForm] = useState({ title: "", assignee: "", due: "", priority: "medium" });
  const [archiveTarget, setArchiveTarget] = useState<Project | null>(null);

  const selected = projects?.find((p) => p.id === selectedId) ?? null;

  const loadProjects = useCallback(async (): Promise<Project[]> => {
    const res = await callApi<{ projects?: Project[] }>("/api/projects");
    if (!res.ok) setNotice({ tone: "error", error: res.error! });
    const rows = res.data?.projects ?? [];
    setProjects(rows);
    return rows;
  }, []);

  const loadBoard = useCallback(async (projectId: string) => {
    const res = await callApi<{ columns?: BoardColumn[] }>(`/api/projects?projectId=${encodeURIComponent(projectId)}`);
    if (!res.ok || !res.data) {
      setNotice({ tone: "error", error: res.error! });
      setColumns([]);
      return;
    }
    setColumns(res.data.columns ?? []);
  }, []);

  useEffect(() => {
    if (!__enabled) return;
    void loadProjects().then((rows) => {
      if (rows.length > 0) setSelectedId((current) => current ?? rows[0]!.id);
    });
    // Assignee picker degrades quietly when iam.read isn't granted.
    void callApi<{ members?: Member[] }>("/api/team").then((res) => setMembers(res.data?.members ?? []));
  }, [__enabled, loadProjects]);

  useEffect(() => {
    if (selectedId) void loadBoard(selectedId);
  }, [selectedId, loadBoard]);

  async function post<T>(payload: Record<string, unknown>, label: string): Promise<T | null> {
    setBusy(true);
    try {
      const res = await postApi<{ data?: T }>("/api/projects", payload);
      if (res.status === 202) {
        setNotice({ tone: "pending", text: `${label} needs human approval — it's in the Approvals inbox.` });
      } else if (!res.ok) {
        setNotice({ tone: "error", error: res.error! });
      } else {
        setNotice({ tone: "success", text: `${label} done.` });
      }
      router.refresh();
      return res.ok ? (res.data?.data ?? null) : null;
    } finally {
      setBusy(false);
    }
  }

  async function createProject(): Promise<void> {
    const name = projectForm.name.trim();
    if (!name) {
      setNotice({ tone: "error", error: { title: "Missing details", hint: "Give the project a name." } });
      return;
    }
    const created = await post<{ projectId: string }>(
      { action: "createProject", name, dueAt: isoFromInput(projectForm.due) },
      `Create ${name}`,
    );
    if (created) {
      setProjectForm({ name: "", due: "" });
      await loadProjects();
      setSelectedId(created.projectId);
    }
  }

  async function createTask(): Promise<void> {
    if (!selectedId) return;
    const title = taskForm.title.trim();
    if (!title) {
      setNotice({ tone: "error", error: { title: "Missing details", hint: "Give the task a title." } });
      return;
    }
    const created = await post<{ taskId: string }>(
      {
        action: "createTask",
        projectId: selectedId,
        title,
        assigneeUserId: taskForm.assignee || undefined,
        dueAt: isoFromInput(taskForm.due),
        priority: taskForm.priority,
      },
      `Add “${title}”`,
    );
    if (created) {
      setTaskForm({ title: "", assignee: "", due: "", priority: "medium" });
      await loadBoard(selectedId);
    }
  }

  async function moveTask(task: BoardTask, fromStatus: string, status: string): Promise<void> {
    if (status === fromStatus || !selectedId) return;
    const target = columns.find((c) => c.status === status);
    const position = target && target.tasks.length > 0 ? Math.max(...target.tasks.map((t) => t.position)) + 1 : 0;
    const ok = await post({ action: "moveTask", taskId: task.id, status, position }, `Move “${task.title}” to ${status}`);
    if (ok) await loadBoard(selectedId);
  }

  async function assignTask(task: BoardTask, assigneeUserId: string): Promise<void> {
    if (!selectedId) return;
    const who = members.find((m) => m.userId === assigneeUserId)?.name ?? (assigneeUserId ? "a member" : "nobody");
    const ok = await post(
      { action: "assignTask", taskId: task.id, assigneeUserId: assigneeUserId || undefined },
      `Assign “${task.title}” to ${who}`,
    );
    if (ok) await loadBoard(selectedId);
  }

  async function archiveProject(): Promise<void> {
    if (!archiveTarget) return;
    const ok = await post({ action: "archiveProject", projectId: archiveTarget.id }, `Archive ${archiveTarget.name}`);
    setArchiveTarget(null);
    if (ok) await loadProjects();
  }

  if (!__enabled) return <ModuleDisabled label="Projects" />;

  const memberName = (userId: string) => members.find((m) => m.userId === userId)?.name ?? "a member";

  return (
    <AppFrame appId="projects" description="Give work a home: projects, a small kanban board, owners, and deadlines.">
      {notice && <ActionNotice state={notice} onDismiss={() => setNotice(null)} />}

      {projects === null ? (
        <LoadingPage />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">

          <div className="space-y-4">
            <Card>
              <CardTitle>New project</CardTitle>
              <form
                className="space-y-2 text-sm"
                onSubmit={(e) => {
                  e.preventDefault();
                  void createProject();
                }}
              >
                <div>
                  <label htmlFor="project-name" className="label">
                    Name
                  </label>
                  <input
                    id="project-name"
                    className="input"
                    placeholder="Q3 website relaunch"
                    value={projectForm.name}
                    onChange={(e) => setProjectForm({ ...projectForm, name: e.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="project-due" className="label">
                    Due date <span className="opacity-50">(optional)</span>
                  </label>
                  <input
                    id="project-due"
                    type="date"
                    className="input"
                    value={projectForm.due}
                    onChange={(e) => setProjectForm({ ...projectForm, due: e.target.value })}
                  />
                </div>
                <Button type="submit" loading={busy} disabled={!projectForm.name.trim()}>
                  <span className="flex items-center gap-1.5">
                    <IconPlus className="size-4" /> Create project
                  </span>
                </Button>
              </form>
            </Card>

            <Card>
              <CardTitle>Projects</CardTitle>
              {projects.length === 0 ? (
                <EmptyState
                  icon={<IconInbox />}
                  title="No projects yet"
                  hint="Create your first project above — tasks live on its board."
                />
              ) : (
                <ul className="space-y-1.5">
                  {projects.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        aria-pressed={p.id === selectedId}
                        onClick={() => setSelectedId(p.id)}
                        className={cn(
                          "w-full rounded-lg border px-3 py-2 text-left text-sm transition",
                          p.id === selectedId
                            ? "border-maroon-300 bg-maroon-50/60"
                            : "border-stone-200 hover:border-stone-300 hover:bg-stone-50",
                        )}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium text-stone-900">{p.name}</span>
                          <Badge tone={statusTone(p.status)}>{p.status}</Badge>
                        </span>
                        <span className="mt-0.5 flex items-center gap-1 text-xs text-stone-400">
                          <IconCalendar className="size-3.5" />
                          {p.dueAt ? `Due ${formatDate(p.dueAt)}` : "No due date"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card>
            <CardTitle
              right={
                selected && selected.status === "active" ? (
                  <Button size="sm" tone="ghost" disabled={busy} onClick={() => setArchiveTarget(selected)}>
                    Archive project
                  </Button>
                ) : undefined
              }
            >
              {selected ? `Board · ${selected.name}` : "Board"}
            </CardTitle>

            {!selected ? (
              <EmptyState icon={<IconInbox />} title="Select a project" hint="Pick a project on the left to see its board." />
            ) : (
              <>
                {selected.status !== "active" ? (
                  <p className="text-sm text-stone-500">
                    This project is {selected.status} — its board is read-only, and new tasks are refused.
                  </p>
                ) : (
                  <form
                    className="flex flex-wrap items-end gap-2 text-sm"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void createTask();
                    }}
                  >
                    <div className="min-w-44 flex-1">
                      <label htmlFor="task-title" className="label">
                        New task
                      </label>
                      <input
                        id="task-title"
                        className="input"
                        placeholder="Draft the launch brief"
                        value={taskForm.title}
                        onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })}
                      />
                    </div>
                    <div className="w-40">
                      <label htmlFor="task-assignee" className="label">
                        Assignee
                      </label>
                      <select
                        id="task-assignee"
                        className="select"
                        value={taskForm.assignee}
                        onChange={(e) => setTaskForm({ ...taskForm, assignee: e.target.value })}
                      >
                        <option value="">Unassigned</option>
                        {members.map((m) => (
                          <option key={m.userId} value={m.userId}>
                            {m.name ?? m.email}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="w-32">
                      <label htmlFor="task-priority" className="label">
                        Priority
                      </label>
                      <select
                        id="task-priority"
                        className="select"
                        value={taskForm.priority}
                        onChange={(e) => setTaskForm({ ...taskForm, priority: e.target.value })}
                      >
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                      </select>
                    </div>
                    <div className="w-36">
                      <label htmlFor="task-due" className="label">
                        Due <span className="opacity-50">(optional)</span>
                      </label>
                      <input
                        id="task-due"
                        type="date"
                        className="input"
                        value={taskForm.due}
                        onChange={(e) => setTaskForm({ ...taskForm, due: e.target.value })}
                      />
                    </div>
                    <Button type="submit" loading={busy} disabled={!taskForm.title.trim()}>
                      Add task
                    </Button>
                  </form>
                )}

                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  {columns.map((col) => (
                    <div key={col.status} className="rounded-lg bg-stone-50 p-2.5">
                      <p className="mb-2 text-xs font-semibold tracking-wide text-stone-400 uppercase">
                        {col.status} · {col.tasks.length}
                      </p>
                      <ul className="space-y-2">
                        {col.tasks.map((t) => (
                          <li key={t.id} className="rounded-lg border border-stone-200 bg-white p-2.5 text-sm">
                            <p className="font-medium text-stone-900">
                              {t.parentTaskId && <span className="text-stone-400">↳ </span>}
                              {t.title}
                            </p>
                            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-stone-400">
                              <Badge tone={t.priority === "high" ? "red" : t.priority === "low" ? "neutral" : "amber"}>
                                {t.priority}
                              </Badge>
                              {t.dueAt && <span>Due {formatDate(t.dueAt)}</span>}
                              {t.assigneeUserId && (
                                <span className="flex items-center gap-1">
                                  <IconUsers className="size-3.5" />
                                  {memberName(t.assigneeUserId)}
                                </span>
                              )}
                            </p>
                            <div className="mt-2 flex items-center gap-1.5">
                              <label className="sr-only" htmlFor={`move-${t.id}`}>
                                Move {t.title}
                              </label>
                              <select
                                id={`move-${t.id}`}
                                className="select flex-1 text-xs"
                                value={col.status}
                                disabled={busy}
                                onChange={(e) => void moveTask(t, col.status, e.target.value)}
                              >
                                <option value="todo">todo</option>
                                <option value="doing">doing</option>
                                <option value="done">done</option>
                              </select>
                              <label className="sr-only" htmlFor={`assign-${t.id}`}>
                                Assign {t.title}
                              </label>
                              <select
                                id={`assign-${t.id}`}
                                className="select flex-1 text-xs"
                                value={t.assigneeUserId ?? ""}
                                disabled={busy}
                                onChange={(e) => void assignTask(t, e.target.value)}
                              >
                                <option value="">Unassigned</option>
                                {members.map((m) => (
                                  <option key={m.userId} value={m.userId}>
                                    {m.name ?? m.email}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </li>
                        ))}
                      </ul>
                      {col.tasks.length === 0 && <p className="py-3 text-center text-xs text-stone-300">Nothing here</p>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={archiveTarget !== null}
        onClose={() => setArchiveTarget(null)}
        onConfirm={() => void archiveProject()}
        title={`Archive ${archiveTarget?.name ?? ""}?`}
        body="The project is retired and its board becomes read-only. Nothing is deleted — history stays queryable, and tasks keep their final state."
        confirmLabel="Archive project"
        busy={busy}
      />
    </AppFrame>
  );
}

