import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { customers, getDb, orgBranding, organizations, salesOrderLines, salesOrders, withOrgContext } from "@chaste/db";
import { getResolvedUser } from "@/server/session";

const noStore = { "Cache-Control": "no-store" };

/**
 * Read-only projection backing the Vite print view of a posted invoice. The
 * Next print page read these tables server side; the Vite client cannot, so it
 * reads them here instead. Same org scope, same joined rows, same real posted
 * order numbers, and no write path exists on this route.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }
  const { orderId } = await params;
  if (!z.string().uuid().safeParse(orderId).success) {
    return NextResponse.json({ error: "Invoice not found." }, { status: 200, headers: noStore });
  }

  const data = await withOrgContext(getDb().db, resolved.orgId, async (tx) => {
    const [order] = await tx
      .select({
        number: salesOrders.number,
        status: salesOrders.status,
        note: salesOrders.note,
        createdAt: salesOrders.createdAt,
        customerName: customers.name,
        customerEmail: customers.email,
        paymentTermDays: customers.paymentTermDays,
        orgName: organizations.name,
      })
      .from(salesOrders)
      .innerJoin(customers, eq(customers.id, salesOrders.customerId))
      .innerJoin(organizations, eq(organizations.id, salesOrders.orgId))
      .where(eq(salesOrders.id, orderId))
      .limit(1);
    if (!order) return null;
    const lines = await tx
      .select({
        description: salesOrderLines.description,
        quantity: salesOrderLines.quantity,
        unitPriceMinor: salesOrderLines.unitPriceMinor,
        taxMinor: salesOrderLines.taxMinor,
      })
      .from(salesOrderLines)
      .where(eq(salesOrderLines.orderId, orderId));
    const [branding] = await tx
      .select({
        logoDataUrl: orgBranding.logoDataUrl,
        accentColor: orgBranding.accentColor,
        invoiceFooter: orgBranding.invoiceFooter,
        layout: orgBranding.layout,
      })
      .from(orgBranding)
      .where(eq(orgBranding.orgId, resolved.orgId!))
      .limit(1);
    return { order, lines, branding: branding ?? null };
  });

  if (!data) {
    // The legacy print page rendered "Invoice not found." as page text with a
    // 200, so preserve that status until the API version changes.
    return NextResponse.json({ error: "Invoice not found." }, { status: 200, headers: noStore });
  }
  return NextResponse.json(data, { headers: noStore });
}
