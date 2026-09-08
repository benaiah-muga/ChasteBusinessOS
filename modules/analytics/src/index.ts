import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
import { explainChange } from "@chaste/erp-core";
import { customers, invoiceLines, invoices } from "@chaste/db";
import {
  datasetShape,
  extractInvoiceAging,
  extractPipelineByStage,
  extractRevenueByMonth,
  extractSalesByCustomer,
  extractStockLevels,
  type AnalyticsDeps,
  type DatasetResult,
} from "./datasets";
import { applyFrameOps, frameOpSchema } from "./frame";
import { chartSpecSchema, renderChartSvg, renderReportHtml, type ReportSection } from "./report";

export { frameOpSchema, chartSpecSchema };
export { applyFrameOps } from "./frame";
export const MAX_REPORT_SECTIONS = 8;

/**
 * Analytics capabilities. Extractors re-declare their source module's read
 * permission so the executor gates every access exactly like the source
 * module's own reads; the report renderer is a pure formatter over frames the
 * caller already obtained through gated extracts, so its own
 * "analytics.report" permission carries no data access of its own and is
 * safe to grant broadly.
 */

const sectionSchema = z.object({
  heading: z.string().min(1).max(200),
  columns: z.array(z.string().min(1)).min(1).max(30),
  rows: z.array(z.record(z.string(), z.unknown())).max(5000),
  ops: frameOpSchema.max(10).default([]),
  chart: chartSpecSchema.optional(),
});

const renderReport = (deps: AnalyticsDeps) =>
  defineCapability({
    id: "analytics.renderReport",
    title: "Render analytics report",
    intent:
      "Compose extracted datasets into a downloadable report with narrative text, charts, and exact tables",
    module: "analytics",
    risk: "read",
    permission: "analytics.report",
    input: z.object({
      title: z.string().min(1).max(200),
      narrative: z.string().max(6000).optional(),
      sections: z.array(sectionSchema).min(1).max(MAX_REPORT_SECTIONS),
    }),
    output: z.object({
      region: z.string().nullable(),
      html: z.string(),
      sections: z.array(
        z.object({
          heading: z.string(),
          svg: z.string().nullable(),
          columns: z.array(z.string()),
          rows: z.array(z.record(z.string(), z.unknown())),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const rendered: ReportSection[] = [];
      for (const section of input.sections) {
        const frameData = applyFrameOps(section.rows, section.ops);
        rendered.push({
          heading: section.heading,
          columns: section.columns,
          rows: frameData.rows,
          svg: section.chart ? renderChartSvg(section.chart, frameData.rows) : null,
        });
      }
      const orgs = (await deps.db.execute(
        sql`SELECT data_region FROM organizations WHERE id = ${ctx.actor.orgId}`,
      )) as unknown as { data_region: string | null }[];
      const region = orgs[0]?.data_region ?? null;
      return {
        region,
        html: renderReportHtml(input.title, region, input.narrative ?? null, rendered),
        sections: rendered.map((r) => ({ heading: r.heading, svg: r.svg, columns: r.columns, rows: r.rows })),
      };
    },
  });

const pipelineByStage = (deps: AnalyticsDeps) =>
  defineCapability({
    id: "analytics.pipelineByStage",
    title: "Extract pipeline by stage",
    intent:
      "Deal counts and values per pipeline stage with weighted forecast, for revenue forecasting analysis",
    module: "analytics",
    risk: "read",
    permission: "crm.read",
    input: z.object({}),
    output: datasetShape,
    execute: async (ctx): Promise<DatasetResult> => extractPipelineByStage(deps, ctx),
  });

const revenueByMonth = (deps: AnalyticsDeps) =>
  defineCapability({
    id: "analytics.revenueByMonth",
    title: "Extract monthly invoiced revenue",
    intent:
      "Monthly totals and counts of non-void invoices over a lookback window, for revenue trend analysis",
    module: "analytics",
    risk: "read",
    permission: "accounting.read",
    input: z.object({ monthsBack: z.number().int().min(1).max(36).default(12) }),
    output: datasetShape,
    execute: async (ctx, input): Promise<DatasetResult> => extractRevenueByMonth(deps, ctx, input.monthsBack),
  });

const invoiceAging = (deps: AnalyticsDeps) =>
  defineCapability({
    id: "analytics.invoiceAging",
    title: "Extract invoice aging buckets",
    intent:
      "Open invoice balances grouped into aging buckets so collections can chase the oldest money first",
    module: "analytics",
    risk: "read",
    permission: "accounting.read",
    input: z.object({}),
    output: datasetShape,
    execute: async (ctx): Promise<DatasetResult> => extractInvoiceAging(deps, ctx),
  });

const salesByCustomer = (deps: AnalyticsDeps) =>
  defineCapability({
    id: "analytics.salesByCustomer",
    title: "Extract top customers by invoiced value",
    intent:
      "Customers ranked by total invoiced value with invoice counts, for concentration and growth analysis",
    module: "analytics",
    risk: "read",
    permission: "accounting.read",
    input: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
    output: datasetShape,
    execute: async (ctx, input): Promise<DatasetResult> => extractSalesByCustomer(deps, ctx, input.limit),
  });

const stockLevels = (deps: AnalyticsDeps) =>
  defineCapability({
    id: "analytics.stockLevels",
    title: "Extract stock levels and valuation",
    intent:
      "On-hand quantity per item with latest unit cost and derived value, for stock and reorder analysis",
    module: "analytics",
    risk: "read",
    permission: "inventory.read",
    input: z.object({}),
    output: datasetShape,
    execute: async (ctx): Promise<DatasetResult> => extractStockLevels(deps, ctx),
  });

// ── M12: explainChange + askYourBusiness ────────────────────────────────

async function metricRowsByDimension(
  deps: AnalyticsDeps,
  orgId: string,
  dimension: "customer" | "product",
  from: Date,
  to: Date,
): Promise<Array<{ key: string; valueMinor: number }>> {
  const base = deps.db
    .select({
      key: dimension === "customer" ? sql<string>`coalesce(${customers.name}, ${invoices.customerId}::text)` : sql<string>`${invoiceLines.description}`,
      valueMinor: sql<number>`coalesce(sum(${invoiceLines.quantity} * ${invoiceLines.unitPriceMinor} / 1000), 0)`,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id));
  const joined =
    dimension === "customer"
      ? base.leftJoin(customers, eq(customers.id, invoices.customerId))
      : base;
  const rows = await joined
    .where(
      and(
        eq(invoices.orgId, orgId),
        sql`${invoices.status} IN ('sent', 'paid')`,
        sql`${invoices.voidedAt} IS NULL`,
        sql`${invoices.issuedAt} >= ${from.toISOString()}`,
        sql`${invoices.issuedAt} < ${to.toISOString()}`,
      ),
    )
    .groupBy(sql`1`);
  return rows.map((r) => ({ key: r.key, valueMinor: Number(r.valueMinor) }));
}

const explainChangeCap = (deps: AnalyticsDeps) =>
  defineCapability({
    id: "analytics.explainChange",
    title: "Explain metric change",
    intent:
      "Attribute a revenue change across a dimension — customers or products — with exact contributions that sum to the delta and drill down to the underlying invoices",
    module: "analytics",
    risk: "read",
    permission: "analytics.report",
    input: z.object({
      dimension: z.enum(["customer", "product"]),
      periodAFrom: z.string().datetime(),
      periodATo: z.string().datetime(),
      periodBFrom: z.string().datetime(),
      periodBTo: z.string().datetime(),
    }),
    output: z.object({
      priorTotalMinor: z.number(),
      currentTotalMinor: z.number(),
      deltaMinor: z.number(),
      contributions: z.array(
        z.object({
          key: z.string(),
          priorMinor: z.number(),
          currentMinor: z.number(),
          deltaMinor: z.number(),
          shareOfDelta: z.number().nullable(),
        }),
      ),
      drill: z.array(
        z.object({
          key: z.string(),
          invoiceIds: z.array(z.string()),
        }),
      ),
    }),
    execute: async (ctx, input) => {
      const a = await metricRowsByDimension(deps, ctx.actor.orgId, input.dimension, new Date(input.periodAFrom), new Date(input.periodATo));
      const b = await metricRowsByDimension(deps, ctx.actor.orgId, input.dimension, new Date(input.periodBFrom), new Date(input.periodBTo));
      const decomposition = explainChange(a, b);

      // Drill: sample invoice ids behind the five biggest movers.
      const movers = decomposition.contributions.slice(0, 5).map((c) => c.key);
      const drill: Array<{ key: string; invoiceIds: string[] }> = [];
      for (const key of movers) {
        const base = deps.db
          .select({ id: invoices.id })
          .from(invoiceLines)
          .innerJoin(invoices, eq(invoiceLines.invoiceId, invoices.id));
        const joined = input.dimension === "customer" ? base.leftJoin(customers, eq(customers.id, invoices.customerId)) : base;
        const rows = await joined
          .where(
            and(
              sql`${invoices.orgId} = ${ctx.actor.orgId}`,
              sql`${invoices.status} IN ('sent', 'paid')`,
              sql`${invoices.voidedAt} IS NULL`,
              sql`${invoices.issuedAt} >= ${input.periodBFrom}`,
              sql`${invoices.issuedAt} < ${input.periodBTo}`,
              sql`(${input.dimension === "customer" ? sql`coalesce(${customers.name}, ${invoices.customerId}::text)` : sql`${invoiceLines.description}`}) = ${key}`,
            ),
          )
          .limit(10);
        drill.push({ key, invoiceIds: rows.map((r) => r.id) });
      }
      return { ...decomposition, drill };
    },
  });

const askYourBusiness = (deps: AnalyticsDeps) =>
  defineCapability({
    id: "analytics.askYourBusiness",
    title: "Ask your business",
    intent:
      "Compose a cited answer about revenue, collections, and pipeline from governed extracts plus the signal feed, ending in one proposed governed action",
    module: "analytics",
    risk: "read",
    permission: "analytics.report",
    input: z.object({ focus: z.enum(["revenue", "collections", "pipeline"]).optional() }),
    output: z.object({
      sections: z.array(
        z.object({
          heading: z.string(),
          citations: z.array(z.string()),
          lines: z.array(z.string()),
        }),
      ),
      proposedAction: z
        .object({
          capabilityId: z.string(),
          inputDraft: z.record(z.string(), z.unknown()),
          why: z.string(),
        })
        .nullable(),
    }),
    execute: async (ctx, input) => {
      const focus = input.focus ?? "revenue";
      const sections: Array<{ heading: string; citations: string[]; lines: string[] }> = [];
      let proposedAction: { capabilityId: string; inputDraft: Record<string, unknown>; why: string } | null = null;

      if (focus === "revenue") {
        const sales = await extractSalesByCustomer(deps, ctx, 3);
        const top = sales.rows.slice(0, 3) as Array<Record<string, unknown>>;
        sections.push({
          heading: "Top customers this period",
          citations: top.map((r) => String(r.customerName)),
          lines: top.map((r) => `${r.customerName}: ${r.invoiceCount} invoice(s), ${r.total_minor} minor`),
        });
      } else if (focus === "collections") {
        const aging = await extractInvoiceAging(deps, ctx);
        sections.push({
          heading: "Receivables aging",
          citations: (aging.rows as Array<Record<string, unknown>>).slice(0, 5).map((r) => String(r.invoice_id ?? r.invoiceId ?? "")),
          lines: aging.rows.slice(0, 5).map((r) => JSON.stringify(r)),
        });
      } else {
        const pipeline = await extractPipelineByStage(deps, ctx);
        sections.push({
          heading: "Pipeline by stage",
          citations: [],
          lines: (pipeline.rows as Array<Record<string, unknown>>).map((r) => JSON.stringify(r)),
        });
      }

      const signals = deps.signals ? await deps.signals(ctx.actor.orgId, ctx.now) : [];
      const top = signals[0];
      if (top) {
        sections.push({
          heading: "Needs attention",
          citations: [top.id],
          lines: [top.subject],
        });
        if (top.suggestedAction) {
          proposedAction = {
            capabilityId: top.suggestedAction.capabilityId,
            inputDraft: top.suggestedAction.inputDraft ?? {},
            why: top.subject,
          };
        }
      }
      return { sections, proposedAction };
    },
  });

export function registerAnalyticsCapabilities(registry: CapabilityRegistry, deps: AnalyticsDeps): void {
  registry.register(renderReport(deps));
  registry.register(pipelineByStage(deps));
  registry.register(revenueByMonth(deps));
  registry.register(invoiceAging(deps));
  registry.register(salesByCustomer(deps));
  registry.register(stockLevels(deps));
  registry.register(explainChangeCap(deps));
  registry.register(askYourBusiness(deps));
}
export type { AnalyticsDeps } from "./datasets";
