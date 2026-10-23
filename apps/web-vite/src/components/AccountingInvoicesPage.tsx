import { useCallback, useEffect, useMemo, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { Search } from "lucide-react";
import { AccountingInvoicesApiError, fetchAccountingEnabled, fetchAccountingInvoices, type AccountingInvoice } from "../api/accounting-invoices";
import { PageLoading } from "../ui/page-loading";
import { SavedViewBar } from "../ui/saved-view-bar";
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

export function AccountingInvoicesPage({ organizationId = null }: { organizationId?: string | null }) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");

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

  const invoices = state.status === "ready" ? state.invoices : [];
  const summary = useMemo(() => {
    const billed = invoices.reduce((sum, invoice) => sum + invoice.totalMinor, 0);
    const outstanding = invoices.reduce((sum, invoice) => sum + invoice.outstandingMinor, 0);
    const open = invoices.filter((invoice) => invoice.outstandingMinor > 0).length;
    return { billed, outstanding, open };
  }, [invoices]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return invoices.filter((invoice) => {
      if (status !== "all" && invoice.status !== status) return false;
      if (!needle) return true;
      return `#${invoice.number} ${invoice.customerName} ${invoice.status}`.toLowerCase().includes(needle);
    });
  }, [invoices, query, status]);
  const statuses = useMemo(() => Array.from(new Set(invoices.map((invoice) => invoice.status))).sort(), [invoices]);
  const currencies = useMemo(() => new Set(invoices.map((invoice) => invoice.currency)), [invoices]);
  const currency = invoices[0]?.currency ?? "USD";
  const mixedCurrencies = currencies.size > 1;

  return (
    <main className="accounting-invoices-page">
      <header className="accounting-invoices-header">
        <div>
          <p className="accounting-invoices-eyebrow">Finance · receivables</p>
          <h1>Invoices</h1>
          <p>Issued invoices, balances, and collection state. Posting and payment corrections stay in the governed Accounting workspace.</p>
        </div>
        <div className="accounting-invoices-header-actions">
          <a className="accounting-invoices-secondary" href="/accounting?tab=receivables">Open Accounting</a>
          <a className="accounting-invoices-primary" href="/accounting?create=invoice">New invoice</a>
        </div>
      </header>

      {state.status === "loading" && <PageLoading label="Loading invoices…" compact />}
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
      {state.status === "ready" && invoices.length === 0 && (
        <section className="accounting-invoices-empty" role="status">
          <span className="accounting-invoices-empty-icon" aria-hidden="true">◎</span>
          <h2>Your first invoice starts here</h2>
          <p>Create an invoice in Accounting. It posts the receivable and revenue on approval, then appears here with its balance.</p>
          <a className="accounting-invoices-primary" href="/accounting?create=invoice">Create invoice</a>
        </section>
      )}
      {state.status === "ready" && invoices.length > 0 && (
        <>
          <section className="accounting-invoices-summary" aria-label="Invoice summary">
            <div><span>Issued</span><strong>{invoices.length.toLocaleString()}</strong></div>
            <div><span>Open</span><strong>{summary.open.toLocaleString()}</strong></div>
            <div><span>Billed</span><strong>{mixedCurrencies ? "Mixed currencies" : formatMoney(currency, summary.billed)}</strong></div>
            <div className={summary.outstanding > 0 ? "is-warning" : ""}><span>Outstanding</span><strong>{mixedCurrencies ? "Mixed currencies" : formatMoney(currency, summary.outstanding)}</strong></div>
          </section>

          <section className="accounting-invoices-table-card" aria-label="Issued invoices">
            <div className="accounting-invoices-saved">
              <SavedViewBar
                module="accounting.invoices"
                organizationId={organizationId}
                current={{ query, status }}
                onApply={(value) => { setQuery(value.query); setStatus(value.status); }}
              />
            </div>
            <div className="accounting-invoices-toolbar">
              <label className="accounting-invoices-search">
                <Search size={14} aria-hidden="true" />
                <span className="accounting-invoices-sr-only">Search invoices</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder="Search number, customer, status"
                />
              </label>
              <select aria-label="Filter invoices by status" value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
                <option value="all">All statuses</option>
                {statuses.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
              </select>
            </div>
            {filtered.length === 0 ? (
              <div className="accounting-invoices-no-match" role="status">
                <strong>No invoices match those filters</strong>
                <button type="button" onClick={() => { setQuery(""); setStatus("all"); }}>Clear filters</button>
              </div>
            ) : (
              <div className="accounting-invoices-table-scroll">
                <table className="accounting-invoices-table">
                  <thead><tr><th scope="col">Invoice</th><th scope="col">Customer</th><th scope="col">Issued</th><th scope="col">Status</th><th scope="col">Total</th><th scope="col">Paid</th><th scope="col">Outstanding</th><th scope="col"><span className="accounting-invoices-sr-only">Actions</span></th></tr></thead>
                  <tbody>{filtered.map((invoice) => (
                    <tr key={invoice.id}>
                      <th scope="row">#{invoice.number}</th>
                      <td>{invoice.customerName}</td>
                      <td>{formatDate(invoice.issuedAt)}</td>
                      <td><span className={`accounting-invoices-status accounting-invoices-status-${invoice.status.replace(/[^a-z0-9]/gi, "-")}`}>{statusLabel(invoice.status)}</span></td>
                      <td>{formatMoney(invoice.currency, invoice.totalMinor)}</td>
                      <td>{formatMoney(invoice.currency, invoice.paidMinor)}</td>
                      <td className="accounting-invoices-value">{formatMoney(invoice.currency, invoice.outstandingMinor)}</td>
                      <td className="accounting-invoices-row-action"><a href="/accounting?tab=receivables" aria-label={`Open invoice ${invoice.number} in Accounting`}>Open</a></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
