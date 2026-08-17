/**
 * Postgres-backed `WorkflowInstanceStore` over the `workflow_runs` table.
 *
 * ADR 0014 tranche 9 (build item 10) — the durable counterpart to
 * `InMemoryWorkflowInstanceStore`: each workflow run checkpoints its status,
 * context, and per-step results so a crash between steps leaves the instance
 * resumable, and an approval gate parks it at `pending_approval` for a later
 * `advance` call from any host (API + worker share the table).
 */
import { and, asc, eq } from "drizzle-orm";
import { schema, type Db } from "@chaste/db";
import type {
  WorkflowInstance,
  WorkflowInstanceStatus,
  WorkflowInstanceStore,
} from "@chaste/kernel";

const { workflowRuns } = schema;

export class PostgresWorkflowInstanceStore implements WorkflowInstanceStore {
  constructor(private readonly db: Db) {}

  async save(instance: WorkflowInstance): Promise<void> {
    await this.db
      .insert(workflowRuns)
      .values({
        id: instance.id,
        workflowId: instance.workflowId,
        organizationId: instance.organizationId,
        status: instance.status,
        context: instance.context,
        steps: instance.steps,
        error: instance.error ?? null,
        createdByUserId: instance.createdByUserId,
        startedAt: new Date(instance.startedAt),
        updatedAt: new Date(instance.updatedAt),
        completedAt: instance.completedAt ? new Date(instance.completedAt) : null,
      })
      .onConflictDoUpdate({
        target: workflowRuns.id,
        set: {
          status: instance.status,
          context: instance.context,
          steps: instance.steps,
          error: instance.error ?? null,
          updatedAt: new Date(instance.updatedAt),
          completedAt: instance.completedAt ? new Date(instance.completedAt) : null,
        },
      });
  }

  async get(id: string): Promise<WorkflowInstance | undefined> {
    const rows = await this.db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1);
    const row = rows[0];
    return row ? this.mapRow(row) : undefined;
  }

  async listByOrg(
    organizationId: string,
    filter: { workflowId?: string; status?: WorkflowInstanceStatus } = {},
  ): Promise<WorkflowInstance[]> {
    const conds = [eq(workflowRuns.organizationId, organizationId)];
    if (filter.workflowId !== undefined) conds.push(eq(workflowRuns.workflowId, filter.workflowId));
    if (filter.status !== undefined) conds.push(eq(workflowRuns.status, filter.status));
    const rows = await this.db
      .select()
      .from(workflowRuns)
      .where(and(...conds))
      .orderBy(asc(workflowRuns.startedAt));
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: {
    id: string;
    workflowId: string;
    organizationId: string;
    status: string;
    context: Record<string, unknown> | null;
    steps: unknown;
    error: string | null;
    createdByUserId: string | null;
    startedAt: Date;
    updatedAt: Date;
    completedAt: Date | null;
  }): WorkflowInstance {
    return {
      id: row.id,
      workflowId: row.workflowId,
      organizationId: row.organizationId,
      status: row.status as WorkflowInstanceStatus,
      context: row.context ?? {},
      steps: (row.steps ?? []) as WorkflowInstance["steps"],
      error: row.error ?? undefined,
      createdByUserId: row.createdByUserId ?? "",
      startedAt: row.startedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      completedAt: row.completedAt?.toISOString(),
    };
  }
}