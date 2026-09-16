"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardTitle, EmptyState, type ActionNoticeState } from "@/components/ui";
import { IconListTree } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { formatDate } from "@/lib/format";

interface TaskRow {
  id: string;
  title: string;
  dueAt: string | null;
  doneAt: string | null;
  refType: string | null;
  refId: string | null;
}
interface Member {
  userId: string;
  name: string | null;
  email: string;
}
type Notice = (n: ActionNoticeState | null) => void;

const emptyForm = { title: "", dueAt: "", assigneeUserId: "", note: "" };

export function TasksTab({ notice }: { notice: Notice }) {
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [showDone, setShowDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await callApi<{ tasks?: TaskRow[] }>("/api/crm?tasks=1");
    setTasks(res.ok ? res.data?.tasks ?? [] : []);
    if (!res.ok && res.error) notice({ tone: "error", error: res.error });
  }, [notice]);

  useEffect(() => {
    void load();
    void callApi<{ members?: Member[] }>("/api/team").then((res) => {
      if (res.ok && res.data) setMembers(res.data.members ?? []);
    });
  }, [load]);

  async function create(): Promise<void> {
    if (!form.title.trim()) return;
    setBusy(true);
    try {
      const res = await postApi("/api/crm", {
        action: "createTask",
        title: form.title.trim(),
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined,
        assigneeUserId: form.assigneeUserId || undefined,
        note: form.note.trim() || undefined,
      });
      if (res.status === 202) notice({ tone: "pending", text: "Creating the task needs approval." });
      else if (!res.ok && res.error) notice({ tone: "error", error: res.error });
      else {
        setForm(emptyForm);
        notice({ tone: "success", text: "Task created." });
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function complete(task: TaskRow): Promise<void> {
    setBusy(true);
    try {
      const res = await postApi("/api/crm", { action: "completeTask", taskId: task.id });
      if (res.status === 202) notice({ tone: "pending", text: "Completing the task needs approval." });
      else if (!res.ok && res.error) notice({ tone: "error", error: res.error });
      else await load();
    } finally {
      setBusy(false);
    }
  }

  const open = (tasks ?? []).filter((t) => !t.doneAt);
  const done = (tasks ?? []).filter((t) => t.doneAt);
  const visible = showDone ? [...open, ...done] : open;
  const memberName = new Map(members.map((m) => [m.userId, m.name ?? m.email]));
  const nowIso = Date.now();

  return (
    <>
      <Card>
        <CardTitle>New follow-up task</CardTitle>
        <form
          className="flex flex-wrap items-end gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="min-w-44 flex-1">
            <label htmlFor="task-title" className="label">
              What needs doing
            </label>
            <input
              id="task-title"
              className="input"
              placeholder="e.g. Send the revised proposal"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="task-due" className="label">
              Due <span className="opacity-50">(optional)</span>
            </label>
            <input
              id="task-due"
              type="datetime-local"
              className="input"
              value={form.dueAt}
              onChange={(e) => setForm({ ...form, dueAt: e.target.value })}
            />
          </div>
          <div className="min-w-40">
            <label htmlFor="task-assignee" className="label">
              Assignee <span className="opacity-50">(optional)</span>
            </label>
            <select
              id="task-assignee"
              className="select"
              value={form.assigneeUserId}
              onChange={(e) => setForm({ ...form, assigneeUserId: e.target.value })}
            >
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {memberName.get(m.userId)}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-40 flex-1">
            <label htmlFor="task-note" className="label">
              Note <span className="opacity-50">(optional)</span>
            </label>
            <input
              id="task-note"
              className="input"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </div>
          <Button type="submit" loading={busy} disabled={!form.title.trim()}>
            Add task
          </Button>
        </form>
      </Card>

      <Card>
        <CardTitle
          right={
            <Button tone="ghost" size="sm" onClick={() => setShowDone(!showDone)}>
              {showDone ? "Hide done" : "Show done"}
            </Button>
          }
        >
          {showDone ? "All tasks" : "Open tasks"}
        </CardTitle>
        {tasks === null ? (
          <p className="text-sm text-stone-400">Loading…</p>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<IconListTree />}
            title={showDone ? "No tasks yet" : "Nothing open"}
            hint="Follow-ups keep promises to customers from quietly evaporating; overdue ones surface as signals."
          />
        ) : (
          <ul className="divide-y text-sm">
            {visible.map((t) => {
              const overdue = !t.doneAt && t.dueAt !== null && new Date(t.dueAt).getTime() < nowIso;
              return (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2.5">
                  <span className="min-w-0">
                    <span className={t.doneAt ? "text-stone-400 line-through" : "font-medium text-stone-800"}>{t.title}</span>
                    {t.dueAt && (
                      <span className={overdue ? "ml-2 text-xs font-medium text-red-700" : "ml-2 text-xs text-stone-500"}>
                        due {formatDate(t.dueAt)}
                      </span>
                    )}
                    {t.doneAt && <span className="ml-2 text-xs text-stone-400">done {formatDate(t.doneAt)}</span>}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {overdue && <Badge tone="red">overdue</Badge>}
                    {!t.doneAt && (
                      <Button size="sm" tone="secondary" disabled={busy} onClick={() => void complete(t)}>
                        Done
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
