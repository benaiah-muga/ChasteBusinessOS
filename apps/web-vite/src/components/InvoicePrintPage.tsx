import { useEffect, useState } from "react";
import "./InvoicePrintPage.css";
import {
  dueDate,
  fetchPrintInvoice,
  formatMoney,
  issueDate,
  lineAmountMinor,
  subtotalMinor,
  taxMinor,
  type PrintInvoice,
} from "../api/print-invoice";

const DEFAULT_ACCENT = "#b45309";

function orderIdFromPath(pathname: string): string {
  const match = /^\/print\/invoice\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

/** The browser print dialog produces the PDF; nothing is generated server side. */
function AutoPrint() {
  useEffect(() => {
    const timer = setTimeout(() => window.print(), 300);
    return () => clearTimeout(timer);
  }, []);
  return null;
}

/**
 * Org-branded invoice layout driven by the posted order and the governed
 * branding record. Print-styled and chrome-less so the printed page carries no
 * navigation, only the invoice.
 */
export function InvoicePrintPage({ pathname }: { pathname: string }) {
  const orderId = orderIdFromPath(pathname);
  const [state, setState] = useState<
    | { orderId: string; status: "loading" }
    | { orderId: string; status: "ready"; invoice: PrintInvoice }
    | { orderId: string; status: "error"; message: string }
  >({ orderId, status: "loading" });

  useEffect(() => {
    let stop = false;
    setState({ orderId, status: "loading" });
    void fetchPrintInvoice(orderId).then((result) => {
      if (stop) return;
      if (result.status === "ok") {
        setState({ orderId, status: "ready", invoice: result.invoice });
        return;
      }
      if (result.status === "unauthorized") {
        setState({ orderId, status: "error", message: "Sign in to view this invoice." });
      } else if (result.status === "not-found") {
        setState({ orderId, status: "error", message: "Invoice not found." });
      } else {
        setState({ orderId, status: "error", message: result.message });
      }
    });
    return () => {
      stop = true;
    };
  }, [orderId]);

  if (state.orderId !== orderId || state.status === "loading") {
    return <p className="print-message" role="status">Loading this invoice.</p>;
  }
  if (state.status === "error") return <p className="print-message" role="alert">{state.message}</p>;

  const invoice = state.invoice;
  const { order, lines, branding } = invoice;
  const accent = branding?.accentColor ?? DEFAULT_ACCENT;
  const subtotal = subtotalMinor(lines);
  const tax = taxMinor(lines);
  const total = subtotal + tax;
  const modern = branding?.layout === "modern";

  return (
    <div className="print-sheet">
      <style>{`@media print { .no-print { display: none; } }`}</style>
      <p className="no-print print-hint">
        Print this page (Ctrl/Cmd+P) to save the invoice as PDF. This banner is not printed.
      </p>
      <AutoPrint key={orderId} />

      <header className="print-header" style={{ borderBottom: `3px solid ${accent}` }}>
        <div className="print-brand">
          {branding?.logoDataUrl ? (
            <img src={branding.logoDataUrl} alt={`${order.orgName} logo`} className="print-logo" />
          ) : null}
          <div>
            <h1 className="print-org" style={{ color: accent }}>{order.orgName}</h1>
            <p className="print-org-sub">Invoice #{order.number}</p>
          </div>
        </div>
        <table className="print-meta">
          <tbody>
            <tr>
              <td>Issued</td>
              <td>{issueDate(order.createdAt)}</td>
            </tr>
            <tr>
              <td>Due</td>
              <td>{dueDate(order.createdAt, order.paymentTermDays)}</td>
            </tr>
            <tr>
              <td>Status</td>
              <td>{order.status}</td>
            </tr>
          </tbody>
        </table>
      </header>

      <section className="print-billed-to">
        <p className="print-label">Billed to</p>
        <p className="print-customer">{order.customerName}</p>
        {order.customerEmail ? <p className="print-customer-email">{order.customerEmail}</p> : null}
      </section>

      <table className="print-lines">
        <thead>
          <tr style={{ background: modern ? accent : "#fafaf9", color: modern ? "#ffffff" : "#1c1917" }}>
            <th className="print-cell-left" style={{ borderBottom: `2px solid ${accent}` }}>Item</th>
            <th className="print-cell-right" style={{ borderBottom: `2px solid ${accent}` }}>Qty</th>
            <th className="print-cell-right" style={{ borderBottom: `2px solid ${accent}` }}>Unit price</th>
            <th className="print-cell-right" style={{ borderBottom: `2px solid ${accent}` }}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={index}>
              <td className="print-cell-left">{line.description}</td>
              <td className="print-cell-right">{(line.quantity / 1000).toLocaleString()}</td>
              <td className="print-cell-right">{formatMoney(line.unitPriceMinor)}</td>
              <td className="print-cell-right">{formatMoney(lineAmountMinor(line))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} className="print-total-label">Subtotal</td>
            <td className="print-cell-right">{formatMoney(subtotal)}</td>
          </tr>
          {tax > 0 && (
            <tr>
              <td colSpan={3} className="print-total-label">Tax</td>
              <td className="print-cell-right">{formatMoney(tax)}</td>
            </tr>
          )}
          <tr>
            <td colSpan={3} className="print-total-label print-total-strong" style={{ color: accent }}>
              Total due
            </td>
            <td className="print-cell-right print-total-strong" style={{ color: accent }}>
              {formatMoney(total)}
            </td>
          </tr>
        </tfoot>
      </table>

      {order.note ? <p className="print-note">{order.note}</p> : null}
      <footer className="print-footer">
        {branding?.invoiceFooter ?? "Thank you for your business."}
      </footer>
    </div>
  );
}
