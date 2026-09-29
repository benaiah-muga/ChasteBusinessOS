import { useCallback, useEffect, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { AccountingInvoicesApiError, fetchAccountingEnabled, fetchAccountingInvoices, type AccountingInvoice } from "../api/accounting-invoices";
import { legacyUrl } from "../legacy";
import "./accounting-invoices-page.css";

type PageState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "failed"; error: AccountingInvoicesApiError }
  | { status: "ready"; invoices: AccountingInvoice[] };

function formatMoney(currency: string, amountMinor: number): string {
  const minorUnits = currencyMinorUnits(currency) ?? 2;
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    }).format(amountMinor / (10 ** minorUnits));
  } catch {
    return `${currency} ${(amountMinor / (10 ** minorUnits)).toLocaleString("en", {
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    })}`;
  }
}

function formatDate(value: string | null): string {
  if (!value) return "Not issued";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function AccountingInvoicesPage() {
  const [state, setState] = useState<PageState>({ status: "loading" });

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    try {
      const enabled = await fetchAccountingEnabled(signal);
      if (signal?.aborted) return;
      if (!enabled) {
        setState({ status: "disabled" });
        return;
      }
      const invoices = await fetchAccountingInvoices(signal);
      if (!signal?.aborted) setState({ status: "ready", invoices });
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        status: "failed",
        error: error instanceof AccountingInvoicesApiError
          ? error
          : new AccountingInvoicesApiError(0, "Could not reach the Accounting service. Check your connection and try again."),
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <main className="accounting-invoices-page">
      <header className="accounting-invoices-header">
        <div>
          <p className="accounting-invoices-eyebrow">Finance · preview</p>
          <h1>Accounting invoices</h1>
          <p>Review issued invoices and outstanding balances. Create, edit, and record payments in the full Accounting workspace.</p>
        </div>
        <a className="accounting-invoices-full-workspace" href={legacyUrl("/accounting?tab=invoices")}>Open full Accounting workspace</a>
      </header>

      {state.status === "loading" && <p className="accounting-invoices-message" role="status">Loading invoices…</p>}
      {state.status === "disabled" && (
        <section className="accounting-invoices-message accounting-invoices-empty" role="status">
          <h2>Accounting is turned off</h2>
          <p>Ask a workspace administrator to enable the Accounting module before viewing invoices.</p>
        </section>
      )}
      {state.status === "failed" && (
        <section className="accounting-invoices-message accounting-invoices-error" role="alert" aria-labelledby="accounting-invoices-error-title">
          <div>
            <p className="accounting-invoices-eyebrow">Invoices unavailable</p>
            <h2 id="accounting-invoices-error-title">
              {state.error.status === 401
                ? "Sign in again"
                : state.error.status === 403 || state.error.status === 422 || state.error.message.includes("permission")
                  ? "Access denied"
                  : "Could not load invoices"}
            </h2>
            <p>{state.error.message}</p>
          </div>
          <div className="accounting-invoices-error-actions">
            {state.error.status === 401 && <a href="/login">Sign in again</a>}
            <button type="button" onClick={() => void load()}>Try again</button>
          </div>
        </section>
      )}
      {state.status === "ready" && state.invoices.length === 0 && (
        <section className="accounting-invoices-message accounting-invoices-empty" role="status">
          <h2>No invoices yet</h2>
          <p>Issued invoices will appear here.</p>
        </section>
      )}
      {state.status === "ready" && state.invoices.length > 0 && (
        <>
          <section className="accounting-invoices-metrics" aria-label="Invoice summary">
            <article><span>Invoices</span><strong>{state.invoices.length.toLocaleString()}</strong></article>
            <article><span>With a balance</span><strong>{state.invoices.filter((invoice) => invoice.outstandingMinor > 0).length.toLocaleString()}</strong></article>
          </section>
          <section className="accounting-invoices-table-card" aria-label="Issued invoices">
            <div className="accounting-invoices-table-scroll">
              <table className="accounting-invoices-table">
                <thead><tr><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col">Issued</th><th scope="col">Status</th><th scope="col">Total</th><th scope="col">Paid</th><th scope="col">Outstanding</th></tr></thead>
                <tbody>{state.invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <th scope="row">#{invoice.number}</th>
                    <td>{invoice.customerName}</td>
                    <td>{formatDate(invoice.issuedAt)}</td>
                    <td><span className="accounting-invoices-status">{statusLabel(invoice.status)}</span></td>
                    <td>{formatMoney(invoice.currency, invoice.totalMinor)}</td>
                    <td>{formatMoney(invoice.currency, invoice.paidMinor)}</td>
                    <td className="accounting-invoices-value">{formatMoney(invoice.currency, invoice.outstandingMinor)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
