import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { customers, getDb, invoiceLines, invoices, payments, posSessions } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";
import { missingPermission } from "@/server/route-guards";

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
          invoiceId: invoiceLines.invoiceId,
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
      lines: linesByInvoice.get(s.id) ?? [],
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

  let result;
  if (body.data.action === "open") {
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
    result = await executor.execute("pos.returnSale", humanCtx, {
      invoiceId: body.data.invoiceId,
      reason: body.data.reason,
      refundMethod: body.data.refundMethod,
    });
  } else if (body.data.action === "shiftSummary") {
    result = await executor.execute("pos.shiftSummary", humanCtx, {
      sessionId: body.data.sessionId,
    });
  } else {
    result = await executor.execute("pos.closeSession", humanCtx, {
      sessionId: body.data.sessionId,
      countedCashMinor: body.data.countedCashMinor,
      ...(body.data.varianceReason ? { varianceReason: body.data.varianceReason } : {}),
    });
  }

  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
