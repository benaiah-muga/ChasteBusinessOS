import { sql } from "drizzle-orm";
import { z } from "zod";
import { defineCapability, type CapabilityRegistry } from "@chaste/kernel";
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

export function registerAnalyticsCapabilities(registry: CapabilityRegistry, deps: AnalyticsDeps): void {
  registry.register(renderReport(deps));
  registry.register(pipelineByStage(deps));
  registry.register(revenueByMonth(deps));
  registry.register(invoiceAging(deps));
  registry.register(salesByCustomer(deps));
  registry.register(stockLevels(deps));
}
