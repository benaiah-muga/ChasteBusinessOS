/**
 * Postgres-backed `PlanStore` over the `harness_plans` table.
 *
 * ADR 0014 tranche 10 — the durable counterpart to `InMemoryPlanStore`: a gated
 * plan submitted through one host (the "API") is decidable on any other host
 * (the "worker") because the pending entry lives in the shared table, keyed by
 * its inbox item id. Resolved plans are marked `resolved` (a tombstone) rather
 * than deleted, so decisions stay auditable; only `pending` rows are listed.
 */
import { and, asc, eq } from "drizzle-orm";
import { schema, type Db } from "@chaste/db";
import {
  fromPendingPlanRecord,
  pendingPlanRecordSchema,
  toPendingPlanRecord,
  type PendingPlanEntry,
  type PlanStore,
} from "@chaste/ai-core";

const { harnessPlans } = schema;

export class PostgresPlanStore implements PlanStore {
  constructor(private readonly db: Db) {}

  async save(entry: PendingPlanEntry): Promise<void> {
    const record = toPendingPlanRecord(entry);
    await this.db
      .insert(harnessPlans)
      .values({
        itemId: entry.itemId,
        organizationId: entry.params.organizationId,
        planId: entry.plan.id,
        record: record as unknown,
        approverUserId: entry.approverUserId,
        status: "pending",
      })
      .onConflictDoUpdate({
        target: harnessPlans.itemId,
        set: {
          planId: entry.plan.id,
          record: record as unknown,
          approverUserId: entry.approverUserId,
          status: "pending",
          resolvedAt: null,
        },
      });
  }

  async getByItemId(itemId: string): Promise<PendingPlanEntry | undefined> {
    const rows = await this.db
      .select()
      .from(harnessPlans)
      .where(and(eq(harnessPlans.itemId, itemId), eq(harnessPlans.status, "pending")))
      .limit(1);
    return this.mapRow(rows[0]);
  }

  async getByPlanId(planId: string): Promise<PendingPlanEntry | undefined> {
    const rows = await this.db
      .select()
      .from(harnessPlans)
      .where(and(eq(harnessPlans.planId, planId), eq(harnessPlans.status, "pending")))
      .limit(1);
    return this.mapRow(rows[0]);
  }

  async listByOrg(organizationId: string): Promise<PendingPlanEntry[]> {
    const rows = await this.db
      .select()
      .from(harnessPlans)
      .where(
        and(eq(harnessPlans.organizationId, organizationId), eq(harnessPlans.status, "pending")),
      )
      .orderBy(asc(harnessPlans.createdAt));
    return rows.map((r) => this.mapRow(r)).filter((e): e is PendingPlanEntry => Boolean(e));
  }

  async listAll(): Promise<PendingPlanEntry[]> {
    const rows = await this.db
      .select()
      .from(harnessPlans)
      .where(eq(harnessPlans.status, "pending"))
      .orderBy(asc(harnessPlans.createdAt));
    return rows.map((r) => this.mapRow(r)).filter((e): e is PendingPlanEntry => Boolean(e));
  }

  async remove(itemId: string): Promise<void> {
    await this.db
      .update(harnessPlans)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(and(eq(harnessPlans.itemId, itemId), eq(harnessPlans.status, "pending")));
  }

  private mapRow(row: { record: unknown } | undefined): PendingPlanEntry | undefined {
    if (!row) return undefined;
    const parsed = pendingPlanRecordSchema.safeParse(row.record);
    if (!parsed.success) return undefined;
    return fromPendingPlanRecord(parsed.data);
  }
}