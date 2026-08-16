/**
 * Postgres-backed `TaskStore` over the `workflow_tasks` table.
 *
 * ADR 0014 tranche 5 — the durable counterpart to `InMemoryTaskStore`, shared
 * across hosts. Task transitions re-read the dependency graph and reuse the
 * kernel's pure `canTransition`, so readiness/blocking never drift between
 * the in-memory and Postgres stores.
 */
import { and, asc, eq } from "drizzle-orm";
import { schema, type Db } from "@chaste/db";
import {
  canTransition,
  readyTasks,
  type CreateTaskInput,
  type Task,
  type TaskFilter,
  type TaskStore,
  type TaskStatus,
  type TaskTransition,
} from "@chaste/kernel";
const { workflowTasks } = schema;

export class PostgresTaskStore implements TaskStore {
  constructor(private readonly db: Db) {}

  async create(input: CreateTaskInput): Promise<Task> {
    const id = input.id ?? crypto.randomUUID();
    await this.db.insert(workflowTasks).values({
      id,
      organizationId: input.organizationId,
      workflowId: input.workflowId ?? null,
      title: input.title,
      description: input.description ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      createdByUserId: input.createdByUserId,
      priority: input.priority ?? "normal",
      dueAt: input.dueAt ? new Date(input.dueAt) : null,
      dependsOn: input.dependsOn ?? [],
    });
    const row = await this.get(input.organizationId, id);
    if (!row) throw new Error("Task was not persisted");
    return row;
  }

  async get(organizationId: string, id: string): Promise<Task | undefined> {
    const rows = await this.db
      .select()
      .from(workflowTasks)
      .where(and(eq(workflowTasks.id, id), eq(workflowTasks.organizationId, organizationId)))
      .limit(1);
    const row = rows[0];
    return row ? this.mapRow(row) : undefined;
  }

  async transition(
    organizationId: string,
    id: string,
    to: TaskStatus,
    opts: { by?: string; reason?: string; now?: () => Date } = {},
  ): Promise<TaskTransition> {
    const task = await this.get(organizationId, id);
    if (!task) return { ok: false, reason: "task not found" };
    const all = await this.list({ organizationId });
    const gate = canTransition(task, to, all);
    if (!gate.ok) return gate;

    const at = opts.now?.() ?? new Date();
    const rows = await this.db
      .update(workflowTasks)
      .set({
        status: to,
        updatedAt: at,
        blockedReason: to === "blocked" ? opts.reason ?? null : null,
        completedAt: to === "completed" ? at : null,
        cancelledAt: to === "cancelled" ? at : null,
      })
      .where(
        and(
          eq(workflowTasks.id, id),
          eq(workflowTasks.organizationId, organizationId),
        ),
      )
      .returning({ id: workflowTasks.id });
    if (rows.length === 0) return { ok: false, reason: "task not found" };
    return { ok: true, task: (await this.get(organizationId, id)) as Task };
  }

  async list(filter: TaskFilter): Promise<Task[]> {
    const conds = [eq(workflowTasks.organizationId, filter.organizationId)];
    if (filter.workflowId !== undefined) conds.push(eq(workflowTasks.workflowId, filter.workflowId));
    if (filter.assigneeUserId !== undefined) {
      conds.push(eq(workflowTasks.assigneeUserId, filter.assigneeUserId));
    }
    if (filter.status !== undefined) conds.push(eq(workflowTasks.status, filter.status));
    const rows = await this.db
      .select()
      .from(workflowTasks)
      .where(and(...conds))
      .orderBy(asc(workflowTasks.createdAt));
    return rows.map((r) => this.mapRow(r));
  }

  async workQueue(organizationId: string): Promise<Task[]> {
    return readyTasks(await this.list({ organizationId }));
  }

  private mapRow(row: {
    id: string;
    organizationId: string;
    workflowId: string | null;
    title: string;
    description: string | null;
    assigneeUserId: string | null;
    createdByUserId: string;
    status: string;
    priority: string;
    dueAt: Date | null;
    dependsOn: string[];
    blockedReason: string | null;
    completedAt: Date | null;
    cancelledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): Task {
    return {
      id: row.id,
      organizationId: row.organizationId,
      workflowId: row.workflowId ?? undefined,
      title: row.title,
      description: row.description ?? undefined,
      assigneeUserId: row.assigneeUserId ?? undefined,
      createdByUserId: row.createdByUserId,
      status: row.status as TaskStatus,
      priority: row.priority as Task["priority"],
      dueAt: row.dueAt?.toISOString(),
      dependsOn: row.dependsOn,
      blockedReason: row.blockedReason ?? undefined,
      completedAt: row.completedAt?.toISOString(),
      cancelledAt: row.cancelledAt?.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}