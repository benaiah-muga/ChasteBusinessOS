import { useEffect, useState } from "react";
import "./PortalInvoicePage.css";
import { fetchPortalInvoice, PORTAL_MESSAGES, type PortalInvoiceResult } from "../api/portal";

const STATUS_TONE: Record<string, string> = {
  paid: "portal-badge-paid",
  sent: "portal-badge-sent",
  draft: "portal-badge-neutral",
};

function tokenFromPath(pathname: string): string {
  const match = /^\/portal\/([^/]+)\/?$/.exec(pathname);
  if (!match?.[1]) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return "";
  }
}

/**
 * Public read-only invoice view. No chrome, no navigation, no links out: the
 * only thing that reaches the visitor is the invoice behind their share link.
 */
export function PortalInvoicePage({ pathname }: { pathname: string }) {
  const token = tokenFromPath(pathname);
  const [loaded, setLoaded] = useState<{ token: string; result: PortalInvoiceResult } | null>(null);
  const result = loaded?.token === token ? loaded.result : null;

  useEffect(() => {
    const controller = new AbortController();
    void fetchPortalInvoice(token, controller.signal).then((nextResult) => {
      if (!controller.signal.aborted) setLoaded({ token, result: nextResult });
    });
    return () => {
      controller.abort();
    };
  }, [token]);

  const invoice = result?.status === "ok" ? result.invoice : null;
  const error = result?.status === "not-found"
    ? PORTAL_MESSAGES.notFound
    : result?.status === "rate-limited"
      ? PORTAL_MESSAGES.rateLimited
      : result?.status === "error"
        ? result.message
        : null;

  return (
    <main className="portal-page" aria-label="Invoice portal">
      <header className="portal-heading">
        <span className="portal-wordmark">Chaste</span>
        <span className="portal-wordmark-note">Invoice portal</span>
      </header>

      {error && (
        <div className="portal-panel portal-panel-empty" role="alert">
          <p className="portal-error">{error}</p>
          <p className="portal-error-note">
            Ask the business for a fresh link if you still need your invoice.
          </p>
        </div>
      )}

      {!result && (
        <div className="portal-panel portal-skeleton" role="status" aria-label="Loading invoice" aria-busy="true">
          <div className="portal-skeleton-title" />
          <div className="portal-skeleton-line" />
          <div className="portal-skeleton-block" />
        </div>
      )}

      {invoice && (
        <article className="portal-panel" aria-labelledby="portal-invoice-title">
          <header className="portal-invoice-header">
            <div>
              <h1 id="portal-invoice-title" className="portal-invoice-title">Invoice #{invoice.number}</h1>
              <p className="portal-invoice-subtitle">
                Billed to {invoice.customerName}
                {invoice.issuedAt ? ` · issued ${new Date(invoice.issuedAt).toLocaleDateString()}` : ""}
              </p>
            </div>
            <span className={`portal-badge ${STATUS_TONE[invoice.status] ?? "portal-badge-neutral"}`}>
              {invoice.status}
            </span>
          </header>

          <ul className="portal-lines">
            {invoice.lines.map((line, index) => (
              <li key={index} className="portal-line">
                <span className="portal-line-description">{line.description}</span>
                <span className="portal-line-amount">
                  {(line.quantity / 1000).toLocaleString()} × {(line.unitPriceMinor / 100).toFixed(2)}
                </span>
              </li>
            ))}
          </ul>

          <footer className="portal-totals">
            <div className="portal-total-row">
              <span>Total</span>
              <span>
                {invoice.currency} {(invoice.totalMinor / 100).toFixed(2)}
              </span>
            </div>
            <div className="portal-total-row">
              <span>Paid</span>
              <span>
                {invoice.currency} {(invoice.paidMinor / 100).toFixed(2)}
              </span>
            </div>
            <div className="portal-total-row portal-total-outstanding">
              <span>Outstanding</span>
              <span>
                {invoice.currency} {(invoice.outstandingMinor / 100).toFixed(2)}
              </span>
            </div>
          </footer>
        </article>
      )}
    </main>
  );
}
