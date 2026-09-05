import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "@chaste/db";
import type { ActionContext, SignalProducer } from "@chaste/kernel";

/**
 * Governed analytics datasets.
 *
 * Every extractor is an ordinary read capability: it declares the *source
 * module's* permission (accounting.read etc.), executes only org-scoped SQL,
 * and its every run lands in the audit ledger — for humans and agents alike.
 * That is the whole jurisdiction model: an actor is bound to one org, so a
 * dataset can never cross the boundary, and each result carries the org's
 * data region tag so every consumer knows where the numbers live.
 */

export interface AnalyticsDeps {
  db: Database["db"];
  /** Composed signal feed, injected at the app layer (ADR 0034/0039). */
  signals?: SignalProducer;
}

export const datasetShape = z.object({
  region: z.string().nullable(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
});

export type DatasetResult = z.infer<typeof datasetShape>;

const STAGE_WEIGHT: Record<string, number> = {
  lead: 0.1,
  qualified: 0.3,
  proposal: 0.5,
  negotiation: 0.7,
  won: 1,
  lost: 0,
};

async function regionOf(deps: AnalyticsDeps, ctx: ActionContext): Promise<string | null> {
  const rows = (await deps.db.execute(
    sql`SELECT data_region FROM organizations WHERE id = ${ctx.actor.orgId}`,
  )) as unknown as { data_region: string | null }[];
  return rows[0]?.data_region ?? null;
}

function frame(region: string | null, columns: string[], rows: Record<string, unknown>[]): DatasetResult {
  return { region, columns, rows };
}

/** Pipeline by stage with weighted forecast (crm.read). */
export async function extractPipelineByStage(deps: AnalyticsDeps, ctx: ActionContext): Promise<DatasetResult> {
  const rows = (await deps.db.execute(sql`
    SELECT stage, count(*)::int AS count, COALESCE(SUM(value_minor), 0)::int AS total_minor
    FROM deals WHERE org_id = ${ctx.actor.orgId} GROUP BY stage
  `)) as unknown as { stage: string; count: number; total_minor: number }[];
  const byStage = new Map(rows.map((r) => [r.stage, r]));
  const stages = ["lead", "qualified", "proposal", "negotiation", "won", "lost"];
  return frame(
    await regionOf(deps, ctx),
    ["stage", "count", "totalMinor", "weightedMinor"],
    stages.map((stage) => {
      const e = byStage.get(stage);
      const totalMinor = Number(e?.total_minor ?? 0);
      return {
        stage,
        count: Number(e?.count ?? 0),
        totalMinor,
        weightedMinor: Math.round(totalMinor * (STAGE_WEIGHT[stage] ?? 0)),
      };
    }),
  );
}

/** Invoiced revenue per month, non-void invoices (accounting.read). */
export async function extractRevenueByMonth(
  deps: AnalyticsDeps,
  ctx: ActionContext,
  monthsBack: number,
): Promise<DatasetResult> {
  const rows = (await deps.db.execute(sql`
    SELECT to_char(date_trunc('month', COALESCE(issued_at, created_at)), 'YYYY-MM') AS month,
           count(*)::int AS invoiced_count,
           COALESCE(SUM(total_minor), 0)::int AS total_minor
    FROM invoices
    WHERE org_id = ${ctx.actor.orgId}
      AND status <> 'void'
      AND voided_at IS NULL
      AND COALESCE(issued_at, created_at) >= date_trunc('month', now()) - (${monthsBack}::int - 1) * interval '1 month'
    GROUP BY 1 ORDER BY 1
  `)) as unknown as { month: string; invoiced_count: number; total_minor: number }[];
  return frame(
    await regionOf(deps, ctx),
    ["month", "invoiceCount", "totalMinor"],
    rows.map((r) => ({ month: r.month, invoiceCount: Number(r.invoiced_count), totalMinor: Number(r.total_minor) })),
  );
}

/** Unpaid invoice aging in buckets (accounting.read). */
export async function extractInvoiceAging(deps: AnalyticsDeps, ctx: ActionContext): Promise<DatasetResult> {
  const rows = (await deps.db.execute(sql`
    SELECT CASE
             WHEN age < 30 THEN 'current'
             WHEN age < 60 THEN '1-30_days_overdue'
             WHEN age < 90 THEN '30-60_days_overdue'
             ELSE '90+_days_overdue'
           END AS bucket,
           count(*)::int AS count,
           COALESCE(SUM(balance_minor), 0)::int AS balance_minor
    FROM (
      SELECT EXTRACT(DAY FROM now() - COALESCE(issued_at, created_at))::int AS age,
             total_minor - paid_minor AS balance_minor
      FROM invoices
      WHERE org_id = ${ctx.actor.orgId}
        AND status IN ('sent', 'paid')
        AND voided_at IS NULL
        AND total_minor > paid_minor
    ) open
    GROUP BY 1 ORDER BY 1
  `)) as unknown as { bucket: string; count: number; balance_minor: number }[];
  const order = ["current", "1-30_days_overdue", "30-60_days_overdue", "90+_days_overdue"];
  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  return frame(
    await regionOf(deps, ctx),
    ["bucket", "count", "balanceMinor"],
    order.map((bucket) => ({
      bucket,
      count: Number(byBucket.get(bucket)?.count ?? 0),
      balanceMinor: Number(byBucket.get(bucket)?.balance_minor ?? 0),
    })),
  );
}

/** Top customers by invoiced value (accounting.read). */
export async function extractSalesByCustomer(
  deps: AnalyticsDeps,
  ctx: ActionContext,
  limit: number,
): Promise<DatasetResult> {
  const rows = (await deps.db.execute(sql`
    SELECT c.name AS "customerName",
           count(i.id)::int AS "invoiceCount",
           COALESCE(SUM(i.total_minor), 0)::int AS total_minor
    FROM customers c
    JOIN invoices i ON i.customer_id = c.id AND i.org_id = ${ctx.actor.orgId}
      AND i.status <> 'void' AND i.voided_at IS NULL
    WHERE c.org_id = ${ctx.actor.orgId}
    GROUP BY c.id, c.name
    ORDER BY total_minor DESC
    LIMIT ${limit}
  `)) as unknown as { customerName: string; invoiceCount: number; total_minor: number }[];
  return frame(
    await regionOf(deps, ctx),
    ["customerName", "invoiceCount", "totalMinor"],
    rows.map((r) => ({
      customerName: r.customerName,
      invoiceCount: Number(r.invoiceCount),
      totalMinor: Number(r.total_minor),
    })),
  );
}

/** Stock on hand per item with latest known unit cost (inventory.read). */
export async function extractStockLevels(deps: AnalyticsDeps, ctx: ActionContext): Promise<DatasetResult> {
  const rows = (await deps.db.execute(sql`
    SELECT i.sku, i.name,
           COALESCE(m.on_hand, 0)::int AS on_hand_thousandths,
           m.unit_cost_minor,
           i.reorder_point_thousandths
    FROM items i
    LEFT JOIN LATERAL (
      SELECT SUM(sm.quantity_delta) AS on_hand,
             (ARRAY_AGG(sm.unit_cost_minor ORDER BY sm.created_at DESC)
                FILTER (WHERE sm.unit_cost_minor IS NOT NULL))[1] AS unit_cost_minor
      FROM stock_movements sm WHERE sm.item_id = i.id
    ) m ON true
    WHERE i.org_id = ${ctx.actor.orgId} AND i.archived_at IS NULL
    ORDER BY i.sku
  `)) as unknown as {
    sku: string;
    name: string;
    on_hand_thousandths: number;
    unit_cost_minor: number | null;
    reorder_point_thousandths: number;
  }[];
  return frame(
    await regionOf(deps, ctx),
    ["sku", "name", "onHandThousandths", "unitCostMinor", "reorderPointThousandths", "valueMinor"],
    rows.map((r) => ({
      sku: r.sku,
      name: r.name,
      onHandThousandths: Number(r.on_hand_thousandths),
      unitCostMinor: r.unit_cost_minor === null ? null : Number(r.unit_cost_minor),
      reorderPointThousandths: Number(r.reorder_point_thousandths),
      valueMinor:
        r.unit_cost_minor === null ? null : Math.round((Number(r.on_hand_thousandths) / 1000) * Number(r.unit_cost_minor)),
    })),
  );
}
