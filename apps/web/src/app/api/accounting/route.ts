import { NextResponse } from "next/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  customers,
  getDb,
  invoices,
  journalEntries,
  journalLines,
  payments,
  periods,
  salesTaxFilings,
  organizations,
  vendorBills,
  vendors,
} from "@chaste/db";
import { computeAging } from "@chaste/erp-core";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { documentOutstanding } from "@/server/balances";
import { getResolvedUser } from "@/server/session";
import { missingPermission } from "@/server/route-guards";
import { executeAtomically } from "@/server/unit-of-work";

export async function GET() {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const denied = missingPermission(resolved, "accounting.read");
  if (denied) return denied;
  const orgId = resolved.orgId;
  const db = getDb().db;
  const [org] = await db.select({ baseCurrency: organizations.baseCurrency }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  const ctx = actorFromResolved(resolved, {});
  const executor = ctx ? buildExecutor(db, buildRegistry(db)) : null;

  const entries = await db
    .select({
      id: journalEntries.id,
      memo: journalEntries.memo,
      sourceType: journalEntries.sourceType,
      reversalOfId: journalEntries.reversalOfId,
      postedAt: journalEntries.postedAt,
      actorType: journalEntries.postedByActorType,
      currency: journalEntries.currency,
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
      creditedMinor: invoices.creditedMinor,
      paidMinor: invoices.paidMinor,
      issuedAt: invoices.issuedAt,
      dueAt: invoices.dueAt,
      currency: invoices.currency,
    })
    .from(invoices)
    .where(and(eq(invoices.orgId, orgId), sql`${invoices.status} <> 'void'`, sql`${invoices.voidedAt} is null`))
    .orderBy(desc(invoices.issuedAt));

  const now = new Date();
  const outstanding = openRows
    .map((r) => ({ ...r, outstandingMinor: documentOutstanding(r) }))
    .filter((r) => r.outstandingMinor > 0 && r.issuedAt !== null);
  const baseCurrency = org?.baseCurrency ?? "USD";
  const baseOutstanding = outstanding.filter((r) => r.currency === baseCurrency);
  const buckets = computeAging(
    baseOutstanding.map((r) => ({
      invoiceNumber: r.number,
      outstandingMinor: r.outstandingMinor,
      issuedAt: r.issuedAt as Date,
      dueAt: r.dueAt,
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
      creditedMinor: vendorBills.creditedMinor,
      paidMinor: vendorBills.paidMinor,
      currency: vendorBills.currency,
      vendorName: vendors.name,
    })
    .from(vendorBills)
    .innerJoin(vendors, eq(vendors.id, vendorBills.vendorId))
    .where(and(eq(vendorBills.orgId, orgId), sql`${vendorBills.status} <> 'void'`))
    .orderBy(desc(vendorBills.number));

  const filings = await db
    .select({
      id: salesTaxFilings.id,
      periodFrom: salesTaxFilings.periodFrom,
      periodTo: salesTaxFilings.periodTo,
      taxMinor: salesTaxFilings.taxMinor,
      createdAt: salesTaxFilings.createdAt,
    })
    .from(salesTaxFilings)
    .where(eq(salesTaxFilings.orgId, orgId))
    .orderBy(desc(salesTaxFilings.createdAt))
    .limit(20);

  const customerRows = await db
    .select({ id: customers.id, name: customers.name, paymentTermDays: customers.paymentTermDays })
    .from(customers)
    .where(eq(customers.orgId, orgId))
    .orderBy(asc(customers.name));

  // Governed invoice read + payment history (no list capability for payments).
  const invoiceList =
    executor && ctx
      ? await executor.execute("accounting.listInvoices", ctx, { limit: 50 })
      : { ok: false as const, data: undefined };
  const paymentRows = await db
    .select({
      id: payments.id,
      invoiceNumber: invoices.number,
      currency: invoices.currency,
      amountMinor: payments.amountMinor,
      method: payments.method,
      receivedAt: payments.receivedAt,
    })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(eq(payments.orgId, orgId))
    .orderBy(desc(payments.receivedAt))
    .limit(50);
  const agingInvoices = outstanding
    .map((r) => ({
      number: r.number,
      currency: r.currency,
      outstandingMinor: r.outstandingMinor,
      ageDays: Math.floor((now.getTime() - (r.dueAt ?? (r.issuedAt as Date)).getTime()) / 86_400_000),
    }))
    .sort((a, b) => b.ageDays - a.ageDays);

  return NextResponse.json({
    entries: entries.map((e) => ({
      ...e,
      amountMinor: Number(e.debitMinor),
      postedAt: e.postedAt.toISOString(),
    })),
    aging: buckets,
    baseCurrency,
    foreignReceivablesCount: outstanding.filter((r) => r.currency !== baseCurrency).length,
    foreignPayablesCount: bills.filter((b) => b.currency !== baseCurrency && documentOutstanding(b) > 0).length,
    agingInvoices,
    closedPeriods,
    bills: bills.map((b) => ({ ...b, outstandingMinor: documentOutstanding(b) })),
    filings: filings.map((f) => ({
      id: f.id,
      periodFrom: f.periodFrom.toISOString().slice(0, 10),
      periodTo: f.periodTo.toISOString().slice(0, 10),
      taxMinor: Number(f.taxMinor),
      filedAt: f.createdAt.toISOString(),
    })),
    customers: customerRows,
    invoices:
      invoiceList.ok && invoiceList.data
        ? (invoiceList.data as { invoices: unknown[] }).invoices
        : [],
    payments: paymentRows.map((p) => ({ ...p, receivedAt: p.receivedAt.toISOString() })),
  });
}

export async function POST(req: Request) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json()) as {
    action?: string;
    entryId?: string;
    year?: number;
    month?: number;
    billNumber?: number;
    amountMinor?: number;
    from?: string;
    to?: string;
    periodFrom?: string;
    periodTo?: string;
    taxMinor?: number;
    customerId?: string;
    /** Client action identity (B02): stable across retries of one intended action. */
    intentId?: string;
    memo?: string;
    lines?: { description: string; quantity: number; unitPriceMinor: number; taxMinor?: number }[];
    currency?: string;
    fxRate?: string;
    dueAt?: string;
    invoiceNumber?: number;
    method?: "cash" | "bank_transfer" | "card";
    paymentId?: string;
    taxReturnId?: string;
    invoiceId?: string;
    reason?: string;
    quoteCurrency?: string;
    rate?: string;
    effectiveAt?: string;
    budgetScenarioId?: string;
  };
  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  const humanCtx = actorFromResolved(resolved, { intentId: body.intentId });
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
    const input = { billNumber: body.billNumber, amountMinor: body.amountMinor };
    // With a client action identity the payment runs as one unit of work:
    // bill mutation, audit fact and receipt commit or roll back together.
    if (body.intentId) {
      return respond(await executeAtomically({ db, orgId: resolved.orgId, ctx: humanCtx, capabilityId: "purchasing.payBill", input }));
    }
    return respond(await executor.execute("purchasing.payBill", humanCtx, input));
  }
  if (body.action === "salesTaxReport" && body.from && body.to) {
    const result = await executor.execute("accounting.salesTaxReport", humanCtx, {
      from: body.from as string,
      to: body.to as string,
    });
    return respond(result);
  }
  if (body.action === "fileSalesTaxReturn" && body.taxReturnId) {
    const result = await executor.execute("accounting.fileSalesTaxReturn", humanCtx, { taxReturnId: body.taxReturnId });
    return respond(result);
  }
  if (body.action === "customerStatement" && body.customerId) {
    const result = await executor.execute("accounting.customerStatement", humanCtx, {
      customerId: body.customerId,
    });
    return respond(result);
  }
  if (body.action === "buildReminders") {
    const result = await executor.execute("accounting.buildReminders", humanCtx, {});
    return respond(result);
  }
  if (body.action === "cashForecast") {
    const result = await executor.execute("accounting.cashForecast", humanCtx, { budgetScenarioId: body.budgetScenarioId });
    return respond(result);
  }
  if (body.action === "createInvoice" && body.customerId) {
    const lines = body.lines;
    if (!lines?.length) return NextResponse.json({ error: "lines are required" }, { status: 400 });
    return respond(
      await executor.execute("accounting.createInvoice", humanCtx, {
        customerId: body.customerId,
        memo: body.memo || undefined,
        lines,
        currency: body.currency || undefined,
        fxRate: body.fxRate || undefined,
        dueAt: body.dueAt || undefined,
      }),
    );
  }
  if (body.action === "recordPayment" && body.invoiceNumber && body.amountMinor) {
    return respond(
      await executor.execute("accounting.recordPayment", humanCtx, {
        invoiceNumber: body.invoiceNumber,
        amountMinor: body.amountMinor,
        method: body.method ?? "bank_transfer",
        settleFxRate: body.fxRate || undefined,
      }),
    );
  }
  if (body.action === "reversePayment" && body.paymentId && body.reason && body.reason.length >= 3) {
    return respond(
      await executor.execute("accounting.reversePayment", humanCtx, { paymentId: body.paymentId, reason: body.reason }),
    );
  }
  if (body.action === "creditNote" && body.invoiceId && body.amountMinor && body.reason && body.reason.length >= 3) {
    return respond(
      await executor.execute("accounting.creditNote", humanCtx, {
        invoiceId: body.invoiceId,
        amountMinor: body.amountMinor,
        reason: body.reason,
      }),
    );
  }
  if (body.action === "reopenPeriod" && body.year && body.month) {
    return respond(await executor.execute("accounting.reopenPeriod", humanCtx, { year: body.year, month: body.month }));
  }
  if (body.action === "recordFxRate" && body.quoteCurrency && body.rate) {
    return respond(
      await executor.execute("accounting.recordFxRate", humanCtx, {
        quoteCurrency: body.quoteCurrency,
        rate: body.rate,
        effectiveAt: body.effectiveAt || undefined,
      }),
    );
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
