import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { customers, getDb, invoiceLines, invoiceShares, invoices } from "@chaste/db";
import { inviteAttemptLimit, requestIp } from "@/server/rate-limit";

type Params = { params: Promise<{ token: string }> };

/**
 * Public customer-portal endpoint. The token IS the credential: 192 random
 * bits, revocable, scoped to exactly one invoice. It reveals only what the
 * customer needs — number, currency, totals, payment state — never other
 * customers, ledger internals, or org data.
 */
export async function GET(req: Request, { params }: Params) {
  // Same budget as invitation acceptance: blunts token grinding without
  // hurting a real customer clicking their link.
  const limit = inviteAttemptLimit(requestIp(req));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "too many requests" },
      { status: 429, headers: { "retry-after": String(limit.retryAfterSec) } },
    );
  }

  const { token } = await params;
  if (token.length < 20 || token.length > 64) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const db = getDb().db;
  const [row] = await db
    .select({
      number: invoices.number,
      status: invoices.status,
      currency: invoices.currency,
      totalMinor: invoices.totalMinor,
      paidMinor: invoices.paidMinor,
      issuedAt: invoices.issuedAt,
      customerName: customers.name,
    })
    .from(invoiceShares)
    .innerJoin(invoices, eq(invoices.id, invoiceShares.invoiceId))
    .innerJoin(customers, eq(customers.id, invoices.customerId))
    .where(and(eq(invoiceShares.token, token)))
    .limit(1);

  if (!row || row.status === "void") return NextResponse.json({ error: "not found" }, { status: 404 });

  const lines = await db
    .select({
      description: invoiceLines.description,
      quantity: invoiceLines.quantity,
      unitPriceMinor: invoiceLines.unitPriceMinor,
      taxMinor: invoiceLines.taxMinor,
    })
    .from(invoiceLines)
    .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
    .where(eq(invoices.number, row.number))
    .orderBy(invoiceLines.id)
    .limit(50);

  return NextResponse.json({
    invoice: {
      number: row.number,
      status: row.status,
      currency: row.currency,
      totalMinor: row.totalMinor,
      paidMinor: row.paidMinor,
      outstandingMinor: Math.max(0, row.totalMinor - row.paidMinor),
      issuedAt: row.issuedAt,
      customerName: row.customerName,
      lines,
    },
  });
}
