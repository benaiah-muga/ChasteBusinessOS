import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  getDb,
  invoices,
  journalEntries,
  journalLines,
  periods,
  vendorBills,
  vendors,
} from "@chaste/db";
import { computeAging } from "@chaste/erp-core";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = resolved.orgId;
  const db = getDb().db;

  const entries = await db
    .select({
      id: journalEntries.id,
      memo: journalEntries.memo,
      sourceType: journalEntries.sourceType,
      reversalOfId: journalEntries.reversalOfId,
      postedAt: journalEntries.postedAt,
      actorType: journalEntries.postedByActorType,
      debitMinor: sql<number>`coalesce(sum(${journalLines.debitMinor}), 0)`,
    })
    .from(journalEntries)
    .leftJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
    .where(eq(journalEntries.orgId, orgId))
    .groupBy(journalEntries.id)
    .orderBy(desc(journalEntries.postedAt))
    .limit(30);

  const openRows = await db
    .select({
      number: invoices.number,
      totalMinor: invoices.totalMinor,
      paidMinor: invoices.paidMinor,
      issuedAt: invoices.issuedAt,
    })
    .from(invoices)
    .where(and(eq(invoices.orgId, orgId), sql`${invoices.totalMinor} > ${invoices.paidMinor}`))
    // Bounded: an org with thousands of open invoices must not drag the
    // dashboard; the aging buckets below aggregate what we fetched.
    .orderBy(desc(invoices.issuedAt))
    .limit(200);

  const now = new Date();
  const outstanding = openRows.filter(
    (r): r is typeof r & { issuedAt: Date } =>
      r.issuedAt !== null && r.totalMinor - r.paidMinor > 0,
  );
  const buckets = computeAging(
    outstanding.map((r) => ({
      invoiceNumber: r.number,
      outstandingMinor: r.totalMinor - r.paidMinor,
      issuedAt: r.issuedAt,
    })),
    now,
  );

  const closedPeriods = await db
    .select({ year: periods.year, month: periods.month })
    .from(periods)
    .where(eq(periods.orgId, orgId));

  const bills = await db
    .select({
      id: vendorBills.id,
      number: vendorBills.number,
      status: vendorBills.status,
      totalMinor: vendorBills.totalMinor,
      paidMinor: vendorBills.paidMinor,
      vendorName: vendors.name,
    })
    .from(vendorBills)
    .innerJoin(vendors, eq(vendors.id, vendorBills.vendorId))
    .where(and(eq(vendorBills.orgId, orgId), sql`${vendorBills.status} <> 'void'`))
    .orderBy(desc(vendorBills.number))
    .limit(30);

  return NextResponse.json({
    entries: entries.map((e) => ({
      ...e,
      amountMinor: Number(e.debitMinor),
      postedAt: e.postedAt.toISOString(),
    })),
    aging: buckets,
    agingInvoices: outstanding.map((r) => ({
      number: r.number,
      outstandingMinor: r.totalMinor - r.paidMinor,
      ageDays: Math.floor((now.getTime() - r.issuedAt.getTime()) / 86_400_000),
    })),
    closedPeriods,
    bills: bills.map((b) => ({ ...b, outstandingMinor: b.totalMinor - b.paidMinor })),
  });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as { action?: string; entryId?: string; year?: number; month?: number; billNumber?: number; amountMinor?: number };
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  const humanCtx = actorFromResolved(resolved, {});
  if (!humanCtx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  if (body.action === "reverse" && body.entryId) {
    const result = await executor.execute("accounting.reverseEntry", humanCtx, { entryId: body.entryId });
    return respond(result);
  }
  if (body.action === "cashBasis" && body.year) {
    const result = await executor.execute("accounting.cashBasisReport", humanCtx, {
      year: body.year,
      ...(body.month ? { month: body.month } : {}),
    });
    return respond(result);
  }
  if (body.action === "closeYear" && body.year) {
    const result = await executor.execute("accounting.closeYear", humanCtx, { year: body.year });
    return respond(result);
  }
  if (body.action === "closePeriod" && body.year && body.month) {
    const result = await executor.execute("accounting.closePeriod", humanCtx, { year: body.year, month: body.month });
    return respond(result);
  }
  if (body.action === "payBill" && body.billNumber && body.amountMinor) {
    const result = await executor.execute("purchasing.payBill", humanCtx, {
      billNumber: body.billNumber,
      amountMinor: body.amountMinor,
    });
    return respond(result);
  }
  return NextResponse.json({ error: "invalid action" }, { status: 400 });
}

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}
