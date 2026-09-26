"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardTitle, EmptyState, type ActionNoticeState } from "@/components/ui";
import { IconListTree } from "@/components/icons";
import { callApi, postApi } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";

interface CustomerRow {
  id: string;
  name: string;
  email: string | null;
  lastActivityAt: string;
  deactivatedAt: string | null;
}
interface TaskRow {
  id: string;
  title: string;
  dueAt: string | null;
  doneAt: string | null;
  refType: string | null;
  refId: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  customerName: string | null;
}
interface Member {
  userId: string;
  name: string | null;
  email: string;
}
type QueueView = "today" | "overdue" | "unassigned" | "no_contact" | "all";
type Notice = (notice: ActionNoticeState | null) => void;

const emptyForm = { title: "", dueAt: "", assigneeUserId: "", note: "" };

export function FollowUpQueue({ notice, customers, focusedTaskId }: { notice: Notice; customers: CustomerRow[]; focusedTaskId?: string | null }) {
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [linkedCustomerId, setLinkedCustomerId] = useState<string | null>(null);
  const [view, setView] = useState<QueueView>("today");
  const [showDone, setShowDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await callApi<{ tasks?: TaskRow[] }>("/api/crm?tasks=1");
    if (response.ok) setTasks(response.data?.tasks ?? []);
    else {
      setTasks([]);
      if (response.error) notice({ tone: "error", error: response.error });
    }
  }, [notice]);

  useEffect(() => {
    void load();
    void callApi<{ members?: Member[] }>("/api/team").then((response) => {
      if (response.ok) setMembers(response.data?.members ?? []);
    });
  }, [load]);

  useEffect(() => {
    if (focusedTaskId) setView("all");
  }, [focusedTaskId]);

  useEffect(() => {
    if (!focusedTaskId || !tasks || view !== "all" || !tasks.some((task) => task.id === focusedTaskId)) return;
    const timeout = window.setTimeout(() => {
      document.getElementById(`crm-task-${focusedTaskId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [focusedTaskId, tasks, view]);

  const openTasks = useMemo(() => (tasks ?? []).filter((task) => !task.doneAt), [tasks]);
  const doneTasks = useMemo(() => (tasks ?? []).filter((task) => Boolean(task.doneAt)), [tasks]);
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const tomorrow = new Date(todayStart);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const overdueCount = openTasks.filter((task) => task.dueAt && new Date(task.dueAt) < todayStart).length;
  const dueTodayCount = openTasks.filter((task) => task.dueAt && new Date(task.dueAt) >= todayStart && new Date(task.dueAt) < tomorrow).length;
  const unassignedCount = openTasks.filter((task) => !task.assigneeUserId).length;
  const staleCustomers = customers.filter((customer) => Date.now() - new Date(customer.lastActivityAt).getTime() >= 30 * 86400000);
  const visibleTasks = (showDone ? [...openTasks, ...doneTasks] : openTasks).filter((task) => {
    if (view === "today") return Boolean(task.dueAt && new Date(task.dueAt) >= todayStart && new Date(task.dueAt) < tomorrow);
    if (view === "overdue") return Boolean(task.dueAt && new Date(task.dueAt) < todayStart);
    if (view === "unassigned") return !task.assigneeUserId;
    return view === "all";
  });

  async function create(): Promise<void> {
    if (!form.title.trim()) return;
    setBusy(true);
    try {
      const response = await postApi("/api/crm", {
        action: "createTask",
        title: form.title.trim(),
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined,
        assigneeUserId: form.assigneeUserId || undefined,
        note: form.note.trim() || undefined,
        ...(linkedCustomerId ? { refType: "customer", refId: linkedCustomerId } : {}),
      });
      if (response.status === 202) notice({ tone: "pending", text: "Creating this follow-up is waiting for approval." });
      else if (!response.ok && response.error) notice({ tone: "error", error: response.error });
      else {
        notice({ tone: "success", text: "Follow-up added to the queue." });
        setForm(emptyForm);
        setLinkedCustomerId(null);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function update(task: TaskRow, details: { dueAt?: string | null; assigneeUserId?: string | null }, success: string): Promise<void> {
    setBusy(true);
    try {
      const response = await postApi("/api/crm", { action: "updateTaskDetails", taskId: task.id, ...details });
      if (response.status === 202) notice({ tone: "pending", text: "This follow-up update needs approval." });
      else if (!response.ok && response.error) notice({ tone: "error", error: response.error });
      else notice({ tone: "success", text: success });
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function complete(task: TaskRow): Promise<void> {
    setBusy(true);
    try {
      const response = await postApi("/api/crm", { action: "completeTask", taskId: task.id });
      if (response.status === 202) notice({ tone: "pending", text: "Completing this follow-up needs approval." });
      else if (!response.ok && response.error) notice({ tone: "error", error: response.error });
      else notice({ tone: "success", text: "Follow-up completed." });
      await load();
    } finally {
      setBusy(false);
    }
  }

  function startCustomerFollowUp(customer: CustomerRow): void {
    setLinkedCustomerId(customer.id);
    setForm((current) => ({ ...current, title: `Follow up with ${customer.name}` }));
    setView("all");
    requestAnimationFrame(() => document.getElementById("task-title")?.focus());
  }

  const views: Array<{ id: QueueView; label: string; count: number }> = [
    { id: "today", label: "Due today", count: dueTodayCount },
    { id: "overdue", label: "Overdue", count: overdueCount },
    { id: "unassigned", label: "Unassigned", count: unassignedCount },
    { id: "no_contact", label: "No recent contact", count: staleCustomers.length },
    { id: "all", label: "All open", count: openTasks.length },
  ];

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>New follow-up</CardTitle>
        {linkedCustomerId && <div className="mb-2 flex items-center justify-between rounded-md bg-gold-50 px-3 py-2 text-xs text-gold-950"><span>Linked to {customers.find((customer) => customer.id === linkedCustomerId)?.name}</span><button type="button" className="underline" onClick={() => setLinkedCustomerId(null)}>Remove link</button></div>}
        <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <label className="label sm:col-span-2">What needs doing<input id="task-title" className="input mt-1" placeholder="e.g. Call about the proposal" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} maxLength={200} required /></label>
          <label className="label">Due date<input type="datetime-local" className="input mt-1" value={form.dueAt} onChange={(event) => setForm({ ...form, dueAt: event.target.value })} /></label>
          <label className="label">Assign to<select className="select mt-1" value={form.assigneeUserId} onChange={(event) => setForm({ ...form, assigneeUserId: event.target.value })}><option value="">Unassigned</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.name || member.email}</option>)}</select></label>
          <label className="label sm:col-span-3">Context<input className="input mt-1" placeholder="Optional details for whoever picks this up" value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} maxLength={2000} /></label>
          <Button type="submit" className="min-h-10 self-end" loading={busy} disabled={!form.title.trim()}>Add follow-up</Button>
        </form>
      </Card>

      <Card>
        <CardTitle right={<Button tone="ghost" size="sm" onClick={() => setShowDone((value) => !value)}>{showDone ? "Hide completed" : "Show completed"}</Button>}>Follow-up queue</CardTitle>
        <div className="scrollbar-hidden -mx-4 mb-3 flex gap-1 overflow-x-auto px-4 pb-1" role="tablist" aria-label="Follow-up views">
          {views.map((queueView) => <button key={queueView.id} type="button" role="tab" aria-selected={view === queueView.id} onClick={() => setView(queueView.id)} className={`shrink-0 rounded-full border px-3 py-2 text-xs font-medium ${view === queueView.id ? "border-gold-400 bg-gold-50 text-stone-900" : "border-stone-200 bg-white text-stone-600"}`}>{queueView.label}<span className="ml-1.5 text-stone-400">{queueView.count}</span></button>)}
        </div>

        {view === "no_contact" ? (
          staleCustomers.length === 0 ? <EmptyState icon={<IconListTree />} title="Everyone has recent activity" hint="Customers with no recorded activity for 30 days will show up here." /> :
            <ul className="divide-y divide-stone-100">{staleCustomers.map((customer) => <li key={customer.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-stone-800">{customer.name}</p><p className="mt-0.5 text-xs text-stone-500">Last activity {timeAgo(customer.lastActivityAt)}{customer.email ? ` · ${customer.email}` : ""}</p></div><Button size="sm" tone="secondary" onClick={() => startCustomerFollowUp(customer)}>Create follow-up</Button></li>)}</ul>
        ) : tasks === null ? <p className="py-5 text-sm text-stone-500" role="status">Loading follow-ups…</p> : visibleTasks.length === 0 ? (
          <EmptyState icon={<IconListTree />} title={showDone ? "No matching follow-ups" : view === "today" ? "Nothing due today" : view === "overdue" ? "No overdue follow-ups" : view === "unassigned" ? "Every open follow-up has an owner" : "No open follow-ups"} hint={view === "today" ? "Set a due date when creating a follow-up to make it appear in today's queue." : "When a customer needs attention, add a follow-up so the next action is clear."} />
        ) : (
          <ul className="divide-y divide-stone-100">
            {visibleTasks.map((task) => {
              const overdue = !task.doneAt && Boolean(task.dueAt && new Date(task.dueAt) < todayStart);
              const nextDay = new Date(); nextDay.setDate(nextDay.getDate() + 1); nextDay.setHours(9, 0, 0, 0);
              return <li id={`crm-task-${task.id}`} key={task.id} aria-current={focusedTaskId === task.id ? "true" : undefined} className={`flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between ${focusedTaskId === task.id ? "rounded-lg bg-gold-50/80 px-2 ring-1 ring-gold-300" : ""}`}>
                <div className="min-w-0"><p className={task.doneAt ? "text-sm text-stone-400 line-through" : "text-sm font-medium text-stone-800"}>{task.title}</p><p className="mt-0.5 text-xs text-stone-500">{task.customerName ? `${task.customerName} · ` : task.refType ? `${task.refType} · ` : ""}{task.dueAt ? `Due ${formatDate(task.dueAt)}` : "No due date"}{task.assigneeName ? ` · ${task.assigneeName}` : " · Unassigned"}</p></div>
                <div className="flex flex-wrap items-center gap-2">
                  {overdue && <Badge tone="red">Overdue</Badge>}
                  {!task.doneAt && <select className="select h-9 w-full sm:w-40" aria-label={`Assign ${task.title}`} value={task.assigneeUserId ?? ""} disabled={busy} onChange={(event) => void update(task, { assigneeUserId: event.target.value || null }, "Follow-up owner updated.")}><option value="">Unassigned</option>{members.map((member) => <option key={member.userId} value={member.userId}>{member.name || member.email}</option>)}</select>}
                  {!task.doneAt && <Button size="sm" tone="ghost" disabled={busy} onClick={() => void update(task, { dueAt: nextDay.toISOString() }, "Follow-up snoozed until tomorrow at 9:00.")}>Snooze 1 day</Button>}
                  {!task.doneAt && <Button size="sm" tone="secondary" disabled={busy} onClick={() => void complete(task)}>Complete</Button>}
                </div>
              </li>;
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
