/**
 * Task foundations for the Workflow, Approvals, and Tasks module (research
 * doc §Workflow, Approvals, and Tasks Module, build item 7).
 *
 * A task is a durable, assignable unit of work inside a workflow (or standing
 * alone): status, due date, priority, dependencies, and a blocker reason. The
 * workflow engine owns state transitions (`workflow.completeTask` … later);
 * the kernel owns the task record, its transitions, and the pure work-queue
 * logic that answers "what is ready to work on now?".
 *
 * Dependencies are task ids; `taskBlockers`/`readyTasks` decide readiness from
 * the dependency graph, so work queues never lie about why something is
 * blocked. "Overdue" is derived from `dueAt`, never stored.
 */

export type TaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";

export type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface Task {
  id: string;
  organizationId: string;
  /** Owning workflow run when the task belongs to one; standalone tasks omit it. */
  workflowId?: string;
  title: string;
  description?: string;
  assigneeUserId?: string;
  createdByUserId: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt?: string;
  /** Task ids that must be terminal (completed or cancelled) first. */
  dependsOn: string[];
  /** Why the task is blocked; set when transitioned to `blocked`. */
  blockedReason?: string;
  completedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  organizationId: string;
  workflowId?: string;
  title: string;
  description?: string;
  assigneeUserId?: string;
  createdByUserId: string;
  priority?: TaskPriority;
  dueAt?: string;
  dependsOn?: string[];
  id?: string;
  createdAt?: string;
}

/** Which dependencies are not terminal yet (returns their ids). */
export function taskBlockers(task: Task, tasks: Task[]): string[] {
  if (task.status === "completed" || task.status === "cancelled") return [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.dependsOn.filter((depId) => {
    const dep = byId.get(depId);
    return !dep || (dep.status !== "completed" && dep.status !== "cancelled");
  });
}

/** Pure transition: can this task move to a target status given its deps? */
export function canTransition(
  task: Task,
  to: TaskStatus,
  tasks: Task[],
): { ok: true } | { ok: false; reason: string } {
  if (task.status === "completed" || task.status === "cancelled") {
    return { ok: false, reason: `task is already ${task.status}` };
  }
  if (to === "completed" || to === "in_progress") {
    const blockers = taskBlockers(task, tasks);
    if (blockers.length > 0) {
      return { ok: false, reason: `blocked by ${blockers.join(", ")}` };
    }
  }
  return { ok: true };
}

/**
 * The work queue: pending tasks (not yet started) with no blockers, ordered
 * by due date (soonest first, no-due last), then priority, then creation
 * time. In-progress tasks are already being worked and are not "ready".
 */
export function readyTasks(tasks: Task[]): Task[] {
  const ready = tasks.filter((t) => {
    if (t.status !== "pending") return false;
    return taskBlockers(t, tasks).length === 0;
  });
  const priorityRank: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
  return ready.sort((a, b) => {
    if (a.dueAt && b.dueAt && a.dueAt !== b.dueAt) return a.dueAt.localeCompare(b.dueAt);
    if (a.dueAt && !b.dueAt) return -1;
    if (!a.dueAt && b.dueAt) return 1;
    if (a.priority !== b.priority) return priorityRank[a.priority] - priorityRank[b.priority];
    return a.createdAt.localeCompare(b.createdAt);
  });
}

export interface TaskFilter {
  organizationId: string;
  workflowId?: string;
  assigneeUserId?: string;
  status?: TaskStatus;
}

export type TaskTransition =
  | { ok: true; task: Task }
  | { ok: false; reason: string };

export interface TaskStore {
  create(input: CreateTaskInput): Promise<Task>;
  get(organizationId: string, id: string): Promise<Task | undefined>;
  /**
   * Transition a task's status. `to` may be `pending`, `in_progress`,
   * `blocked`, `completed`, or `cancelled`. Completing/starting enforces
   * dependency readiness; the blocker reason is recorded when entering
   * `blocked`. Transitions are once-only on final states.
   */
  transition(
    organizationId: string,
    id: string,
    to: TaskStatus,
    opts?: { by?: string; reason?: string; now?: () => Date },
  ): Promise<TaskTransition>;
  list(filter: TaskFilter): Promise<Task[]>;
  /** Ready-to-work tasks (see `readyTasks`). */
  workQueue(organizationId: string): Promise<Task[]>;
}

/** In-memory task store (tests, dev, single-process hosts). */
export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async create(input: CreateTaskInput): Promise<Task> {
    const now = this.now().toISOString();
    const record: Task = {
      id: input.id ?? crypto.randomUUID(),
      organizationId: input.organizationId,
      workflowId: input.workflowId,
      title: input.title,
      description: input.description,
      assigneeUserId: input.assigneeUserId,
      createdByUserId: input.createdByUserId,
      status: "pending",
      priority: input.priority ?? "normal",
      dueAt: input.dueAt,
      dependsOn: input.dependsOn ?? [],
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    this.tasks.set(record.id, record);
    return record;
  }

  async get(organizationId: string, id: string): Promise<Task | undefined> {
    const record = this.tasks.get(id);
    return record && record.organizationId === organizationId ? record : undefined;
  }

  async transition(
    organizationId: string,
    id: string,
    to: TaskStatus,
    opts: { by?: string; reason?: string; now?: () => Date } = {},
  ): Promise<TaskTransition> {
    const task = this.tasks.get(id);
    if (!task || task.organizationId !== organizationId) {
      return { ok: false, reason: "task not found" };
    }
    const all = [...this.tasks.values()].filter((t) => t.organizationId === organizationId);
    const gate = canTransition(task, to, all);
    if (!gate.ok) return gate;

    const at = (opts.now?.() ?? this.now()).toISOString();
    task.status = to;
    task.updatedAt = at;
    if (to === "blocked") task.blockedReason = opts.reason;
    if (to !== "blocked") delete task.blockedReason;
    if (to === "completed") task.completedAt = at;
    if (to === "cancelled") task.cancelledAt = at;
    return { ok: true, task };
  }

  async list(filter: TaskFilter): Promise<Task[]> {
    const out: Task[] = [];
    for (const t of this.tasks.values()) {
      if (t.organizationId !== filter.organizationId) continue;
      if (filter.workflowId !== undefined && t.workflowId !== filter.workflowId) continue;
      if (filter.assigneeUserId !== undefined && t.assigneeUserId !== filter.assigneeUserId) continue;
      if (filter.status !== undefined && t.status !== filter.status) continue;
      out.push(t);
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async workQueue(organizationId: string): Promise<Task[]> {
    return readyTasks(await this.list({ organizationId }));
  }
}