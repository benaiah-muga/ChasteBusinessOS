import { NextResponse } from "next/server";
import { and, count, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import {
  accounts,
  approvals,
  deals,
  documents,
  documentSuggestions,
  employees,
  getDb,
  invoices,
  items,
  journalEntries,
  journalLines,
  leaveRequests,
  ledgerEvents,
  posSessions,
  stockMovements,
  vendorBills,
} from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * One call feeding the home dashboard: money position, working capital,
 * pipeline, operations, a six-month income/expense trend, and the latest
 * hash-chained ledger events. All amounts are integer minor units.
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

  const [pnlRes, bsRes, tbRes] = await Promise.all([
    executor.execute("accounting.incomeStatement", ctx, {}),
    executor.execute("accounting.balanceSheet", ctx, {}),
    executor.execute("accounting.trialBalance", ctx, {}),
  ]);

  const pnl = pnlRes.ok && pnlRes.data
    ? (pnlRes.data as { revenueMinor: number; expenseMinor: number; netIncomeMinor: number })
    : null;
  const balanceSheet = bsRes.ok && bsRes.data
    ? (bsRes.data as { assetsMinor: number; liabilitiesMinor: number; equityMinor: number; balanced: boolean })
    : null;
  let cashMinor: number | null = null;
  if (tbRes.ok && tbRes.data) {
    const lines = (tbRes.data as { lines: { code: string; debitMinor: number; creditMinor: number }[] }).lines;
    cashMinor = lines.filter((l) => l.code === "1000").reduce((s, l) => s + l.debitMinor - l.creditMinor, 0);
  }

  // Receivables: open invoices and their aging.
  const arRows = await db
    .select({
      total: invoices.totalMinor,
      paid: invoices.paidMinor,
      issuedAt: invoices.issuedAt,
    })
    .from(invoices)
    .where(and(eq(invoices.orgId, orgId), ne(invoices.status, "void"), gt(invoices.totalMinor, invoices.paidMinor)));
  const now = Date.now();
  const DAY = 86_400_000;
  const arOutstanding = arRows.reduce((s, r) => s + r.total - r.paid, 0);
  const overdueRows = arRows.filter((r) => r.issuedAt && now - r.issuedAt.getTime() > 30 * DAY);
  const overdueAmount = overdueRows.reduce((s, r) => s + r.total - r.paid, 0);

  // Payables: open vendor bills.
  const apRows = await db
    .select({ total: vendorBills.totalMinor, paid: vendorBills.paidMinor })
    .from(vendorBills)
    .where(and(eq(vendorBills.orgId, orgId), ne(vendorBills.status, "void")));
  const apOutstanding = apRows.reduce((s, r) => s + r.total - r.paid, 0);

  // CRM pipeline: stage counts plus the weighted forecast model.
  const dealRows = await db
    .select({ stage: deals.stage, valueMinor: deals.valueMinor })
    .from(deals)
    .where(eq(deals.orgId, orgId));
  const weights: Record<string, number> = { lead: 0.1, qualified: 0.3, proposal: 0.5, negotiation: 0.7, won: 1, lost: 0 };
  const stages = ["lead", "qualified", "proposal", "negotiation", "won", "lost"].map((stage) => ({
    stage,
    count: dealRows.filter((d) => d.stage === stage).length,
    valueMinor: dealRows.filter((d) => d.stage === stage).reduce((s, d) => s + d.valueMinor, 0),
  }));
  const weightedForecast = dealRows.reduce((s, d) => s + Math.round(d.valueMinor * (weights[d.stage] ?? 0)), 0);

  // People.
  const [[headcountRow], [pendingLeaveRow]] = await Promise.all([
    db.select({ n: count() }).from(employees).where(and(eq(employees.orgId, orgId), isNull(employees.deactivatedAt))),
    db.select({ n: count() }).from(leaveRequests).where(and(eq(leaveRequests.orgId, orgId), eq(leaveRequests.status, "pending"))),
  ]);

  // Point of sale: any register currently open?
  const [openPos] = await db
    .select({ id: posSessions.id, register: posSessions.register })
    .from(posSessions)
    .where(and(eq(posSessions.orgId, orgId), eq(posSessions.status, "open")))
    .limit(1);

  // Stock: on-hand sums joined against reorder points.
  const stockRows = await db
    .select({
      sku: items.sku,
      name: items.name,
      reorderPoint: items.reorderPointThousandths,
      onHand: sql<number>`coalesce(sum(${stockMovements.quantityDelta}), 0)`,
    })
    .from(items)
    .leftJoin(stockMovements, and(eq(stockMovements.itemId, items.id), eq(stockMovements.orgId, orgId)))
    .where(eq(items.orgId, orgId))
    .groupBy(items.sku, items.name, items.reorderPointThousandths);
  const lowStock = stockRows
    .filter((r) => r.reorderPoint > 0 && Number(r.onHand) <= r.reorderPoint)
    .map((r) => ({ sku: r.sku, name: r.name }));

  // Gates and documents awaiting review.
  const [pendingApprovalsRow] = await db
    .select({ n: count() })
    .from(approvals)
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")));
  const [openSuggestionsRow] = await db
    .select({ n: count() })
    .from(documentSuggestions)
    .where(and(eq(documentSuggestions.orgId, orgId), eq(documentSuggestions.status, "open")));
  const [parsedDocsRow] = await db
    .select({ n: count() })
    .from(documents)
    .where(and(eq(documents.orgId, orgId), eq(documents.status, "parsed")));

  // Six-month income vs expense trend from the ledger itself.
  const trendRows = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${journalEntries.postedAt}), 'YYYY-MM')`,
      type: accounts.type,
      amount: sql<number>`sum(${journalLines.creditMinor} - ${journalLines.debitMinor})`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(eq(journalEntries.orgId, orgId), sql`${accounts.type} in ('income', 'expense')`))
    .groupBy(sql`date_trunc('month', ${journalEntries.postedAt})`, accounts.type)
    .orderBy(sql`date_trunc('month', ${journalEntries.postedAt})`);

  const months: string[] = [];
  const cursor = new Date();
  cursor.setUTCDate(1);
  for (let i = 5; i >= 0; i--) {
    const d = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - i, 1));
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  const trend = months.map((m) => ({
    month: m,
    incomeMinor: Number(trendRows.find((r) => r.month === m && r.type === "income")?.amount ?? 0),
    expenseMinor: -Number(trendRows.find((r) => r.month === m && r.type === "expense")?.amount ?? 0),
  }));

  // Latest hash-chained ledger events.
  const activity = await db
    .select({
      seq: ledgerEvents.seq,
      kind: ledgerEvents.kind,
      capabilityId: ledgerEvents.capabilityId,
      actorType: ledgerEvents.actorType,
      occurredAt: ledgerEvents.occurredAt,
    })
    .from(ledgerEvents)
    .where(eq(ledgerEvents.orgId, orgId))
    .orderBy(desc(ledgerEvents.seq))
    .limit(8);

  return NextResponse.json({
    money: {
      revenueMinor: pnl?.revenueMinor ?? 0,
      expenseMinor: pnl?.expenseMinor ?? 0,
      netIncomeMinor: pnl?.netIncomeMinor ?? 0,
      cashMinor,
      balanced: balanceSheet?.balanced ?? null,
      assetsMinor: balanceSheet?.assetsMinor ?? 0,
      liabilitiesMinor: balanceSheet?.liabilitiesMinor ?? 0,
      equityMinor: balanceSheet?.equityMinor ?? 0,
    },
    workingCapital: {
      arOutstandingMinor: arOutstanding,
      overdueCount: overdueRows.length,
      overdueAmountMinor: overdueAmount,
      apOutstandingMinor: apOutstanding,
    },
    pipeline: {
      stages,
      openCount: dealRows.filter((d) => d.stage !== "won" && d.stage !== "lost").length,
      weightedForecastMinor: weightedForecast,
    },
    ops: {
      headcount: headcountRow?.n ?? 0,
      pendingLeave: pendingLeaveRow?.n ?? 0,
      posOpen: openPos ? { register: openPos.register } : null,
      lowStock,
      pendingApprovals: pendingApprovalsRow?.n ?? 0,
      docsParsed: parsedDocsRow?.n ?? 0,
      docsAwaitingCoding: openSuggestionsRow?.n ?? 0,
    },
    trend,
    activity,
    signals: await (async () => {
      const run = await executor.execute("signals.list", ctx, {});
      const data = run.data as { signals?: unknown[] } | undefined;
      return (data?.signals ?? []).slice(0, 8);
    })(),
  });
}
