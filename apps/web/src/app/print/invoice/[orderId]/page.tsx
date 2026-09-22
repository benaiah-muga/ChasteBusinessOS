import { eq } from "drizzle-orm";
import { customers, getDb, orgBranding, organizations, salesOrderLines, salesOrders, withOrgContext } from "@chaste/db";
import { getResolvedUser } from "@/server/session";
import { AutoPrint } from "../../auto-print";

/**
 * Server-rendered, org-branded invoice layout (Phase 4). Print-styled,
 * chrome-less, driven by the org's governed branding record and the real
 * posted order numbers; the browser's print dialog produces the PDF.
 */

// Per-user, per-order, print-time only: a static shell buys nothing here.
export const instant = false;

export default async function InvoicePrintPage({ params }: { params: Promise<{ orderId: string }> }) {
  const resolved = await getResolvedUser();
  if (!resolved?.orgId) {
    return <p style={{ padding: "2rem", fontFamily: "sans-serif" }}>Sign in to view this invoice.</p>;
  }
  const { orderId } = await params;

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
    const [branding] = await tx.select().from(orgBranding).where(eq(orgBranding.orgId, resolved.orgId!)).limit(1);
    return { order, lines, branding: branding ?? null };
  });

  if (!data) {
    return <p style={{ padding: "2rem", fontFamily: "sans-serif" }}>Invoice not found.</p>;
  }
  const { order, lines, branding } = data;
  const accent = branding?.accentColor ?? "#b45309";
  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPriceMinor, 0) / 1000;
  const tax = lines.reduce((sum, l) => sum + l.taxMinor, 0);
  const total = subtotal + tax;
  const money = (minor: number) =>
    (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const due = order.paymentTermDays
    ? new Date(order.createdAt.getTime() + order.paymentTermDays * 86_400_000).toISOString().slice(0, 10)
    : "On issue";
  const modern = branding?.layout === "modern";

  return (
    <div style={{ fontFamily: "ui-serif, Georgia, serif", color: "#1c1917", padding: "2.5rem", maxWidth: "48rem", margin: "0 auto" }}>
      <style>{`@media print { .no-print { display: none; } }`}</style>
      <p className="no-print" style={{ fontFamily: "ui-sans-serif, system-ui", fontSize: "0.8rem", color: "#78716c", marginBottom: "1rem" }}>
        Print this page (Ctrl/Cmd+P) to save the invoice as PDF. This banner is not printed.
      </p>
      <AutoPrint />

      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          borderBottom: `3px solid ${accent}`,
          paddingBottom: "1rem",
        }}
      >
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          {branding?.logoDataUrl ? (
            <img src={branding.logoDataUrl} alt={`${order.orgName} logo`} style={{ maxHeight: 64, maxWidth: 180, objectFit: "contain" }} />
          ) : null}
          <div>
            <h1 style={{ fontSize: "1.5rem", margin: 0, color: accent }}>{order.orgName}</h1>
            <p style={{ margin: "0.2rem 0 0", fontSize: "0.85rem", color: "#57534e" }}>Invoice #{order.number}</p>
          </div>
        </div>
        <table style={{ fontSize: "0.85rem", color: "#44403c" }}>
          <tbody>
            <tr>
              <td style={{ paddingRight: 12, color: "#78716c" }}>Issued</td>
              <td>{order.createdAt.toISOString().slice(0, 10)}</td>
            </tr>
            <tr>
              <td style={{ paddingRight: 12, color: "#78716c" }}>Due</td>
              <td>{due}</td>
            </tr>
            <tr>
              <td style={{ paddingRight: 12, color: "#78716c" }}>Status</td>
              <td style={{ textTransform: "capitalize" }}>{order.status}</td>
            </tr>
          </tbody>
        </table>
      </header>

      <section style={{ marginTop: "1.5rem" }}>
        <p style={{ margin: 0, fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.08em", color: "#78716c" }}>Billed to</p>
        <p style={{ margin: "0.2rem 0 0", fontWeight: 600 }}>{order.customerName}</p>
        {order.customerEmail ? <p style={{ margin: "0.1rem 0 0", fontSize: "0.85rem", color: "#57534e" }}>{order.customerEmail}</p> : null}
      </section>

      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "1.5rem", fontSize: "0.9rem" }}>
        <thead>
          <tr style={{ background: modern ? accent : "#fafaf9", color: modern ? "#ffffff" : "#1c1917" }}>
            <th style={{ textAlign: "left", padding: "0.5rem 0.6rem", borderBottom: `2px solid ${accent}` }}>Item</th>
            <th style={{ textAlign: "right", padding: "0.5rem 0.6rem", borderBottom: `2px solid ${accent}` }}>Qty</th>
            <th style={{ textAlign: "right", padding: "0.5rem 0.6rem", borderBottom: `2px solid ${accent}` }}>Unit price</th>
            <th style={{ textAlign: "right", padding: "0.5rem 0.6rem", borderBottom: `2px solid ${accent}` }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} style={{ borderBottom: "1px solid #e7e5e4" }}>
              <td style={{ padding: "0.5rem 0.6rem" }}>{l.description}</td>
              <td style={{ padding: "0.5rem 0.6rem", textAlign: "right" }}>{(l.quantity / 1000).toLocaleString()}</td>
              <td style={{ padding: "0.5rem 0.6rem", textAlign: "right" }}>{money(l.unitPriceMinor)}</td>
              <td style={{ padding: "0.5rem 0.6rem", textAlign: "right" }}>{money((l.quantity * l.unitPriceMinor) / 1000)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} style={{ padding: "0.4rem 0.6rem", textAlign: "right", color: "#57534e" }}>
              Subtotal
            </td>
            <td style={{ padding: "0.4rem 0.6rem", textAlign: "right" }}>{money(subtotal)}</td>
          </tr>
          {tax > 0 && (
            <tr>
              <td colSpan={3} style={{ padding: "0.4rem 0.6rem", textAlign: "right", color: "#57534e" }}>
                Tax
              </td>
              <td style={{ padding: "0.4rem 0.6rem", textAlign: "right" }}>{money(tax)}</td>
            </tr>
          )}
          <tr>
            <td colSpan={3} style={{ padding: "0.5rem 0.6rem", textAlign: "right", fontWeight: 700, color: accent }}>
              Total due
            </td>
            <td style={{ padding: "0.5rem 0.6rem", textAlign: "right", fontWeight: 700, fontSize: "1.05rem", color: accent }}>
              {money(total)}
            </td>
          </tr>
        </tfoot>
      </table>

      {order.note ? <p style={{ marginTop: "1rem", fontSize: "0.85rem", color: "#44403c" }}>{order.note}</p> : null}
      <footer style={{ marginTop: "2rem", borderTop: "1px solid #e7e5e4", paddingTop: "0.8rem", fontSize: "0.75rem", color: "#78716c" }}>
        {branding?.invoiceFooter ?? "Thank you for your business."}
      </footer>
    </div>
  );
}
