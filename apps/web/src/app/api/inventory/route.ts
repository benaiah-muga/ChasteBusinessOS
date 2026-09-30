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
  stockTransferLines,
  stockTransfers,
} from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { z } from "zod";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";

const noStore = { "Cache-Control": "no-store" };
const inventoryValuationInteger = z.number().int().refine(Number.isSafeInteger);
const inventoryValuationSummaryOutputSchema = z.object({
  posted: z.boolean(),
  entryId: z.string().nullable(),
  varianceMinor: inventoryValuationInteger,
  ledgerValueMinor: inventoryValuationInteger,
  glBalanceMinor: inventoryValuationInteger,
});
const inventoryBarcodeLookupOutputSchema = z.object({
  item: z.object({
    id: z.string(),
    sku: z.string(),
    name: z.string(),
    unitLabel: z.string(),
    imageUrl: z.string().nullable(),
    tags: z.array(z.string()),
  }).nullable(),
});

function goUnavailable() {
  return NextResponse.json({ ok: false, error: "inventory service unavailable; check stock status before retrying" }, { status: 503, headers: noStore });
}

async function inventoryGoResponse(result: GoCapabilityBridgeResult) {
  if (result.kind !== "response") return goUnavailable();
  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(parsed.data, { headers: noStore });
    }
    if (result.response.status === 202) {
      const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(parsed.data, { status: 202, headers: noStore });
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(parsed.data, { status: 422, headers: noStore });
    }
    if (result.response.status === 400 || result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers: noStore });
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(parsed.data, { status: 401, headers: noStore });
    }
  } catch {
    return goUnavailable();
  }
  return goUnavailable();
}

async function dispatchInventoryGo(ctx: ReturnType<typeof actorFromResolved> & {}, session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>, capabilityId: string, input: Record<string, unknown>) {
  try {
    return await inventoryGoResponse(await executeGoCapability({ actionContext: ctx, session, capabilityId, input }));
  } catch {
    return goUnavailable();
  }
}

async function dispatchInventoryBarcodeLookupGo(
  ctx: ReturnType<typeof actorFromResolved> & {},
  session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>,
  barcode: string,
) {
  try {
    const result = await executeGoCapability({
      actionContext: ctx,
      session,
      capabilityId: "inventory.lookupByBarcode",
      input: { barcode },
    });
    if (result.kind !== "response") return goUnavailable();
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: inventoryBarcodeLookupOutputSchema }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(parsed.data, { headers: noStore });
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(parsed.data, { status: 401, headers: noStore });
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(parsed.data, { status: 422, headers: noStore });
    }
    if (result.response.status === 400 || result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers: noStore });
    }
    return goUnavailable();
  } catch {
    return goUnavailable();
  }
}

async function dispatchInventoryValuationSummaryGo(
  ctx: ReturnType<typeof actorFromResolved> & {},
  session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>,
  memo: string | undefined,
) {
  const response = await dispatchInventoryGo(ctx, session, "inventory.postValuationSummary", { memo });
  if (response.status === 202) {
    return NextResponse.json(
      { ok: false, pendingApproval: true, reason: "pending human approval" },
      { status: 202, headers: noStore },
    );
  }
  if (response.status !== 200) return response;
  const parsed = z.object({ ok: z.literal(true), data: inventoryValuationSummaryOutputSchema })
    .safeParse(await response.clone().json().catch(() => null));
  if (!parsed.success) return goUnavailable();
  return NextResponse.json(parsed.data, { headers: noStore });
}

const inventoryHistoryMovementSchema = z.object({
  id: z.string(),
  quantityDelta: z.number().int(),
  reason: z.string(),
  note: z.string().nullable(),
  refType: z.string().nullable(),
  unitCostMinor: z.number().int().nullable(),
  lotCode: z.string().nullable(),
  locationCode: z.string().nullable(),
  actorType: z.string(),
  createdAt: z.string(),
});

async function inventoryHistoryGoResponse(result: GoCapabilityBridgeResult) {
  if (result.kind !== "response") return goUnavailable();
  try {
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({
        ok: z.literal(true),
        data: z.object({ movements: z.array(inventoryHistoryMovementSchema) }),
      }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ movements: parsed.data.data.movements }, { headers: noStore });
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 404, headers: noStore });
    }
    if (result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: 404, headers: noStore });
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(parsed.data, { status: 401, headers: noStore });
    }
  } catch {
    return goUnavailable();
  }
  return goUnavailable();
}

async function dispatchInventoryHistoryGo(ctx: ReturnType<typeof actorFromResolved> & {}, session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>, sku: string) {
  try {
    return await inventoryHistoryGoResponse(await executeGoCapability({
      actionContext: ctx,
      session,
      capabilityId: "inventory.itemHistory",
      input: { sku, limit: 100 },
    }));
  } catch {
    return goUnavailable();
  }
}

const inventoryStockReportItemSchema = z.object({
  sku: z.string(),
  name: z.string(),
  kind: z.string(),
  unitLabel: z.string(),
  salePriceMinor: z.number().int(),
  imageUrl: z.string().nullable(),
  tags: z.array(z.string()),
  barcode: z.string().nullable(),
  onHandThousandths: z.number().int(),
  valueMinor: z.number().int(),
  avgUnitCostMinor: z.number().int(),
  reservedThousandths: z.number().int(),
  availableThousandths: z.number().int(),
  reorderPointThousandths: z.number().int(),
  reorderNeeded: z.boolean(),
});

const inventoryStockReportDataSchema = z.object({
  items: z.array(inventoryStockReportItemSchema),
  totalValueMinor: z.number().int(),
});

async function dispatchInventoryStockReportGo(
  ctx: ReturnType<typeof actorFromResolved> & {},
  session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>,
) {
  try {
    const [stockResult, alertsResult] = await Promise.all([
      executeGoCapability({
        actionContext: ctx,
        session,
        capabilityId: "inventory.stockReport",
        input: { belowReorderOnly: false },
      }),
      executeGoCapability({
        actionContext: ctx,
        session,
        capabilityId: "inventory.stockReport",
        input: { belowReorderOnly: true },
      }),
    ]);
    if (stockResult.kind !== "response" || alertsResult.kind !== "response") return goUnavailable();

    const [stockBody, alertsBody] = await Promise.all([stockResult.response.json(), alertsResult.response.json()]);
    const stockFailure = inventoryStockReportGoFailure(stockResult.response.status, stockBody);
    const alertsFailure = inventoryStockReportGoFailure(alertsResult.response.status, alertsBody);
    if (stockFailure) return stockFailure;
    if (alertsFailure) return alertsFailure;
    const stockEnvelope = z.object({ ok: z.literal(true), data: inventoryStockReportDataSchema }).safeParse(stockBody);
    const alertsEnvelope = z.object({ ok: z.literal(true), data: inventoryStockReportDataSchema }).safeParse(alertsBody);
    if (stockResult.response.status !== 200 || alertsResult.response.status !== 200 || !stockEnvelope.success || !alertsEnvelope.success) {
      return goUnavailable();
    }

    const reportItems = stockEnvelope.data.data.items.map((item) => ({
      ...item,
      totalValueMinor: item.valueMinor,
    }));
    const reorderAlerts = alertsEnvelope.data.data.items.map((item) => ({
      sku: item.sku,
      name: item.name,
      onHandThousandths: item.onHandThousandths,
      reorderPointThousandths: item.reorderPointThousandths,
      shortfallThousandths: Math.max(0, item.reorderPointThousandths - item.onHandThousandths),
      avgUnitCostMinor: item.avgUnitCostMinor,
    }));
    return {
      reportItems,
      reorderAlerts,
      totalValueMinor: stockEnvelope.data.data.totalValueMinor,
    };
  } catch {
    return goUnavailable();
  }
}

function inventoryStockReportGoFailure(status: number, body: unknown): Response | null {
  if (status !== 401 && status !== 403 && status !== 422) return null;
  const parsed = status === 422
    ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(body)
    : z.object({ error: z.string() }).safeParse(body);
  if (!parsed.success) return goUnavailable();
  return NextResponse.json(
    { error: parsed.data.error },
    { status, headers: noStore },
  );
}

const inventoryTransferLineSchema = z.object({
  sku: z.string(),
  quantityThousandths: z.number().int(),
  confirmedThousandths: z.number().int(),
});

const inventoryTransferSchema = z.object({
  id: z.string(),
  number: z.number().int(),
  status: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
  from: z.string(),
  to: z.string(),
  lines: z.array(inventoryTransferLineSchema),
});

async function dispatchInventoryTransfersGo(
  ctx: ReturnType<typeof actorFromResolved> & {},
  session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>,
) {
  try {
    const result = await executeGoCapability({
      actionContext: ctx,
      session,
      capabilityId: "inventory.listTransfers",
      input: { openOnly: false },
    });
    if (result.kind !== "response") return goUnavailable();
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: z.object({ transfers: z.array(inventoryTransferSchema) }) }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return parsed.data.data.transfers.slice(0, 50);
    }
    if ([401, 403, 422].includes(result.response.status)) {
      const parsed = result.response.status === 422
        ? z.object({ ok: z.literal(false), error: z.string() }).safeParse(body)
        : z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json(
        { error: parsed.data.error },
        { status: result.response.status, headers: noStore },
      );
    }
    return goUnavailable();
  } catch {
    return goUnavailable();
  }
}

const inventoryLotSchema = z.object({
  id: z.string(),
  sku: z.string(),
  lotCode: z.string(),
  balanceThousandths: inventoryValuationInteger,
  expiresAt: z.string().datetime({ offset: true }).nullable(),
});

async function dispatchInventoryLotsGo(
  ctx: ReturnType<typeof actorFromResolved> & {},
  session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>,
) {
  try {
    const result = await executeGoCapability({
      actionContext: ctx,
      session,
      capabilityId: "inventory.listLots",
      input: {},
    });
    if (result.kind !== "response") return goUnavailable();

    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({
        ok: z.literal(true),
        data: z.object({ lots: z.array(inventoryLotSchema) }),
      }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return parsed.data.data.lots.slice(0, 200).map(({ id, lotCode, sku, expiresAt }) => ({ id, lotCode, sku, expiresAt }));
    }
    if (result.response.status === 401 || result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: result.response.status, headers: noStore });
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers: noStore });
    }
    return goUnavailable();
  } catch {
    return goUnavailable();
  }
}

const inventoryReservationSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  itemId: z.string(),
  sku: z.string(),
  quantityThousandths: z.number().int().refine(Number.isSafeInteger),
  reason: z.string(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  status: z.string(),
  createdByActorType: z.string().nullable(),
  createdByActorId: z.string().nullable(),
  releasedAt: z.string().datetime({ offset: true }).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});

async function dispatchInventoryReservationsGo(
  ctx: ReturnType<typeof actorFromResolved> & {},
  session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>,
) {
  try {
    const result = await executeGoCapability({
      actionContext: ctx,
      session,
      capabilityId: "inventory.listReservations",
      input: { openOnly: false },
    });
    if (result.kind !== "response") return goUnavailable();

    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({
        ok: z.literal(true),
        data: z.object({ reservations: z.array(inventoryReservationSchema) }),
      }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return parsed.data.data.reservations.slice(0, 100);
    }
    if (result.response.status === 401 || result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: result.response.status, headers: noStore });
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers: noStore });
    }
    return goUnavailable();
  } catch {
    return goUnavailable();
  }
}

const inventoryCycleCountSchema = z.object({
  id: z.string(),
  status: z.string(),
  note: z.string().nullable(),
  locationCode: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  lines: z.array(z.object({
    sku: z.string(),
    expectedThousandths: inventoryValuationInteger,
    countedThousandths: inventoryValuationInteger.nullable(),
    varianceThousandths: inventoryValuationInteger.nullable(),
  })),
});

async function dispatchInventoryCycleCountsGo(
  ctx: ReturnType<typeof actorFromResolved> & {},
  session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>,
) {
  try {
    const result = await executeGoCapability({
      actionContext: ctx,
      session,
      capabilityId: "inventory.listCycleCounts",
      input: {},
    });
    if (result.kind !== "response") return goUnavailable();
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({
        ok: z.literal(true),
        data: z.object({ cycleCounts: z.array(inventoryCycleCountSchema) }),
      }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return parsed.data.data.cycleCounts.slice(0, 20);
    }
    if (result.response.status === 401 || result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: result.response.status, headers: noStore });
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers: noStore });
    }
    return goUnavailable();
  } catch {
    return goUnavailable();
  }
}

async function dispatchInventoryLocationsGo(
  ctx: ReturnType<typeof actorFromResolved> & {},
  session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>,
  orgId: string,
) {
  try {
    const result = await executeGoCapability({
      actionContext: ctx,
      session,
      capabilityId: "inventory.listLocationRecords",
      input: {},
    });
    if (result.kind !== "response") return goUnavailable();
    const body: unknown = await result.response.json();
    if (result.response.status === 200) {
      const parsed = z.object({
        ok: z.literal(true),
        data: z.object({
          locations: z.array(z.object({
            id: z.string().uuid(),
            orgId: z.string().uuid(),
            code: z.string(),
            name: z.string(),
            createdAt: z.string().datetime({ offset: true }),
          }).strict()),
        }).strict(),
      }).strict().safeParse(body);
      if (!parsed.success) return goUnavailable();
      if (parsed.data.data.locations.some((location) => location.orgId !== orgId)) return goUnavailable();
      return parsed.data.data.locations;
    }
    if (result.response.status === 401 || result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ error: parsed.data.error }, { status: result.response.status, headers: noStore });
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return goUnavailable();
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers: noStore });
    }
    return goUnavailable();
  } catch {
    return goUnavailable();
  }
}

export async function GET(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = resolved.orgId;
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  // Per-SKU movement history for the expandable ledger rows.
  const sku = new URL(req.url).searchParams.get("sku");
  if (sku) {
    if (process.env.GO_INVENTORY_ITEM_HISTORY_READS === "1") {
      return dispatchInventoryHistoryGo(ctx, resolved, sku);
    }
    const db = getDb().db;
    const executor = buildExecutor(db, buildRegistry(db));
    const history = await executor.execute("inventory.itemHistory", ctx, { sku, limit: 100 });
    if (!history.ok) return NextResponse.json({ error: history.error }, { status: 404 });
    const movements = (history.data as { movements?: unknown[] } | null)?.movements ?? [];
    return NextResponse.json({ movements });
  }

  const db = getDb().db;
  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);

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
  let reportItems: (ReportItem & { totalValueMinor: number })[];
  let reorderAlerts: { sku: string; name: string; onHandThousandths: number; reorderPointThousandths: number; shortfallThousandths: number; avgUnitCostMinor: number }[];
  let totalValueMinor: number;
  if (process.env.GO_INVENTORY_STOCK_REPORT_READS === "1") {
    const report = await dispatchInventoryStockReportGo(ctx, resolved);
    if (report instanceof Response) return report;
    reportItems = report.reportItems;
    reorderAlerts = report.reorderAlerts;
    totalValueMinor = report.totalValueMinor;
  } else {
    const stock = await executor.execute("inventory.stockReport", ctx, { belowReorderOnly: false });
    if (!stock.ok) return NextResponse.json({ error: stock.error }, { status: 500 });
    const alertsRun = await executor.execute("inventory.stockReport", ctx, { belowReorderOnly: true });
    reportItems = ((stock.data as { items?: ReportItem[] } | undefined)?.items ?? []).map((i) => ({
      ...i,
      totalValueMinor: i.valueMinor,
    }));
    reorderAlerts = (((alertsRun.ok ? alertsRun.data : undefined) as { items?: ReportItem[] } | undefined)?.items ?? []).map(
      (a) => ({
        sku: a.sku,
        name: a.name,
        onHandThousandths: a.onHandThousandths,
        reorderPointThousandths: a.reorderPointThousandths,
        shortfallThousandths: Math.max(0, a.reorderPointThousandths - a.onHandThousandths),
        avgUnitCostMinor: a.avgUnitCostMinor,
      }),
    );
    totalValueMinor = (stock.data as { totalValueMinor?: number } | undefined)?.totalValueMinor ?? 0;
  }

  const itemRows = await db
    .select({
      id: items.id,
      sku: items.sku,
      kind: items.kind,
      unitLabel: items.unitLabel,
      salePriceMinor: items.salePriceMinor,
      barcode: items.barcode,
    })
    .from(items)
    .where(eq(items.orgId, orgId));
  const skuOf = new Map(itemRows.map((r) => [r.id, r.sku]));
  const itemBySku = new Map(itemRows.map(({ sku, ...item }) => [sku, item]));

  let locations: Array<Omit<typeof stockLocations.$inferSelect, "createdAt"> & { createdAt: Date | string }>;
  if (process.env.GO_INVENTORY_LOCATIONS_READS === "1") {
    const goLocations = await dispatchInventoryLocationsGo(ctx, resolved, orgId);
    if (goLocations instanceof Response) return goLocations;
    locations = goLocations;
  } else {
    locations = await db
      .select()
      .from(stockLocations)
      .where(eq(stockLocations.orgId, orgId))
      .orderBy(stockLocations.code);
  }

  let reservations: unknown[];
  if (process.env.GO_INVENTORY_RESERVATIONS_READS === "1") {
    const bridgedReservations = await dispatchInventoryReservationsGo(ctx, resolved);
    if (bridgedReservations instanceof Response) return bridgedReservations;
    reservations = bridgedReservations;
  } else {
    const reservationRows = await db
      .select()
      .from(stockReservations)
      .where(eq(stockReservations.orgId, orgId))
      .orderBy(desc(stockReservations.createdAt))
      .limit(100);
    reservations = reservationRows.map((r) => ({ ...r, sku: skuOf.get(r.itemId) ?? "" }));
  }

  const locationCodeById = new Map(locations.map((l) => [l.id, l.code]));
  let projectedCycleCounts: {
    id: string;
    status: string;
    note: string | null;
    locationCode: string | null;
    createdAt: string | Date;
    lines: { sku: string; expectedThousandths: number; countedThousandths: number | null; varianceThousandths: number | null }[];
  }[];
  if (process.env.GO_INVENTORY_CYCLE_COUNTS_READS === "1") {
    const bridgedCycleCounts = await dispatchInventoryCycleCountsGo(ctx, resolved);
    if (bridgedCycleCounts instanceof Response) return bridgedCycleCounts;
    projectedCycleCounts = bridgedCycleCounts;
  } else {
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
    projectedCycleCounts = counts.map((c) => ({
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
    }));
  }
  let lotList: { id: string; lotCode: string; sku: string; expiresAt: string | Date | null }[];
  if (process.env.GO_INVENTORY_LOTS_READS === "1") {
    const bridgedLots = await dispatchInventoryLotsGo(ctx, resolved);
    if (bridgedLots instanceof Response) return bridgedLots;
    lotList = bridgedLots;
  } else {
    const lotRows = await db.select().from(lots).where(eq(lots.orgId, orgId)).orderBy(desc(lots.createdAt)).limit(200);
    lotList = lotRows.map((lot) => ({
      id: lot.id,
      lotCode: lot.lotCode,
      sku: skuOf.get(lot.itemId) ?? "",
      expiresAt: lot.expiresAt,
    }));
  }

  let transfers: { id: string; number: number; status: string; note: string | null; from: string; to: string; lines: { sku: string; quantityThousandths: number; confirmedThousandths: number }[] }[];
  if (process.env.GO_INVENTORY_TRANSFER_READS === "1") {
    const result = await dispatchInventoryTransfersGo(ctx, resolved);
    if (result instanceof Response) return result;
    transfers = result.map(({ id, number, status, note, from, to, lines }) => ({ id, number, status, note, from, to, lines }));
  } else {
    const transferRows = await db
      .select()
      .from(stockTransfers)
      .where(eq(stockTransfers.orgId, orgId))
      .orderBy(desc(stockTransfers.createdAt))
      .limit(50);
    const transferIds = transferRows.map((t) => t.id);
    const transferLineRows = transferIds.length
      ? await db.select().from(stockTransferLines).where(inArray(stockTransferLines.transferId, transferIds))
      : [];
    transfers = transferRows.map((t) => ({
      id: t.id,
      number: t.number,
      status: t.status,
      note: t.note,
      from: locationCodeById.get(t.fromLocationId) ?? "?",
      to: locationCodeById.get(t.toLocationId) ?? "?",
      lines: transferLineRows
        .filter((l) => l.transferId === t.id)
        .map((l) => ({ sku: skuOf.get(l.itemId) ?? "", quantityThousandths: l.quantityThousandths, confirmedThousandths: l.confirmedThousandths })),
    }));
  }
  return NextResponse.json({
    items: reportItems.map((item) => ({ ...item, ...itemBySku.get(item.sku) })),
    totalValueMinor,
    reorderAlerts,
    locations,
    reservations,
    cycleCounts: projectedCycleCounts,
    lots: lotList,
    transfers,
  });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as Record<string, unknown>;
  const intentId = typeof body.intentId === "string" ? body.intentId : undefined;
  const ctx = actorFromResolved(resolved, { intentId });
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  if (body.action === "lookupByBarcode" && process.env.GO_INVENTORY_BARCODE_LOOKUP_READS === "1") {
    const barcode = typeof body.barcode === "string" ? body.barcode : undefined;
    if (!barcode) return NextResponse.json({ error: "barcode required" }, { status: 400 });
    return dispatchInventoryBarcodeLookupGo(ctx, resolved, barcode);
  }

  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
  const num = (k: string) => (typeof body[k] === "number" ? (body[k] as number) : undefined);

  if (body.action === "postValuationSummary" && process.env.GO_INVENTORY_VALUATION_SUMMARY_WRITE === "1") {
    return await dispatchInventoryValuationSummaryGo(ctx, resolved, str("memo"));
  }

  if (process.env.GO_INVENTORY_ITEM_WRITES === "1" && ["createItem", "updateItem", "archiveItem", "createLocation"].includes((body.action as string | undefined) ?? "")) {
    let capabilityId: string;
    let input: Record<string, unknown>;
    if (body.action === "createItem") {
      if (!str("sku") || !str("name")) return NextResponse.json({ error: "sku and name required" }, { status: 400 });
      capabilityId = "inventory.createItem";
      input = {
        sku: str("sku")!,
        name: str("name")!,
        kind: body.kind === "service" ? "service" : "goods",
        unitLabel: str("unitLabel") ?? "unit",
        salePriceMinor: num("salePriceMinor") ?? 0,
        reorderPointThousandths: num("reorderPointThousandths") ?? 0,
        imageUrl: str("imageUrl"),
        tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
        barcode: str("barcode"),
      };
    } else if (body.action === "updateItem") {
      if (!str("sku")) return NextResponse.json({ error: "sku required" }, { status: 400 });
      capabilityId = "inventory.updateItem";
      input = { sku: str("sku")! };
      for (const key of ["name", "unitLabel", "imageUrl", "barcode"] as const) {
        if (body[key] !== undefined) input[key] = body[key];
      }
      if (body.salePriceMinor !== undefined) input.salePriceMinor = num("salePriceMinor");
      if (Array.isArray(body.tags)) input.tags = body.tags;
    } else if (body.action === "archiveItem") {
      if (!str("sku")) return NextResponse.json({ error: "sku required" }, { status: 400 });
      capabilityId = "inventory.archiveItem";
      input = { sku: str("sku")!, archive: body.archive !== false };
    } else {
      if (!str("code") || !str("name")) return NextResponse.json({ error: "code and name required" }, { status: 400 });
      capabilityId = "inventory.createLocation";
      input = { code: str("code")!, name: str("name")! };
    }
    try {
      return await inventoryGoResponse(await executeGoCapability({ actionContext: ctx, session: resolved, capabilityId, input }));
    } catch {
      return goUnavailable();
    }
  }

  switch (body.action) {
    case "createItem":
      if (!str("sku") || !str("name")) return NextResponse.json({ error: "sku and name required" }, { status: 400 });
      return respond(
        await executor.execute("inventory.createItem", ctx, {
          sku: str("sku")!,
          name: str("name")!,
          kind: body.kind === "service" ? "service" : "goods",
          unitLabel: str("unitLabel") ?? "unit",
          salePriceMinor: num("salePriceMinor") ?? 0,
          reorderPointThousandths: num("reorderPointThousandths") ?? 0,
          imageUrl: str("imageUrl"),
          tags: Array.isArray(body.tags) ? (body.tags as string[]) : [],
          barcode: str("barcode"),
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
      if (process.env.GO_INVENTORY_STOCK_WRITES === "1") {
        return dispatchInventoryGo(ctx, resolved, "inventory.adjustStock", {
          sku: str("sku")!, quantityDelta: num("quantityDelta")!, note: str("note")!, lotCode: str("lotCode"),
        });
      }
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
      if (process.env.GO_INVENTORY_RESERVATION_WRITES === "1") {
        return dispatchInventoryGo(ctx, resolved, "inventory.reserveStock", {
          sku: str("sku")!,
          quantityThousandths: num("quantityThousandths")!,
          reason: str("reason")!,
        });
      }
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
      if (process.env.GO_INVENTORY_RESERVATION_WRITES === "1") {
        return dispatchInventoryGo(ctx, resolved, "inventory.releaseReservation", { reservationId: str("reservationId")! });
      }
      return respond(await executor.execute("inventory.releaseReservation", ctx, { reservationId: str("reservationId")! }));
    case "startCycleCount":
    case "createCycleCount": {
      const input = {
        note: str("note"),
        skus: Array.isArray(body.skus) ? (body.skus as string[]) : undefined,
        locationId: str("locationId"),
      };
      if (body.action === "createCycleCount" && process.env.GO_INVENTORY_CYCLE_COUNTS === "1") {
        return dispatchInventoryGo(ctx, resolved, "inventory.createCycleCount", input);
      }
      return respond(
        await executor.execute("inventory.createCycleCount", ctx, input),
      );
    }
    case "recordCycleCounts": {
      const entries = (body.entries ?? body.counts) as { sku: string; countedThousandths: number }[] | undefined;
      if (!str("countId") || !entries?.length)
        return NextResponse.json({ error: "countId and entries required" }, { status: 400 });
      const input = { countId: str("countId")!, counts: entries };
      if (process.env.GO_INVENTORY_CYCLE_COUNTS === "1") {
        return dispatchInventoryGo(ctx, resolved, "inventory.recordCycleCounts", input);
      }
      return respond(await executor.execute("inventory.recordCycleCounts", ctx, input));
    }
    case "postCycleCount":
      if (!str("countId")) return NextResponse.json({ error: "countId required" }, { status: 400 });
      if (process.env.GO_INVENTORY_CYCLE_COUNTS === "1") {
        return dispatchInventoryGo(ctx, resolved, "inventory.postCycleCount", { countId: str("countId")! });
      }
      return respond(await executor.execute("inventory.postCycleCount", ctx, { countId: str("countId")! }));
    case "cancelCycleCount":
      if (!str("countId")) return NextResponse.json({ error: "countId required" }, { status: 400 });
      if (process.env.GO_INVENTORY_CYCLE_COUNTS === "1") {
        return dispatchInventoryGo(ctx, resolved, "inventory.cancelCycleCount", { countId: str("countId")! });
      }
      return respond(await executor.execute("inventory.cancelCycleCount", ctx, { countId: str("countId")! }));
    case "createLocation":
      if (!str("code") || !str("name")) return NextResponse.json({ error: "code and name required" }, { status: 400 });
      return respond(await executor.execute("inventory.createLocation", ctx, { code: str("code")!, name: str("name")! }));
    case "updateItem": {
      if (!str("sku")) return NextResponse.json({ error: "sku required" }, { status: 400 });
      const patch: Record<string, unknown> = { sku: str("sku")! };
      for (const key of ["name", "unitLabel", "imageUrl", "barcode"] as const) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      if (body.salePriceMinor !== undefined) patch.salePriceMinor = num("salePriceMinor");
      if (Array.isArray(body.tags)) patch.tags = body.tags;
      return respond(await executor.execute("inventory.updateItem", ctx, patch));
    }
    case "lookupByBarcode": {
      if (!str("barcode")) return NextResponse.json({ error: "barcode required" }, { status: 400 });
      return respond(await executor.execute("inventory.lookupByBarcode", ctx, { barcode: str("barcode")! }));
    }
    case "createTransfer": {
      const lines = (body.lines ?? []) as { sku: string; quantityThousandths: number; lotCode?: string }[];
      if (!str("fromLocationCode") || !str("toLocationCode") || lines.length === 0)
        return NextResponse.json({ error: "fromLocationCode, toLocationCode and lines required" }, { status: 400 });
      if (process.env.GO_INVENTORY_STOCK_WRITES === "1") {
        return dispatchInventoryGo(ctx, resolved, "inventory.createTransfer", {
          fromLocationCode: str("fromLocationCode")!, toLocationCode: str("toLocationCode")!, lines, note: str("note"),
        });
      }
      return respond(
        await executor.execute("inventory.createTransfer", ctx, {
          fromLocationCode: str("fromLocationCode")!,
          toLocationCode: str("toLocationCode")!,
          lines,
          note: str("note"),
        }),
      );
    }
    case "confirmTransfer": {
      if (!str("transferId")) return NextResponse.json({ error: "transferId required" }, { status: 400 });
      const lines = (body.lines ?? undefined) as { lineId: string; quantityThousandths: number }[] | undefined;
      if (process.env.GO_INVENTORY_STOCK_WRITES === "1") {
        return dispatchInventoryGo(ctx, resolved, "inventory.confirmTransfer", { transferId: str("transferId")!, lines });
      }
      return respond(await executor.execute("inventory.confirmTransfer", ctx, { transferId: str("transferId")!, lines }));
    }
    case "cancelTransfer":
      if (!str("transferId")) return NextResponse.json({ error: "transferId required" }, { status: 400 });
      if (process.env.GO_INVENTORY_STOCK_WRITES === "1") {
        return dispatchInventoryGo(ctx, resolved, "inventory.cancelTransfer", { transferId: str("transferId")! });
      }
      return respond(await executor.execute("inventory.cancelTransfer", ctx, { transferId: str("transferId")! }));
    case "reverseTransfer":
      if (!str("transferId")) return NextResponse.json({ error: "transferId required" }, { status: 400 });
      if (process.env.GO_INVENTORY_STOCK_WRITES === "1") {
        return dispatchInventoryGo(ctx, resolved, "inventory.reverseTransfer", { transferId: str("transferId")! });
      }
      return respond(await executor.execute("inventory.reverseTransfer", ctx, { transferId: str("transferId")! }));
    case "postValuationSummary":
      return respond(await executor.execute("inventory.postValuationSummary", ctx, { memo: str("memo") }));
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
