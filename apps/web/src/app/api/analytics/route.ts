import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@chaste/db";
import { hasPermission as hasPermissionFor } from "@chaste/kernel";
import { frameOpSchema, chartSpecSchema } from "@chaste/module-analytics";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * Governed analytics endpoint.
 *
 * GET  lists the datasets the current actor may read (permission + module
 *      gate applied), so both the UI and the agent can discover their
 *      allowed surface honestly.
 * POST composes a report: every section first runs its dataset through the
 *      executor (full policy/ledger path), then the extracted frame is shaped
 *      with declarative ops and rendered server-side to SVG + HTML.
 */

const DATASETS = [
  {
    id: "analytics.pipelineByStage",
    label: "Pipeline by stage",
    description: "Deal counts and values per stage with weighted forecast",
    permission: "crm.read",
  },
  {
    id: "analytics.revenueByMonth",
    label: "Revenue by month",
    description: "Invoiced totals per month over a lookback window",
    permission: "accounting.read",
    params: [{ key: "monthsBack", type: "number", default: 12 }],
  },
  {
    id: "analytics.invoiceAging",
    label: "Invoice aging",
    description: "Open invoice balances bucketed by days outstanding",
    permission: "accounting.read",
  },
  {
    id: "analytics.salesByCustomer",
    label: "Top customers",
    description: "Customers ranked by invoiced value",
    permission: "accounting.read",
    params: [{ key: "limit", type: "number", default: 10 }],
  },
  {
    id: "analytics.stockLevels",
    label: "Stock levels & valuation",
    description: "On-hand quantities with unit cost and value per item",
    permission: "inventory.read",
  },
] as const;

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const perms = { permissions: resolved.permissions };

  // ?dataset=<id> returns a live preview of one governed extract.
  const requested = new URL(req.url).searchParams.get("dataset");
  if (requested) {
    if (!DATASETS.some((d) => d.id === requested)) {
      return NextResponse.json({ error: "unknown dataset" }, { status: 404 });
    }
    const db = getDb().db;
    const executor = buildExecutor(db, buildRegistry(db));
    const humanCtx = actorFromResolved(resolved, {});
    if (!humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const result = await executor.execute(requested, humanCtx, {});
    if (!result.ok) return NextResponse.json({ error: result.error ?? "forbidden" }, { status: 403 });
    return NextResponse.json(result.data);
  }

  const datasets = DATASETS.filter((d) => hasPermissionFor(perms, d.permission));
  return NextResponse.json({ datasets });
}

const postSchema = z.object({
  title: z.string().min(1).max(200),
  narrative: z.string().max(6000).optional(),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1).max(200),
        datasetId: z.string().regex(/^analytics\.[a-zA-Z]+$/),
        params: z.record(z.string(), z.unknown()).default({}),
        ops: frameOpSchema.max(10).default([]),
        chart: chartSpecSchema.optional(),
      }),
    )
    .min(1)
    .max(8),
});

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  const humanCtx = resolved ? actorFromResolved(resolved, {}) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = postSchema.safeParse(await req.json());
  if (!body.success) return NextResponse.json({ error: "invalid body", detail: body.error.message }, { status: 400 });

  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

  // Each section's data is fetched through the executor: permission checks,
  // module gates, and ledger audit happen exactly as for any other read.
  const extracted: { heading: string; columns: string[]; rows: Record<string, unknown>[] }[] = [];
  for (const section of body.data.sections) {
    const known = DATASETS.find((d) => d.id === section.datasetId);
    if (!known) return NextResponse.json({ error: `unknown dataset ${section.datasetId}` }, { status: 400 });
    const result = await executor.execute(section.datasetId, humanCtx, section.params);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? `dataset ${section.datasetId} failed` }, { status: 403 });
    }
    const data = result.data as { columns: string[]; rows: Record<string, unknown>[] };
    extracted.push({ heading: section.heading, columns: data.columns, rows: data.rows });
  }

  const report = await executor.execute("analytics.renderReport", humanCtx, {
    title: body.data.title,
    narrative: body.data.narrative,
    sections: body.data.sections.map((s, i) => ({
      heading: s.heading,
      columns: extracted[i]!.columns,
      rows: extracted[i]!.rows,
      ops: s.ops,
      ...(s.chart ? { chart: s.chart } : {}),
    })),
  });
  if (!report.ok) return NextResponse.json({ error: report.error ?? "report failed" }, { status: 500 });

  return NextResponse.json(report.data);
}
