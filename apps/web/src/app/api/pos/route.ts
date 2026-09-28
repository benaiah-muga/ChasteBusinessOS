import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { customers, getDb, invoiceLines, invoices, payments, posReturnLines, posReturns, posSessions, stockMovements } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { missingPermission } from "@/server/route-guards";
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";

const noStore = { "Cache-Control": "no-store" };

function goUnavailable() {
  return NextResponse.json({ error: "POS service unavailable; check register status before retrying" }, { status: 503, headers: noStore });
}

async function posGoResponse(result: GoCapabilityBridgeResult) {
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
      return NextResponse.json({ ok: false, pendingApproval: true, reason: parsed.data.reason }, { status: 202, headers: noStore });
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

async function dispatchPosGo(
  actionContext: NonNullable<ReturnType<typeof actorFromResolved>>,
  session: NonNullable<Awaited<ReturnType<typeof getResolvedUser>>>,
  capabilityId: string,
  input: Record<string, unknown>,
) {
  try {
    return await posGoResponse(await executeGoCapability({ actionContext, session, capabilityId, input }));
  } catch {
    return goUnavailable();
  }
}

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const denied = missingPermission(resolved, "pos.read");
  if (denied) return denied;
  const rows = await getDb()
    .db.select()
    .from(posSessions)
    .where(eq(posSessions.orgId, resolved.orgId))
    .orderBy(desc(posSessions.openedAt))
    .limit(20);
  const saleRows = await getDb()
    .db.select({
      id: invoices.id,
      number: invoices.number,
      status: invoices.status,
      totalMinor: invoices.totalMinor,
      creditedMinor: invoices.creditedMinor,
      memo: invoices.memo,
      createdAt: invoices.createdAt,
      customerId: invoices.customerId,
      customerName: customers.name,
    })
    .from(invoices)
    .leftJoin(customers, eq(invoices.customerId, customers.id))
    .where(and(eq(invoices.orgId, resolved.orgId), isNotNull(invoices.posSessionId)))
    .orderBy(desc(invoices.number))
    .limit(20);
  const saleLines = saleRows.length
    ? await getDb()
        .db.select({
          id: invoiceLines.id,
          invoiceId: invoiceLines.invoiceId,
          itemId: invoiceLines.itemId,
          description: invoiceLines.description,
          quantity: invoiceLines.quantity,
          unitPriceMinor: invoiceLines.unitPriceMinor,
          taxMinor: invoiceLines.taxMinor,
        })
        .from(invoiceLines)
        .where(inArray(invoiceLines.invoiceId, saleRows.map((sale) => sale.id)))
    : [];
  const paymentRows = saleRows.length
    ? await getDb().db.select({ invoiceId: payments.invoiceId, method: payments.method }).from(payments).where(inArray(payments.invoiceId, saleRows.map((sale) => sale.id)))
    : [];
  const saleIds = saleRows.map((sale) => sale.id);
  const [returnLines, returnHeaders, stockRows] = saleIds.length
    ? await Promise.all([
        getDb().db.select({ invoiceLineId: posReturnLines.invoiceLineId, quantity: posReturnLines.quantity }).from(posReturnLines).where(and(eq(posReturnLines.orgId, resolved.orgId), inArray(posReturnLines.invoiceLineId, saleLines.map((line) => line.id)))),
        getDb().db.select({ invoiceId: posReturns.invoiceId, refundMinor: posReturns.refundMinor }).from(posReturns).where(and(eq(posReturns.orgId, resolved.orgId), inArray(posReturns.invoiceId, saleIds))),
        getDb().db.select({ invoiceId: stockMovements.refId, itemId: stockMovements.itemId, quantityDelta: stockMovements.quantityDelta }).from(stockMovements).where(and(eq(stockMovements.orgId, resolved.orgId), eq(stockMovements.refType, "invoice"), inArray(stockMovements.refId, saleIds))),
      ])
    : [[], [], []];
  const methodsByInvoice = new Map<string, string[]>();
  for (const payment of paymentRows) {
    const methods = methodsByInvoice.get(payment.invoiceId) ?? [];
    if (!methods.includes(payment.method)) methods.push(payment.method);
    methodsByInvoice.set(payment.invoiceId, methods);
  }
  const linesByInvoice = new Map<string, typeof saleLines>();
  for (const line of saleLines) {
    const current = linesByInvoice.get(line.invoiceId) ?? [];
    current.push(line);
    linesByInvoice.set(line.invoiceId, current);
  }
  const returnedQuantityByLine = new Map<string, number>();
  for (const line of returnLines) returnedQuantityByLine.set(line.invoiceLineId, (returnedQuantityByLine.get(line.invoiceLineId) ?? 0) + line.quantity);
  const structuredCreditByInvoice = new Map<string, number>();
  for (const row of returnHeaders) structuredCreditByInvoice.set(row.invoiceId, (structuredCreditByInvoice.get(row.invoiceId) ?? 0) + row.refundMinor);
  const stockItemIdsByInvoice = new Map<string, Set<string>>();
  for (const leg of stockRows) {
    if (leg.quantityDelta >= 0 || !leg.invoiceId) continue;
    const itemIds = stockItemIdsByInvoice.get(leg.invoiceId) ?? new Set<string>();
    itemIds.add(leg.itemId);
    stockItemIdsByInvoice.set(leg.invoiceId, itemIds);
  }
  return NextResponse.json({
    sessions: rows.map((s) => ({
      ...s,
      openedAt: s.openedAt.toISOString(),
      closedAt: s.closedAt?.toISOString() ?? null,
    })),
    sales: saleRows.map((s) => ({
      id: s.id,
      number: s.number,
      status: s.status,
      totalMinor: s.totalMinor,
      creditedMinor: s.creditedMinor,
      memo: s.memo,
      customerId: s.customerId,
      customerName: s.customerName,
      method: methodsByInvoice.get(s.id)?.join(" + ") ?? (s.memo?.match(/POS \((cash|card|mobile_money)\)/)?.[1] ?? "cash"),
      unallocatedCreditMinor: Math.max(0, s.creditedMinor - (structuredCreditByInvoice.get(s.id) ?? 0)),
      returnMode: s.creditedMinor > (structuredCreditByInvoice.get(s.id) ?? 0)
        ? "credit-review"
        : [...(stockItemIdsByInvoice.get(s.id) ?? [])].some((itemId) => !(linesByInvoice.get(s.id) ?? []).some((line) => line.itemId === itemId))
          ? "legacy-full"
          : "itemized",
      lines: (linesByInvoice.get(s.id) ?? []).map((line) => ({
        id: line.id,
        itemId: line.itemId,
        description: line.description,
        quantity: line.quantity,
        unitPriceMinor: line.unitPriceMinor,
        taxMinor: line.taxMinor,
        returnedQuantity: returnedQuantityByLine.get(line.id) ?? 0,
        stockTracked: line.itemId !== null && (stockItemIdsByInvoice.get(s.id)?.has(line.itemId) ?? false),
      })),
      createdAt: s.createdAt.toISOString(),
    })),
  });
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open"),
    openingFloatMinor: z.number().int().nonnegative().default(0),
  }),
  z.object({
    action: z.literal("sale"),
    sessionId: z.string(),
    method: z.enum(["cash", "card"]).default("cash"),
    customerId: z.string().uuid().optional(),
    cashReceivedMinor: z.number().int().nonnegative().optional(),
    tenders: z.array(z.object({
      method: z.enum(["cash", "card", "mobile_money"]),
      amountMinor: z.number().int().positive(),
    })).min(1).max(3).optional(),
    lines: z
      .array(
        z.object({
          description: z.string().min(1),
          quantity: z.number().int().positive(),
          unitPriceMinor: z.number().int().nonnegative(),
          sku: z.string().min(1).max(80).optional(),
        }),
      )
      .min(1),
  }),
  z.object({
    action: z.literal("close"),
    sessionId: z.string(),
    countedCashMinor: z.number().int().nonnegative(),
    varianceReason: z.string().trim().min(3).max(500).optional(),
  }),
  z.object({
    action: z.literal("returnSale"),
    invoiceId: z.string().uuid(),
    reason: z.string().min(3).max(500),
    refundMethod: z.enum(["cash", "card", "mobile_money"]),
    lines: z.array(z.object({ invoiceLineId: z.string().uuid(), quantity: z.number().int().positive() })).min(1).optional(),
  }),
  z.object({
    action: z.literal("shiftSummary"),
    sessionId: z.string().uuid(),
  }),
]);

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const intentId = typeof raw?.intentId === "string" ? raw.intentId : undefined;
  const humanCtx = resolved ? actorFromResolved(resolved, { intentId }) : null;
  if (!resolved?.orgId || !humanCtx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = actionSchema.safeParse(raw);
  if (!body.success) return NextResponse.json({ error: "invalid body", detail: body.error.issues }, { status: 400 });

  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));
  const goWrites = process.env.GO_POS_WRITES === "1";

  let result;
  if (body.data.action === "open") {
    if (goWrites) {
      return dispatchPosGo(humanCtx, resolved, "pos.openSession", {
        register: "main",
        openingFloatMinor: body.data.openingFloatMinor,
      });
    }
    result = await executor.execute("pos.openSession", humanCtx, {
      openingFloatMinor: body.data.openingFloatMinor,
    });
  } else if (body.data.action === "sale") {
    // Only open sessions can take sales, enforced inside the capability.
    const [session] = await db
      .select({ status: posSessions.status })
      .from(posSessions)
      .where(and(eq(posSessions.id, body.data.sessionId), eq(posSessions.orgId, resolved.orgId)))
      .limit(1);
    if (session?.status !== "open") {
      return NextResponse.json({ ok: false, error: "no open register session" }, { status: 422 });
    }
    if (goWrites) {
      return dispatchPosGo(humanCtx, resolved, "pos.completeSale", {
        sessionId: body.data.sessionId,
        method: body.data.method,
        ...(body.data.customerId ? { customerId: body.data.customerId } : {}),
        ...(body.data.cashReceivedMinor !== undefined ? { cashReceivedMinor: body.data.cashReceivedMinor } : {}),
        ...(body.data.tenders ? { tenders: body.data.tenders } : {}),
        lines: body.data.lines.map((line) => ({ ...line, taxMinor: 0 })),
      });
    }
    result = await executor.execute("pos.completeSale", humanCtx, {
      sessionId: body.data.sessionId,
      method: body.data.method,
      ...(body.data.customerId ? { customerId: body.data.customerId } : {}),
      ...(body.data.cashReceivedMinor !== undefined ? { cashReceivedMinor: body.data.cashReceivedMinor } : {}),
      ...(body.data.tenders ? { tenders: body.data.tenders } : {}),
      lines: body.data.lines,
    });
  } else if (body.data.action === "returnSale") {
    // money-risk with no declared amount: the gate always holds, a 202 with
    // pendingApproval is the normal outcome until someone approves it.
    const input = {
      invoiceId: body.data.invoiceId,
      reason: body.data.reason,
      refundMethod: body.data.refundMethod,
      ...(body.data.lines ? { lines: body.data.lines } : {}),
    };
    if (goWrites) return dispatchPosGo(humanCtx, resolved, "pos.returnSale", input);
    result = await executor.execute("pos.returnSale", humanCtx, input);
  } else if (body.data.action === "shiftSummary") {
    if (goWrites) return dispatchPosGo(humanCtx, resolved, "pos.shiftSummary", { sessionId: body.data.sessionId });
    result = await executor.execute("pos.shiftSummary", humanCtx, {
      sessionId: body.data.sessionId,
    });
  } else {
    const input = {
      sessionId: body.data.sessionId,
      countedCashMinor: body.data.countedCashMinor,
      ...(body.data.varianceReason ? { varianceReason: body.data.varianceReason } : {}),
    };
    if (goWrites) return dispatchPosGo(humanCtx, resolved, "pos.closeSession", input);
    result = await executor.execute("pos.closeSession", humanCtx, input);
  }

  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
