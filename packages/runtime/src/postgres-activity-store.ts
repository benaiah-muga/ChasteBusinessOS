/**
 * Postgres-backed `ActivityStore` over the `activities` table.
 *
 * ADR 0014 tranche 5 — the durable counterpart to `InMemoryActivityStore`, so
 * activities survive restarts and are shared across hosts (API + worker). The
 * scheduling module layers the `activities.*` / `core.reminder.*` command and
 * query surface on top of this store.
 */
import { and, asc, eq, lt, or } from "drizzle-orm";
import { schema, type Db } from "@chaste/db";
import {
  byAgenda,
  isOverdue,
  type Activity,
  type ActivityFilter,
  type ActivityStore,
  type CreateActivityInput,
} from "@chaste/kernel";
const { activities } = schema;

export class PostgresActivityStore implements ActivityStore {
  constructor(private readonly db: Db) {}

  async create(input: CreateActivityInput): Promise<Activity> {
    const id = input.id ?? crypto.randomUUID();
    await this.db.insert(activities).values({
      id,
      organizationId: input.organizationId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      createdByUserId: input.createdByUserId,
      dueAt: new Date(input.dueAt),
      timezone: input.timezone ?? null,
      recurrence: input.recurrence ?? null,
      linkResourceType: input.link?.resourceType ?? null,
      linkResourceId: input.link?.resourceId ?? null,
    });
    const row = await this.get(input.organizationId, id);
    if (!row) throw new Error("Activity was not persisted");
    return row;
  }

  async get(organizationId: string, id: string): Promise<Activity | undefined> {
    const rows = await this.db
      .select()
      .from(activities)
      .where(and(eq(activities.id, id), eq(activities.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    return row ? this.mapRow(row) : undefined;
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
    const conds = [eq(activities.organizationId, filter.organizationId)];
    if (filter.kind !== undefined) conds.push(eq(activities.kind, filter.kind));
    if (filter.status !== undefined) conds.push(eq(activities.status, filter.status));
    if (filter.assigneeUserId !== undefined) {
      conds.push(eq(activities.assigneeUserId, filter.assigneeUserId));
    }
    if (filter.dueAtOrBefore !== undefined) {
      conds.push(lt(activities.dueAt, new Date(filter.dueAtOrBefore)));
    }
    const rows = await this.db
      .select()
      .from(activities)
      .where(and(...conds))
      .orderBy(asc(activities.dueAt), asc(activities.createdAt));
    return rows.map((r) => this.mapRow(r)).sort(byAgenda);
  }

  async overdue(organizationId: string, now: Date): Promise<Activity[]> {
    const rows = await this.db
      .select()
      .from(activities)
      .where(
        and(
          eq(activities.organizationId, organizationId),
          eq(activities.status, "scheduled"),
          lt(activities.dueAt, now),
        ),
      )
      .orderBy(asc(activities.dueAt));
    return rows.map((r) => this.mapRow(r)).filter((a) => isOverdue(a, now));
  }

  private async finalize(
    organizationId: string,
    id: string,
    status: "completed" | "cancelled",
    opts: { by?: string; now?: () => Date } = {},
  ): Promise<boolean> {
    const at = opts.now?.() ?? new Date();
    const rows = await this.db
      .update(activities)
      .set({
        status,
        updatedAt: at,
        completedAt: status === "completed" ? at : null,
        cancelledAt: status === "cancelled" ? at : null,
      })
      .where(
        and(
          eq(activities.id, id),
          eq(activities.organizationId, organizationId),
          eq(activities.status, "scheduled"),
        ),
      )
      .returning({ id: activities.id });
    return rows.length > 0;
  }

  private mapRow(row: {
    id: string;
    organizationId: string;
    kind: string;
    title: string;
    body: string | null;
    assigneeUserId: string | null;
    createdByUserId: string;
    dueAt: Date;
    timezone: string | null;
    recurrence: unknown | null;
    linkResourceType: string | null;
    linkResourceId: string | null;
    status: string;
    completedAt: Date | null;
    cancelledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): Activity {
    return {
      id: row.id,
      organizationId: row.organizationId,
      kind: row.kind as Activity["kind"],
      title: row.title,
      body: row.body ?? undefined,
      assigneeUserId: row.assigneeUserId ?? undefined,
      createdByUserId: row.createdByUserId,
      dueAt: row.dueAt.toISOString(),
      timezone: row.timezone ?? undefined,
      recurrence: (row.recurrence ?? undefined) as Activity["recurrence"],
      link:
        row.linkResourceType && row.linkResourceId
          ? { resourceType: row.linkResourceType, resourceId: row.linkResourceId }
          : undefined,
      status: row.status as Activity["status"],
      completedAt: row.completedAt?.toISOString(),
      cancelledAt: row.cancelledAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}