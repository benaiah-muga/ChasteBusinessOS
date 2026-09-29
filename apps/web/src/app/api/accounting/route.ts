import { NextResponse } from "next/server";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
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
import { executeGoCapability, type GoCapabilityBridgeResult } from "@/server/go-bridge";
import { dispatchGoCapabilityRoute } from "@/server/go-route-response";

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
    quoteId?: string;
    templateId?: string;
    frequency?: "weekly" | "monthly" | "quarterly";
    expiresAt?: string;
    firstRunAt?: string;
  };

  const humanCtx = actorFromResolved(resolved, { intentId: body.intentId });
  if (!humanCtx) return NextResponse.json({ error: "onboarding required" }, { status: 428 });

  if (body.action === "recordPayment" && body.invoiceNumber && body.amountMinor && process.env.GO_ACCOUNTING_RECORD_PAYMENT_WRITE === "1") {
    try {
      return await invoiceOpsGoResponse(
        await executeGoCapability({
          actionContext: humanCtx,
          session: { userId: resolved.userId, orgId: resolved.orgId, authSessionId: resolved.authSessionId },
          capabilityId: "accounting.recordPayment",
          input: {
            invoiceNumber: body.invoiceNumber,
            amountMinor: body.amountMinor,
            method: body.method ?? "bank_transfer",
            settleFxRate: body.fxRate || undefined,
          },
        }),
        recordPaymentOutputSchema,
        paymentUnavailable,
      );
    } catch {
      return paymentUnavailable();
    }
  }

  if (body.action === "reversePayment" && body.paymentId && body.reason && body.reason.length >= 3 && process.env.GO_ACCOUNTING_REVERSE_PAYMENT_WRITE === "1") {
    try {
      return await goBridgeResponse(
        await executeGoCapability({
          actionContext: humanCtx,
          session: { userId: resolved.userId, orgId: resolved.orgId, authSessionId: resolved.authSessionId },
          capabilityId: "accounting.reversePayment",
          input: { paymentId: body.paymentId, reason: body.reason },
        }),
        paymentReversalUnavailable,
        reversePaymentOutputSchema,
      );
    } catch {
      return paymentReversalUnavailable();
    }
  }

  if (body.action === "recordFxRate" && body.quoteCurrency && body.rate && process.env.GO_ACCOUNTING_FX_RATE_WRITE === "1") {
    try {
      return await goBridgeResponse(
        await executeGoCapability({
          actionContext: humanCtx,
          session: { userId: resolved.userId, orgId: resolved.orgId, authSessionId: resolved.authSessionId },
          capabilityId: "accounting.recordFxRate",
          input: {
            quoteCurrency: body.quoteCurrency,
            rate: body.rate,
            effectiveAt: body.effectiveAt || undefined,
          },
        }),
        fxRateUnavailable,
        recordFxRateOutputSchema,
      );
    } catch {
      return fxRateUnavailable();
    }
  }

  if (body.action === "createInvoice" && body.customerId) {
    const lines = body.lines;
    if (!lines?.length) return NextResponse.json({ error: "lines are required" }, { status: 400 });
    const input = {
      customerId: body.customerId,
      memo: body.memo || undefined,
      lines,
      currency: body.currency || undefined,
      fxRate: body.fxRate || undefined,
      dueAt: body.dueAt || undefined,
    };

    if (process.env.GO_ACCOUNTING_CREATE_INVOICE === "1") {
      try {
        const result = await executeGoCapability({
          actionContext: humanCtx,
          session: {
            userId: resolved.userId,
            orgId: resolved.orgId,
            authSessionId: resolved.authSessionId,
          },
          capabilityId: "accounting.createInvoice",
          input,
        });
        return createInvoiceGoResponse(result);
      } catch {
        return accountingUnavailable();
      }
    }

    const db = getDb().db;
    const executor = buildExecutor(db, buildRegistry(db));
    return respond(await executor.execute("accounting.createInvoice", humanCtx, input));
  }

  if (body.action === "createQuote" && body.customerId && body.lines?.length && process.env.GO_ACCOUNTING_QUOTES_WRITE === "1") {
    try {
      const result = await executeGoCapability({
        actionContext: humanCtx,
        session: resolved,
        capabilityId: "accounting.createQuote",
        input: {
          customerId: body.customerId,
          memo: body.memo || undefined,
          expiresAt: body.expiresAt || undefined,
          lines: body.lines,
        },
      });
      return goBridgeResponse(result, quoteUnavailable, quoteCreateOutputSchema);
    } catch {
      return quoteUnavailable();
    }
  }

  if (
    (body.action === "acceptQuote" || body.action === "declineQuote") &&
    body.quoteId &&
    process.env.GO_ACCOUNTING_QUOTES_WRITE === "1"
  ) {
    try {
      const result = await executeGoCapability({
        actionContext: humanCtx,
        session: resolved,
        capabilityId: body.action === "acceptQuote" ? "accounting.acceptQuote" : "accounting.declineQuote",
        input: { quoteId: body.quoteId },
      });
      return goBridgeResponse(
        result,
        quoteUnavailable,
        body.action === "acceptQuote" ? quoteAcceptOutputSchema : quoteDeclineOutputSchema,
      );
    } catch {
      return quoteUnavailable();
    }
  }

  if (body.action === "expireQuote" && process.env.GO_ACCOUNTING_QUOTES_WRITE === "1") {
    try {
      const result = await executeGoCapability({
        actionContext: humanCtx,
        session: resolved,
        capabilityId: "accounting.expireQuote",
        input: {},
      });
      return goBridgeResponse(result, quoteUnavailable, quoteExpireOutputSchema);
    } catch {
      return quoteUnavailable();
    }
  }

  if (
    body.action === "createRecurringTemplate" &&
    body.customerId &&
    body.lines?.length &&
    body.frequency &&
    process.env.GO_ACCOUNTING_RECURRING_WRITE === "1"
  ) {
    try {
      const result = await executeGoCapability({
        actionContext: humanCtx,
        session: resolved,
        capabilityId: "accounting.createRecurringTemplate",
        input: {
          customerId: body.customerId,
          frequency: body.frequency,
          memo: body.memo || undefined,
          lines: body.lines,
          firstRunAt: body.firstRunAt || undefined,
        },
      });
      return goBridgeResponse(result, recurringUnavailable, recurringCreateOutputSchema);
    } catch {
      return recurringUnavailable();
    }
  }

  if (
    (body.action === "pauseRecurringTemplate" || body.action === "resumeRecurringTemplate") &&
    body.templateId &&
    process.env.GO_ACCOUNTING_RECURRING_WRITE === "1"
  ) {
    try {
      const result = await executeGoCapability({
        actionContext: humanCtx,
        session: resolved,
        capabilityId:
          body.action === "pauseRecurringTemplate"
            ? "accounting.pauseRecurringTemplate"
            : "accounting.resumeRecurringTemplate",
        input: { templateId: body.templateId },
      });
      return goBridgeResponse(
        result,
        recurringUnavailable,
        body.action === "pauseRecurringTemplate" ? recurringPauseOutputSchema : recurringResumeOutputSchema,
      );
    } catch {
      return recurringUnavailable();
    }
  }

  const db = getDb().db;
  const executor = buildExecutor(db, buildRegistry(db));

  if (
    (body.action === "creditNote" || body.action === "reverse") &&
    process.env.GO_ACCOUNTING_INVOICE_OPS_WRITE === "1"
  ) {
    let capabilityId: string;
    let input: Record<string, unknown>;
    let outputSchema: z.ZodTypeAny;
    if (body.action === "creditNote") {
      if (!body.invoiceId || !body.amountMinor || !body.reason || body.reason.length < 3)
        return NextResponse.json({ error: "invoiceId, amountMinor and a reason of at least 3 characters are required" }, { status: 400 });
      capabilityId = "accounting.creditNote";
      input = { invoiceId: body.invoiceId as string, amountMinor: body.amountMinor as number, reason: body.reason as string };
      outputSchema = creditNoteOutputSchema;
    } else {
      if (!body.entryId) return NextResponse.json({ error: "entryId is required" }, { status: 400 });
      capabilityId = "accounting.reverseEntry";
      input = { entryId: body.entryId as string };
      outputSchema = reverseEntryOutputSchema;
    }
    try {
      return await invoiceOpsGoResponse(
        await executeGoCapability({
          actionContext: humanCtx,
          session: { userId: resolved.userId, orgId: resolved.orgId, authSessionId: resolved.authSessionId },
          capabilityId,
          input,
        }),
        outputSchema,
      );
    } catch {
      return accountingUnavailable();
    }
  }

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
    if (process.env.GO_ACCOUNTING_PERIOD_CLOSE_WRITES === "1") {
      return dispatchGoCapabilityRoute({ actionContext: humanCtx, session: resolved, capabilityId: "accounting.closeYear", input: { year: body.year } }, "accounting service unavailable; check year close status before retrying");
    }
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
  if (body.action === "fileSalesTaxReturn" && body.taxReturnId && process.env.GO_ACCOUNTING_TAX_RETURNS_WRITE === "1") {
    try {
      return await invoiceOpsGoResponse(
        await executeGoCapability({
          actionContext: humanCtx,
          session: { userId: resolved.userId, orgId: resolved.orgId, authSessionId: resolved.authSessionId },
          capabilityId: "accounting.fileSalesTaxReturn",
          input: { taxReturnId: body.taxReturnId as string },
        }),
        fileSalesTaxReturnOutputSchema,
      );
    } catch {
      return accountingUnavailable();
    }
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

const invoiceOutputSchema = z.object({
  invoiceId: z.string(),
  invoiceNumber: z.number().int(),
  totalMinor: z.number().int(),
  entryId: z.string(),
  currency: z.string().optional(),
});

function accountingUnavailable() {
  return NextResponse.json(
    { error: "accounting service unavailable; check invoice status before retrying" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function createInvoiceGoResponse(result: GoCapabilityBridgeResult) {
  if (result.kind !== "response") return accountingUnavailable();

  try {
    const body: unknown = await result.response.json();
    const headers = { "Cache-Control": "no-store" };
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: invoiceOutputSchema }).safeParse(body);
      if (!parsed.success) return accountingUnavailable();
      return NextResponse.json({ ok: true, data: parsed.data.data }, { status: 200, headers });
    }
    if (result.response.status === 202) {
      const parsed = z.object({
        ok: z.literal(false),
        pendingApproval: z.literal(true),
        reason: z.string(),
        approvalId: z.string().optional(),
      }).safeParse(body);
      if (!parsed.success) return accountingUnavailable();
      return NextResponse.json(
        { ok: false, pendingApproval: true, reason: parsed.data.reason },
        { status: 202, headers },
      );
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return accountingUnavailable();
      return NextResponse.json(parsed.data, { status: 422, headers });
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return accountingUnavailable();
      return NextResponse.json(parsed.data, { status: 401, headers });
    }
    if (result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return accountingUnavailable();
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers });
    }
  } catch {
    return accountingUnavailable();
  }

  return accountingUnavailable();
}

async function invoiceOpsGoResponse(
  result: GoCapabilityBridgeResult,
  outputSchema: z.ZodTypeAny,
  unavailable: () => NextResponse = accountingUnavailable,
) {
  if (result.kind !== "response") return unavailable();

  try {
    const body: unknown = await result.response.json();
    const headers = { "Cache-Control": "no-store" };
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: outputSchema }).safeParse(body);
      if (!parsed.success) return unavailable();
      return NextResponse.json({ ok: true, data: parsed.data.data }, { status: 200, headers });
    }
    if (result.response.status === 202) {
      const parsed = z.object({ ok: z.literal(false), pendingApproval: z.literal(true), reason: z.string() }).safeParse(body);
      if (!parsed.success) return unavailable();
      return NextResponse.json({ ok: false, pendingApproval: true, reason: parsed.data.reason }, { status: 202, headers });
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return unavailable();
      return NextResponse.json(parsed.data, { status: 422, headers });
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return unavailable();
      return NextResponse.json(parsed.data, { status: 401, headers });
    }
    if (result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return unavailable();
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers });
    }
  } catch {
    return unavailable();
  }
  return unavailable();
}

function respond(result: { ok: boolean; data?: unknown; error?: string; pendingApproval?: unknown }) {
  if (result.pendingApproval) {
    return NextResponse.json({ ok: false, pendingApproval: true, reason: result.error }, { status: 202 });
  }
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  return NextResponse.json({ ok: true, data: result.data });
}

const creditNoteOutputSchema = z.object({
  entryId: z.string(),
  creditedMinor: z.number(),
  invoiceBalanceMinor: z.number(),
});
const reverseEntryOutputSchema = z.object({ reversalEntryId: z.string() });
const fileSalesTaxReturnOutputSchema = z.object({
  filingId: z.string(),
  taxReturnId: z.string(),
  entryId: z.string(),
  taxMinor: z.number(),
});
const quoteCreateOutputSchema = z.object({
  quoteId: z.string(),
  quoteNumber: z.number(),
  totalMinor: z.number(),
});
const quoteAcceptOutputSchema = z.object({
  invoiceId: z.string(),
  invoiceNumber: z.number(),
  totalMinor: z.number(),
});
const quoteDeclineOutputSchema = z.object({ status: z.literal("declined") });
const quoteExpireOutputSchema = z.object({ expiredCount: z.number().int() });
const recurringCreateOutputSchema = z.object({ templateId: z.string(), nextRunAt: z.string().datetime() });
const recurringPauseOutputSchema = z.object({ active: z.literal(false) });
const recurringResumeOutputSchema = z.object({ active: z.literal(true) });

const recordPaymentOutputSchema = z.object({
  paymentId: z.string().uuid(),
  entryId: z.string().uuid(),
  fullyPaid: z.boolean(),
  gainLossMinor: z.number().int().optional(),
  baseEntryId: z.string().uuid().optional(),
  foreignEntryId: z.string().uuid().optional(),
});

const recordFxRateOutputSchema = z.object({
  rateId: z.string(),
  num: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  den: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const reversePaymentOutputSchema = z.object({
  reversalEntryIds: z.array(z.string().uuid()).min(1),
  refundedMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  invoiceNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  outstandingMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

function paymentUnavailable() {
  return NextResponse.json(
    { error: "accounting service unavailable; check payment status before retrying" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

function paymentReversalUnavailable() {
  return NextResponse.json(
    { error: "accounting service unavailable; check payment reversal status before retrying" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

function fxRateUnavailable() {
  return NextResponse.json(
    { error: "accounting service unavailable; check FX rate status before retrying" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

function quoteUnavailable() {
  return NextResponse.json(
    { error: "accounting service unavailable; check quote status before retrying" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

function recurringUnavailable() {
  return NextResponse.json(
    { error: "accounting service unavailable; check recurring template status before retrying" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

async function goBridgeResponse(result: GoCapabilityBridgeResult, unavailable: () => NextResponse, dataSchema: z.ZodType) {
  if (result.kind !== "response") return unavailable();

  try {
    const body: unknown = await result.response.json();
    const headers = { "Cache-Control": "no-store" };
    if (result.response.status === 200) {
      const parsed = z.object({ ok: z.literal(true), data: dataSchema }).safeParse(body);
      if (!parsed.success) return unavailable();
      return NextResponse.json({ ok: true, data: parsed.data.data }, { status: 200, headers });
    }
    if (result.response.status === 202) {
      const parsed = z.object({
        ok: z.literal(false),
        pendingApproval: z.literal(true),
        reason: z.string(),
        approvalId: z.string().optional(),
      }).safeParse(body);
      if (!parsed.success) return unavailable();
      return NextResponse.json(
        { ok: false, pendingApproval: true, reason: parsed.data.reason },
        { status: 202, headers },
      );
    }
    if (result.response.status === 422) {
      const parsed = z.object({ ok: z.literal(false), error: z.string() }).safeParse(body);
      if (!parsed.success) return unavailable();
      return NextResponse.json(parsed.data, { status: 422, headers });
    }
    if (result.response.status === 401) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return unavailable();
      return NextResponse.json(parsed.data, { status: 401, headers });
    }
    if (result.response.status === 403) {
      const parsed = z.object({ error: z.string() }).safeParse(body);
      if (!parsed.success) return unavailable();
      return NextResponse.json({ ok: false, error: parsed.data.error }, { status: 422, headers });
    }
  } catch {
    return unavailable();
  }

  return unavailable();
}
