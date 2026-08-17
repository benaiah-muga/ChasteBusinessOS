/**
 * Postgres-backed `UsageLedger` over the `model_usage` table.
 *
 * ADR 0014 tranche 11 — the durable counterpart to `InMemoryUsageLedger` that
 * the API and worker share. Every routed LLM completion appends one row with
 * its estimated cost in cents; budget caps sum those rows, so a cap enforced on
 * one host reflects spend recorded on every host. Rows are never updated or
 * deleted — spend is an audit record, not a counter we can silently reset.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { schema, type Db } from "@chaste/db";
import type { UsageLedger, UsageRecord } from "@chaste/ai-core";

const { modelUsage } = schema;

export class PostgresUsageLedger implements UsageLedger {
  constructor(private readonly db: Db) {}

  async record(usage: UsageRecord): Promise<void> {
    await this.db.insert(modelUsage).values({
      organizationId: usage.organizationId,
      sessionId: usage.sessionId,
      taskClass: usage.taskClass,
      providerId: usage.providerId,
      model: usage.model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      estimatedCostCents: usage.estimatedCostCents,
      createdAt: new Date(usage.createdAt),
    });
  }

  async spendForOrganization(organizationId: string, since: Date): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`coalesce(sum(${modelUsage.estimatedCostCents}), 0)` })
      .from(modelUsage)
      .where(and(gte(modelUsage.createdAt, since), eq(modelUsage.organizationId, organizationId)));
    return Number(rows[0]?.total ?? 0);
  }

  async spendForSession(sessionId: string): Promise<number> {
    const rows = await this.db
      .select({ total: sql<number>`coalesce(sum(${modelUsage.estimatedCostCents}), 0)` })
      .from(modelUsage)
      .where(eq(modelUsage.sessionId, sessionId));
    return Number(rows[0]?.total ?? 0);
  }
}
