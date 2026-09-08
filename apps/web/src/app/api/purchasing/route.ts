import { NextResponse } from "next/server";
import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, poLines, purchaseOrders, purchaseRequests, rfqs, vendorBills, vendors } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * Full human surface for the purchasing module: vendors, orders, receipts,
 * bills, payments, and AP aging — every capability the agent has, through
 * the same governed executor.
 */
export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = resolved.orgId;
  const db = getDb().db;

  const registry = buildRegistry(db);
  const executor = buildExecutor(db, registry);
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  const vendorRows = await db.select().from(vendors).where(eq(vendors.orgId, orgId)).orderBy(asc(vendors.name));
  const vendorName = new Map(vendorRows.map((v) => [v.id, v.name]));

  const orderRows = await db
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.orgId, orgId))
    .orderBy(desc(purchaseOrders.createdAt))
    .limit(100);
  const orderIds = orderRows.map((o) => o.id);
  const lines = orderIds.length
    ? await db.select().from(poLines).where(inArray(poLines.poId, orderIds)).orderBy(poLines.id)
    : [];
  const ordersUi = orderRows.map((o) => {
    const ol = lines.filter((l) => l.poId === o.id);
    const ordered = ol.reduce((s, l) => s + Math.round((l.quantity * l.unitPriceMinor) / 1000), 0);
    return {
      id: o.id,
      number: o.number,
      vendorName: vendorName.get(o.vendorId) ?? "",
      status: o.status,
      memo: o.memo,
      orderedMinor: ordered,
      lines: ol.map((l, i) => ({
        lineNumber: i + 1,
        description: l.description,
        quantity: l.quantity,
        unitPriceMinor: l.unitPriceMinor,
      })),
    };
  });

  const billRows = await db
    .select()
    .from(vendorBills)
    .where(eq(vendorBills.orgId, orgId))
    .orderBy(desc(vendorBills.createdAt))
    .limit(100);

  const aging = await executor.execute("purchasing.apAging", ctx, {});
  if (!aging.ok) return NextResponse.json({ error: aging.error }, { status: 500 });

  const priceHistory = await executor.execute("purchasing.priceHistory", ctx, {});
  if (!priceHistory.ok) return NextResponse.json({ error: priceHistory.error }, { status: 500 });

  // Procure-to-pay workflow: requests with their RFQ bids.
  const requestRows = await db
    .select()
    .from(purchaseRequests)
    .where(eq(purchaseRequests.orgId, orgId))
    .orderBy(desc(purchaseRequests.createdAt))
    .limit(50);
  const rfqRows = requestRows.length
    ? await db.select().from(rfqs).where(eq(rfqs.orgId, orgId))
    : [];

  void sql;
  return NextResponse.json({
    vendors: vendorRows,
    orders: ordersUi,
    bills: billRows.map((b) => ({
      number: b.number,
      vendorName: vendorName.get(b.vendorId) ?? "",
      vendorRef: b.vendorRef,
      memo: b.memo,
      totalMinor: b.totalMinor,
      paidMinor: b.paidMinor,
      dueMinor: b.totalMinor - b.paidMinor,
      createdAt: b.createdAt,
    })),
    apAging: aging.data ?? {},
    priceHistory: priceHistory.data ?? { rows: [] },
    requests: requestRows.map((r) => ({
      id: r.id,
      title: r.title,
      justification: r.justification,
      estimatedAmountMinor: r.estimatedAmountMinor,
      status: r.status,
      decisionReason: r.decisionReason,
      createdAt: r.createdAt,
      rfqs: rfqRows
        .filter((f) => f.requestId === r.id)
        .map((f) => ({
          id: f.id,
          vendorName: vendorName.get(f.vendorId) ?? "",
          status: f.status,
          quoteAmountMinor: f.quoteAmountMinor,
          quoteLeadTimeDays: f.quoteLeadTimeDays,
          quoteNotes: f.quoteNotes,
        })),
    })),
  });
}

interface Body {
  action?: string;
  [k: string]: unknown;
}

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const ctx = actorFromResolved(resolved, {});
  if (!ctx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  switch (body.action) {
    case "createVendor":
      return respond(
        await executor.execute("purchasing.createVendor", ctx, {
          name: body.name as string,
          email: (body.email as string) || undefined,
        }),
      );
    case "createPurchaseOrder": {
      const lines = body.lines as { description: string; quantity: number; unitPriceMinor: number; sku?: string }[] | undefined;
      if (!body.vendorId || !lines?.length)
        return NextResponse.json({ error: "vendorId and lines are required" }, { status: 400 });
      return respond(
        await executor.execute("purchasing.createPurchaseOrder", ctx, {
          vendorId: body.vendorId as string,
          lines,
          memo: (body.memo as string) || undefined,
        }),
      );
    }
    case "receiveGoods": {
      const lines = body.lines as { lineNumber: number; quantity: number }[] | undefined;
      if (!body.poNumber || !lines?.length)
        return NextResponse.json({ error: "poNumber and lines are required" }, { status: 400 });
      return respond(
        await executor.execute("purchasing.receiveGoods", ctx, {
          poNumber: body.poNumber as number,
          lines,
        }),
      );
    }
    case "createBill": {
      const lines = body.lines as { description: string; quantity: number; unitPriceMinor: number; poLineNumber?: number }[] | undefined;
      if (!body.vendorId || !lines?.length)
        return NextResponse.json({ error: "vendorId and lines are required" }, { status: 400 });
      return respond(
        await executor.execute("purchasing.createBill", ctx, {
          vendorId: body.vendorId as string,
          vendorRef: (body.vendorRef as string) || undefined,
          memo: (body.memo as string) || undefined,
          poNumber: (body.poNumber as number) || undefined,
          lines,
        }),
      );
    }
    case "payBill":
      if (!body.billNumber || !body.amountMinor)
        return NextResponse.json({ error: "billNumber and amountMinor are required" }, { status: 400 });
      return respond(
        await executor.execute("purchasing.payBill", ctx, {
          billNumber: body.billNumber as number,
          amountMinor: body.amountMinor as number,
          method: (body.method as "cash" | "bank_transfer" | "card") ?? "bank_transfer",
        }),
      );
    case "createPurchaseRequest":
      return respond(
        await executor.execute("purchasing.createPurchaseRequest", ctx, {
          title: body.title as string,
          justification: body.justification as string,
          estimatedAmountMinor: (body.estimatedAmountMinor as number) || undefined,
        }),
      );
    case "decidePurchaseRequest":
      return respond(
        await executor.execute("purchasing.decidePurchaseRequest", ctx, {
          requestId: body.requestId as string,
          decision: body.decision as "approve" | "reject",
          reason: (body.reason as string) || undefined,
        }),
      );
    case "createRfq": {
      const vendorIds = body.vendorIds as string[] | undefined;
      if (!body.requestId || !vendorIds?.length)
        return NextResponse.json({ error: "requestId and vendorIds are required" }, { status: 400 });
      return respond(
        await executor.execute("purchasing.createRfq", ctx, { requestId: body.requestId as string, vendorIds }),
      );
    }
    case "recordQuote":
      return respond(
        await executor.execute("purchasing.recordQuote", ctx, {
          rfqId: body.rfqId as string,
          amountMinor: body.amountMinor as number,
          leadTimeDays: (body.leadTimeDays as number) || undefined,
          notes: (body.notes as string) || undefined,
        }),
      );
    case "selectWinningQuote":
      return respond(
        await executor.execute("purchasing.selectWinningQuote", ctx, { rfqId: body.rfqId as string }),
      );
    case "priceHistory":
      return respond(
        await executor.execute("purchasing.priceHistory", ctx, {
          sku: (body.sku as string) || undefined,
        }),
      );
    case "supplierStatement": {
      if (!body.vendorId) return NextResponse.json({ error: "vendorId is required" }, { status: 400 });
      return respond(
        await executor.execute("purchasing.supplierStatement", ctx, { vendorId: body.vendorId as string }),
      );
    }
    default:
      return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
}

