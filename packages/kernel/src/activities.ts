/**
 * Durable activities (research doc §Proactive Scheduling, Reminders, and
 * Activities Module, build item 7).
 *
 * An activity is the unit of the agent acting like a reliable business
 * coordinator: a follow-up, review, reminder, task, or notification with an
 * assignee, due date, optional recurrence, and a link to the business record
 * it is about. "Overdue" is always derived (`isOverdue`), never stored.
 *
 * Like approval grants, the model + in-memory store live in the kernel and a
 * Postgres-backed store over the `activities` table lives in `@chaste/runtime`,
 * so callers swap stores freely. The `activities.*`/`core.reminder.*`
 * command/query surface is layered on top by the scheduling module.
 */

export type ActivityKind =
  | "reminder"
  | "follow_up"
  | "review"
  | "task"
  | "notification";

export type ActivityStatus = "scheduled" | "completed" | "cancelled";

/** Which business record an activity is about (CRM customer, invoice, PO, …). */
export interface ActivityLink {
  resourceType: string;
  resourceId: string;
}

/**
 * Recurrence in UTC. `freq` + `interval` mean "every `interval` {daily|weekly|
 * monthly}", `daysOfWeek` narrows weekly recurrence to specific weekdays
 * (0=Sunday … 6=Saturday), and `at` pins the local trigger time as
 * `HH:MM`. Full timezone/local-calendar handling is the scheduling module's
 * later job; foundations compute deterministic UTC next-occurrences.
 */
export interface RecurrenceRule {
  freq: "daily" | "weekly" | "monthly";
  interval?: number;
  daysOfWeek?: number[];
  at?: string;
}

export interface Activity {
  id: string;
  organizationId: string;
  kind: ActivityKind;
  title: string;
  body?: string;
  /** Who is responsible for acting; agents may be the assignee. */
  assigneeUserId?: string;
  createdByUserId: string;
  dueAt: string;
  timezone?: string;
  recurrence?: RecurrenceRule;
  link?: ActivityLink;
  status: ActivityStatus;
  completedAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateActivityInput {
  organizationId: string;
  kind: ActivityKind;
  title: string;
  body?: string;
  assigneeUserId?: string;
  createdByUserId: string;
  dueAt: string;
  timezone?: string;
  recurrence?: RecurrenceRule;
  link?: ActivityLink;
  id?: string;
  createdAt?: string;
}

export interface ActivityFilter {
  organizationId: string;
  kind?: ActivityKind;
  status?: ActivityStatus;
  assigneeUserId?: string;
  /** Include only activities due at or before this instant (ISO). */
  dueAtOrBefore?: string;
}

/** Pure recurrence: the first occurrence strictly after `after` (UTC). */
export function nextOccurrence(rule: RecurrenceRule, after: Date): Date | null {
  const interval = Math.max(1, rule.interval ?? 1);
  const at = rule.at ?? "09:00";
  const [hh, mm] = at.split(":").map((n) => parseInt(n, 10));
  const hour = typeof hh === "number" && Number.isFinite(hh) ? hh : 9;
  const minute = typeof mm === "number" && Number.isFinite(mm) ? mm : 0;

  const candidate = new Date(after);
  if (rule.freq === "daily") {
    candidate.setUTCDate(candidate.getUTCDate() + interval);
  } else if (rule.freq === "weekly") {
    candidate.setUTCDate(candidate.getUTCDate() + 7 * interval);
  } else {
    candidate.setUTCMonth(candidate.getUTCMonth() + interval);
  }
  candidate.setUTCHours(hour, minute, 0, 0);

  if (rule.freq === "weekly" && rule.daysOfWeek?.length) {
    const allowed = new Set(rule.daysOfWeek);
    for (let i = 0; i < 7; i += 1) {
      if (allowed.has(candidate.getUTCDay())) break;
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    candidate.setUTCHours(hour, minute, 0, 0);
  }

  return candidate.getTime() > after.getTime() ? candidate : null;
}

/** Pure overdue check — never stored, always derived from the clock. */
export function isOverdue(activity: Activity, now: Date): boolean {
  return activity.status === "scheduled" && activity.dueAt <= now.toISOString();
}

/** Agenda ordering: earliest due first, then earliest created. */
export function byAgenda(a: Activity, b: Activity): number {
  const byDue = a.dueAt.localeCompare(b.dueAt);
  return byDue !== 0 ? byDue : a.createdAt.localeCompare(b.createdAt);
}

export interface ActivityStore {
  create(input: CreateActivityInput): Promise<Activity>;
  get(organizationId: string, id: string): Promise<Activity | undefined>;
  /** Complete an activity exactly once; false when absent/already final. */
  complete(organizationId: string, id: string, opts?: { by?: string; now?: () => Date }): Promise<boolean>;
  /** Cancel an activity exactly once; false when absent/already final. */
  cancel(organizationId: string, id: string, opts?: { by?: string; now?: () => Date }): Promise<boolean>;
  list(filter: ActivityFilter): Promise<Activity[]>;
  /** Scheduled activities due at or before `now`, in agenda order. */
  overdue(organizationId: string, now: Date): Promise<Activity[]>;
}

/** In-memory activity store (tests, dev, single-process hosts). */
export class InMemoryActivityStore implements ActivityStore {
  private readonly activities = new Map<string, Activity>();
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async create(input: CreateActivityInput): Promise<Activity> {
    const now = this.now().toISOString();
    const record: Activity = {
      id: input.id ?? crypto.randomUUID(),
      organizationId: input.organizationId,
      kind: input.kind,
      title: input.title,
      body: input.body,
      assigneeUserId: input.assigneeUserId,
      createdByUserId: input.createdByUserId,
      dueAt: input.dueAt,
      timezone: input.timezone,
      recurrence: input.recurrence,
      link: input.link,
      status: "scheduled",
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    this.activities.set(record.id, record);
    return record;
  }

  async get(organizationId: string, id: string): Promise<Activity | undefined> {
    const record = this.activities.get(id);
    return record && record.organizationId === organizationId ? record : undefined;
  }

  async complete(
    organizationId: string,
    id: string,
    opts: { by?: string; now?: () => Date } = {},
  ): Promise<boolean> {
    return this.finalize(organizationId, id, "completed", opts);
  }

  async cancel(
    organizationId: string,
    id: string,
    opts: { by?: string; now?: () => Date } = {},
  ): Promise<boolean> {
    return this.finalize(organizationId, id, "cancelled", opts);
  }

  async list(filter: ActivityFilter): Promise<Activity[]> {
    const out: Activity[] = [];
    for (const a of this.activities.values()) {
      if (a.organizationId !== filter.organizationId) continue;
      if (filter.kind !== undefined && a.kind !== filter.kind) continue;
      if (filter.status !== undefined && a.status !== filter.status) continue;
      if (filter.assigneeUserId !== undefined && a.assigneeUserId !== filter.assigneeUserId) continue;
      if (filter.dueAtOrBefore !== undefined && a.dueAt > filter.dueAtOrBefore) continue;
      out.push(a);
    }
    return out.sort(byAgenda);
  }

  async overdue(organizationId: string, now: Date): Promise<Activity[]> {
    return (await this.list({ organizationId })).filter((a) => isOverdue(a, now));
  }

  private finalize(
    organizationId: string,
    id: string,
    status: "completed" | "cancelled",
    opts: { by?: string; now?: () => Date } = {},
  ): boolean {
    const record = this.activities.get(id);
    if (!record || record.organizationId !== organizationId) return false;
    if (record.status !== "scheduled") return false;
    const at = (opts.now?.() ?? this.now()).toISOString();
    record.status = status;
    record.updatedAt = at;
    if (status === "completed") record.completedAt = at;
    if (status === "cancelled") record.cancelledAt = at;
    return true;
  }
}