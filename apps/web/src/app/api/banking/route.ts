import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { bankAccounts, bankTransactions, customers, getDb, invoices, payments } from "@chaste/db";
import { actorFromResolved, buildExecutor, buildRegistry } from "@/server/kernel";
import { getResolvedUser } from "@/server/session";

/**
 * Full human surface for bank feeds & reconciliation: accounts, statement
 * imports, matching, exclusion, and the summary — every capability through
 * the same governed executor the agent uses.
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

  const accountRows = await db
    .select()
    .from(bankAccounts)
    .where(eq(bankAccounts.orgId, orgId))
    .orderBy(desc(bankAccounts.createdAt));

  const unmatchedRows = await db
    .select({
      id: bankTransactions.id,
      bankAccountId: bankTransactions.bankAccountId,
      postedAt: bankTransactions.postedAt,
      amountMinor: bankTransactions.amountMinor,
      description: bankTransactions.description,
    })
    .from(bankTransactions)
    .where(and(eq(bankTransactions.orgId, orgId), eq(bankTransactions.status, "unmatched")))
    .orderBy(desc(bankTransactions.postedAt))
    .limit(200);

  // Match candidates: recent customer payments with their invoice context,
  // so a statement line like "ACME WIRE 1,250.00" can be linked by hand.
  const paymentRows = await db
    .select({
      id: payments.id,
      amountMinor: payments.amountMinor,
      receivedAt: payments.receivedAt,
      invoiceNumber: invoices.number,
      customerName: customers.name,
    })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(eq(payments.orgId, orgId))
    .orderBy(desc(payments.receivedAt))
    .limit(50);

  const summary = await executor.execute("accounting.bankSummary", ctx, {});
  if (!summary.ok) return NextResponse.json({ error: summary.error }, { status: 500 });

  return NextResponse.json({
    accounts: accountRows.map((a) => ({
      id: a.id,
      name: a.name,
      currencyCode: a.currencyCode,
      last4: a.last4,
      balanceMinor: Number(a.balanceMinor),
    })),
    unmatched: unmatchedRows.map((t) => ({ ...t, postedAt: t.postedAt.toISOString() })),
    payments: paymentRows.map((p) => ({
      id: p.id,
      invoiceNumber: p.invoiceNumber,
      customerName: p.customerName,
      amountMinor: p.amountMinor,
      receivedAt: p.receivedAt.toISOString(),
    })),
    summary: summary.data ?? { accounts: [], unmatchedCount: 0 },
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
    case "addBankAccount":
      if (!body.name) return NextResponse.json({ error: "name is required" }, { status: 400 });
      return respond(
        await executor.execute("accounting.addBankAccount", ctx, {
          name: body.name as string,
          last4: (body.last4 as string) || undefined,
          balanceMinor: typeof body.balanceMinor === "number" ? body.balanceMinor : 0,
        }),
      );
    case "importBankFeed": {
      const rows = body.rows as
        | { postedAt: string; amountMinor: number; description: string }[]
        | undefined;
      if (!rows?.length) return NextResponse.json({ error: "rows are required" }, { status: 400 });
      if (rows.length > 500) return NextResponse.json({ error: "at most 500 rows per import" }, { status: 400 });
      return respond(
        await executor.execute("accounting.importBankFeed", ctx, {
          bankAccountId: (body.bankAccountId as string) || undefined,
          rows,
        }),
      );
    }
    case "matchBankTransaction": {
      if (!body.transactionId) return NextResponse.json({ error: "transactionId is required" }, { status: 400 });
      if (!body.paymentId && !body.entryId)
        return NextResponse.json({ error: "paymentId or entryId is required" }, { status: 400 });
      return respond(
        await executor.execute("accounting.matchBankTransaction", ctx, {
          transactionId: body.transactionId as string,
          ...(body.paymentId ? { paymentId: body.paymentId as string } : {}),
          ...(body.entryId ? { entryId: body.entryId as string } : {}),
        }),
      );
    }
    case "unmatchBankTransaction":
    case "excludeBankTransaction":
    case "unexcludeBankTransaction":
    case "deleteBankTransaction":
      if (!body.transactionId) return NextResponse.json({ error: "transactionId is required" }, { status: 400 });
      return respond(
        await executor.execute(`accounting.${body.action}`, ctx, {
          transactionId: body.transactionId as string,
        }),
      );
    default:
      return NextResponse.json({ error: "invalid action" }, { status: 400 });
  }
}
