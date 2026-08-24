import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { bomLines, getDb, items, lots, stockMovements, workOrders } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

async function guard(): Promise<
  { error: NextResponse } | { ctx: NonNullable<ReturnType<typeof actorFromResolved>>; executor: ReturnType<typeof buildExecutor> }
> {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return { error: NextResponse.json({ error: "onboarding required" }, { status: 428 }) };
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  return { ctx, executor };
}

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}

type GuardOk = Exclude<Awaited<ReturnType<typeof guard>>, { error: NextResponse }>;
type Exec = GuardOk["executor"];
type Ctx = GuardOk["ctx"];

async function exec(executor: Exec, ctx: Ctx, capId: string, input: unknown) {
  const r = await executor.execute(capId, ctx, input);
  return respond(r as { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown });
}

export async function GET(req: Request) {
  const g = await guard();
  if ("error" in g) return g.error;
  const { ctx, executor } = g;
  const db = getDb().db;
  const orgId = ctx.actor.orgId;
  const url = new URL(req.url);
  const sku = url.searchParams.get("sku");
  const lotCode = url.searchParams.get("lotCode");

  // Lot recall tracing for one batch.
  if (sku && lotCode) {
    return exec(executor, ctx, "manufacturing.lotTrace", { sku, lotCode });
  }

  const itemRows = await db
    .select({ id: items.id, sku: items.sku, name: items.name })
    .from(items)
    .where(eq(items.orgId, orgId));
  const byId = new Map(itemRows.map((r) => [r.id, r]));

  // Raw BOM edges; the client renders the nested tree so sub-assemblies are
  // visible without one request per assembly.
  const edges = await db.select().from(bomLines).where(eq(bomLines.orgId, orgId));
  const boms = edges.map((e) => ({
    assemblySku: byId.get(e.assemblyItemId)?.sku ?? String(e.assemblyItemId),
    componentSku: byId.get(e.componentItemId)?.sku ?? String(e.componentItemId),
    componentName: byId.get(e.componentItemId)?.name ?? "",
    quantityThousandths: e.quantityThousandths,
    scrapPctThousandths: e.scrapPctThousandths,
  }));

  const woRows = await db
    .select({ wo: workOrders, sku: items.sku, name: items.name })
    .from(workOrders)
    .innerJoin(items, eq(workOrders.assemblyItemId, items.id))
    .where(eq(workOrders.orgId, orgId))
    .orderBy(desc(workOrders.createdAt))
    .limit(100);
  const workOrdersUi = woRows.map(({ wo, sku: s, name }) => ({
    id: wo.id,
    number: wo.number,
    assemblySku: s,
    assemblyName: name,
    status: wo.status,
    plannedQtyThousandths: wo.plannedQtyThousandths,
    producedQtyThousandths: wo.producedQtyThousandths,
    yieldPctThousandths: wo.yieldPctThousandths,
    expectedGoodThousandths: Math.floor((wo.plannedQtyThousandths * Math.min(wo.yieldPctThousandths, 1_000_000)) / 1_000_000),
    note: wo.note,
    createdAt: wo.createdAt,
    completedAt: wo.completedAt,
  }));

  // Runs: production movements grouped by run reference. A run is reversed
  // when compensating `production_reversal` movements share the reference.
  const runMoves = await db
    .select({
      refId: stockMovements.refId,
      delta: stockMovements.quantityDelta,
      unitCostMinor: stockMovements.unitCostMinor,
      itemId: stockMovements.itemId,
      lotCode: lots.lotCode,
      createdAt: stockMovements.createdAt,
      actorType: stockMovements.actorType,
      refType: stockMovements.refType,
    })
    .from(stockMovements)
    .leftJoin(lots, eq(stockMovements.lotId, lots.id))
    .where(
      and(
        eq(stockMovements.orgId, orgId),
        inArray(stockMovements.refType, ["production", "production_reversal"]),
      ),
    )
    .orderBy(desc(stockMovements.createdAt))
    .limit(2000);
  const reversedRefs = new Set(
    runMoves.filter((m) => m.refType === "production_reversal" && m.refId).map((m) => m.refId!),
  );
  const groupedRuns = new Map<string, typeof runMoves>();
  for (const m of runMoves) {
    if (m.refType !== "production" || !m.refId) continue;
    const list = groupedRuns.get(m.refId) ?? [];
    list.push(m);
    groupedRuns.set(m.refId, list);
  }
  const productionRunsUi = [...groupedRuns.entries()].slice(0, 100).map(([runId, ms]) => {
    const out = ms.find((m) => m.delta > 0)!;
    let costTotalMinor = 0;
    for (const m of ms) {
      if (m.delta > 0) continue;
      costTotalMinor += Math.round((-m.delta * (m.unitCostMinor ?? out.unitCostMinor ?? 0)) / 1000);
    }
    return {
      runId,
      occurredAt: out.createdAt,
      assemblySku: byId.get(out.itemId)?.sku ?? String(out.itemId),
      producedThousandths: out.delta,
      unitCostMinor: out.unitCostMinor ?? 0,
      costTotalMinor,
      reversed: reversedRefs.has(runId),
      components: ms
        .filter((m) => m.delta < 0)
        .map((m) => ({
          sku: byId.get(m.itemId)?.sku ?? String(m.itemId),
          quantityThousandths: -m.delta,
          lotCode: m.lotCode ?? null,
        })),
    };
  });

  // Lot balances are derived sums over the append-only ledger.
  const lotRows = await db
    .select({
      id: lots.id,
      itemId: lots.itemId,
      lotCode: lots.lotCode,
      expiresAt: lots.expiresAt,
      balance: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)`,
    })
    .from(lots)
    .leftJoin(stockMovements, eq(stockMovements.lotId, lots.id))
    .where(eq(lots.orgId, orgId))
    .groupBy(lots.id)
    .orderBy(desc(lots.createdAt))
    .limit(200);
  const lotsUi = lotRows.map((l) => ({
    id: l.id,
    sku: byId.get(l.itemId)?.sku ?? String(l.itemId),
    lotCode: l.lotCode,
    expiresAt: l.expiresAt,
    balanceThousandths: Number(l.balance),
  }));

  return NextResponse.json({
    boms,
    assemblies: itemRows.map((i) => ({ sku: i.sku, name: i.name })),
    workOrders: workOrdersUi,
    productionRuns: productionRunsUi,
    lots: lotsUi,
  });
}


interface Body {
  action?: string;
  [k: string]: unknown;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const g = await guard();
  if ("error" in g) return g.error;
  const { ctx, executor } = g;

  switch (body.action) {
    case "defineBom":
      return exec(executor, ctx, "manufacturing.defineBom", body);
    case "deleteBom":
      return exec(executor, ctx, "manufacturing.deleteBom", body);
    case "bomReport":
      return exec(executor, ctx, "manufacturing.bomReport", body);
    case "costPreview":
      return exec(executor, ctx, "manufacturing.costPreview", body);
    case "produceFromBom":
      return exec(executor, ctx, "manufacturing.produceFromBom", body);
    // The UI calls it runId; the capability contract names it runRef.
    case "reverseProductionRun":
      return exec(executor, ctx, "manufacturing.reverseProductionRun", {
        runRef: (body.runId as string) ?? (body.runRef as string),
      });
    case "createWorkOrder":
      return exec(executor, ctx, "manufacturing.createWorkOrder", body);
    case "releaseWorkOrder":
      return exec(executor, ctx, "manufacturing.releaseWorkOrder", body);
    case "completeWorkOrder":
      return exec(executor, ctx, "manufacturing.completeWorkOrder", body);
    case "cancelWorkOrder":
      return exec(executor, ctx, "manufacturing.cancelWorkOrder", body);
    default:
      return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
}

