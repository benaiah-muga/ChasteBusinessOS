import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import {
  cycleCountLines,
  cycleCounts,
  getDb,
  items,
  lots,
  stockLocations,
  stockReservations,
} from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = resolved.orgId;
  const db = getDb().db;

  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  // Per-SKU movement history for the expandable ledger rows.
  const sku = new URL(req.url).searchParams.get("sku");
  if (sku) {
    const history = await executor.execute("inventory.itemHistory", ctx, { sku, limit: 100 });
    if (!history.ok) return NextResponse.json({ error: history.error }, { status: 404 });
    const movements = (history.data as { movements?: unknown[] } | null)?.movements ?? [];
    return NextResponse.json({ movements });
  }

  const stock = await executor.execute("inventory.stockReport", ctx, { belowReorderOnly: false });
  if (!stock.ok) return NextResponse.json({ error: stock.error }, { status: 500 });
  const alertsRun = await executor.execute("inventory.stockReport", ctx, { belowReorderOnly: true });

  type ReportItem = {
    sku: string;
    name: string;
    unitLabel: string;
    onHandThousandths: number;
    valueMinor: number;
    avgUnitCostMinor: number;
    reservedThousandths: number;
    availableThousandths: number;
    reorderPointThousandths: number;
    reorderNeeded: boolean;
  };
  const reportItems = ((stock.data as { items?: ReportItem[] } | undefined)?.items ?? []).map((i) => ({
    ...i,
    totalValueMinor: i.valueMinor,
  }));
  const reorderAlerts = (((alertsRun.ok ? alertsRun.data : undefined) as { items?: ReportItem[] } | undefined)?.items ?? []).map(
    (a) => ({
      sku: a.sku,
      name: a.name,
      onHandThousandths: a.onHandThousandths,
      reorderPointThousandths: a.reorderPointThousandths,
      shortfallThousandths: Math.max(0, a.reorderPointThousandths - a.onHandThousandths),
      avgUnitCostMinor: a.avgUnitCostMinor,
    }),
  );

  const itemRows = await db.select({ id: items.id, sku: items.sku }).from(items).where(eq(items.orgId, orgId));
  const skuOf = new Map(itemRows.map((r) => [r.id, r.sku]));

  const locations = await db
    .select()
    .from(stockLocations)
    .where(eq(stockLocations.orgId, orgId))
    .orderBy(stockLocations.code);

  const reservations = await db
    .select()
    .from(stockReservations)
    .where(eq(stockReservations.orgId, orgId))
    .orderBy(desc(stockReservations.createdAt))
    .limit(100);

  const counts = await db
    .select()
    .from(cycleCounts)
    .where(eq(cycleCounts.orgId, orgId))
    .orderBy(desc(cycleCounts.createdAt))
    .limit(20);
  const countIds = counts.map((c) => c.id);
  const countLines = countIds.length
    ? await db.select().from(cycleCountLines).where(inArray(cycleCountLines.countId, countIds))
    : [];
  const locationCodeById = new Map(locations.map((l) => [l.id, l.code]));

  const lotRows = await db.select().from(lots).where(eq(lots.orgId, orgId)).orderBy(desc(lots.createdAt)).limit(200);

  return NextResponse.json({
    items: reportItems,
    totalValueMinor: (stock.data as { totalValueMinor?: number } | undefined)?.totalValueMinor ?? 0,
    reorderAlerts,
    locations,
    reservations: reservations.map((r) => ({ ...r, sku: skuOf.get(r.itemId) ?? "" })),
    cycleCounts: counts.map((c) => ({
      id: c.id,
      status: c.status,
      note: c.note,
      locationCode: c.locationId ? (locationCodeById.get(c.locationId) ?? null) : null,
      createdAt: c.createdAt,
      lines: countLines
        .filter((l) => l.countId === c.id)
        .map((l) => ({
          sku: skuOf.get(l.itemId) ?? "",
          expectedThousandths: l.expectedThousandths,
          countedThousandths: l.countedThousandths,
          varianceThousandths: l.countedThousandths === null ? null : l.countedThousandths - l.expectedThousandths,
        })),
    })),
    lots: lotRows.map((l) => ({ id: l.id, lotCode: l.lotCode, sku: skuOf.get(l.itemId) ?? "", expiresAt: l.expiresAt })),
  });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const body = (await req.json()) as Record<string, unknown>;
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
  const num = (k: string) => (typeof body[k] === "number" ? (body[k] as number) : undefined);

  switch (body.action) {
    case "createItem":
      if (!str("sku") || !str("name")) return NextResponse.json({ error: "sku and name required" }, { status: 400 });
      return respond(
        await executor.execute("inventory.createItem", ctx, {
          sku: str("sku")!,
          name: str("name")!,
          unitLabel: str("unitLabel") ?? "unit",
          salePriceMinor: num("salePriceMinor") ?? 0,
          reorderPointThousandths: num("reorderPointThousandths") ?? 0,
        }),
      );
    case "archiveItem":
      if (!str("sku")) return NextResponse.json({ error: "sku required" }, { status: 400 });
      return respond(
        await executor.execute("inventory.archiveItem", ctx, {
          sku: str("sku")!,
          archive: body.archive !== false,
        }),
      );
    case "adjustStock": {
      if (!str("sku") || !num("quantityDelta") || !str("note"))
        return NextResponse.json({ error: "sku, quantityDelta and note required" }, { status: 400 });
      return respond(
        await executor.execute("inventory.adjustStock", ctx, {
          sku: str("sku")!,
          quantityDelta: num("quantityDelta")!,
          note: str("note")!,
          lotCode: str("lotCode"),
        }),
      );
    }
    case "stockHistory": {
      if (!str("sku")) return NextResponse.json({ error: "sku required" }, { status: 400 });
      return respond(await executor.execute("inventory.stockHistory", ctx, { sku: str("sku")!, limit: num("limit") ?? 50 }));
    }
    case "reserveStock": {
      if (!str("sku") || !num("quantityThousandths") || !str("reason"))
        return NextResponse.json({ error: "sku, quantityThousandths and reason required" }, { status: 400 });
      return respond(
        await executor.execute("inventory.reserveStock", ctx, {
          sku: str("sku")!,
          quantityThousandths: num("quantityThousandths")!,
          reason: str("reason")!,
        }),
      );
    }
    case "releaseReservation":
      if (!str("reservationId")) return NextResponse.json({ error: "reservationId required" }, { status: 400 });
      return respond(await executor.execute("inventory.releaseReservation", ctx, { reservationId: str("reservationId")! }));
    case "startCycleCount":
    case "createCycleCount":
      return respond(
        await executor.execute("inventory.createCycleCount", ctx, {
          note: str("note"),
          skus: Array.isArray(body.skus) ? (body.skus as string[]) : undefined,
        }),
      );
    case "recordCycleCounts": {
      const entries = (body.entries ?? body.counts) as { sku: string; countedThousandths: number }[] | undefined;
      if (!str("countId") || !entries?.length)
        return NextResponse.json({ error: "countId and entries required" }, { status: 400 });
      return respond(await executor.execute("inventory.recordCycleCounts", ctx, { countId: str("countId")!, counts: entries }));
    }
    case "postCycleCount":
      if (!str("countId")) return NextResponse.json({ error: "countId required" }, { status: 400 });
      return respond(await executor.execute("inventory.postCycleCount", ctx, { countId: str("countId")! }));
    case "cancelCycleCount":
      if (!str("countId")) return NextResponse.json({ error: "countId required" }, { status: 400 });
      return respond(await executor.execute("inventory.cancelCycleCount", ctx, { countId: str("countId")! }));
    case "createLocation":
      if (!str("code") || !str("name")) return NextResponse.json({ error: "code and name required" }, { status: 400 });
      return respond(await executor.execute("inventory.createLocation", ctx, { code: str("code")!, name: str("name")! }));
    default:
      return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
}

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}

