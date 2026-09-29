import { useCallback, useEffect, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import {
  fetchPurchasingEnabled,
  fetchPurchasingPaymentRuns,
  PurchasingPaymentRunsApiError,
  type PurchasingPaymentRun,
} from "../api/purchasing-payment-runs";
import { legacyUrl } from "../legacy";
import "./purchasing-payment-runs.css";

type PageState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "failed"; error: PurchasingPaymentRunsApiError }
  | { status: "empty" }
  | { status: "ready"; runs: PurchasingPaymentRun[] };

function money(minor: number, currency: string): string {
  const minorUnits = currencyMinorUnits(currency) ?? 2;
  const amount = minor / (10 ** minorUnits);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString(undefined, {
      minimumFractionDigits: minorUnits,
      maximumFractionDigits: minorUnits,
    })}`;
  }
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function statusLabel(status: PurchasingPaymentRun["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function PurchasingPaymentRunsPage() {
  const [state, setState] = useState<PageState>({ status: "loading" });

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    try {
      const enabled = await fetchPurchasingEnabled(signal);
      if (signal?.aborted) return;
      if (!enabled) {
        setState({ status: "disabled" });
        return;
      }
      const runs = await fetchPurchasingPaymentRuns(signal);
      if (signal?.aborted) return;
      setState(runs.length === 0 ? { status: "empty" } : { status: "ready", runs });
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        status: "failed",
        error: error instanceof PurchasingPaymentRunsApiError
          ? error
          : new PurchasingPaymentRunsApiError(0, "Could not load supplier payment runs. Try again."),
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <main className="purchasing-runs-page">
      <header className="purchasing-runs-header">
        <div>
          <p className="purchasing-runs-eyebrow">Purchasing · read only</p>
          <h1>Supplier payment runs</h1>
          <p>Review payment status and bill remittance details. Create, approve, and reconcile runs in the full workspace.</p>
        </div>
        <a className="purchasing-runs-full-workspace" href={legacyUrl("/purchasing")}>Open full Purchasing workspace</a>
      </header>

      {state.status === "loading" && <p className="purchasing-runs-message" role="status">Loading supplier payment runs…</p>}

      {state.status === "disabled" && (
        <section className="purchasing-runs-message purchasing-runs-empty" role="status">
          <h2>Purchasing is turned off</h2>
          <p>Ask a workspace administrator to enable the Purchasing module before viewing payment runs.</p>
        </section>
      )}

      {state.status === "failed" && (
        <section className="purchasing-runs-message purchasing-runs-error" role="alert" aria-labelledby="purchasing-runs-error-title">
          <div>
            <p className="purchasing-runs-eyebrow">Payment runs unavailable</p>
            <h2 id="purchasing-runs-error-title">
              {state.error.status === 401 ? "Sign in again" : state.error.status === 403 ? "Access denied" : "Could not load payment runs"}
            </h2>
            <p>{state.error.message}</p>
          </div>
          <div className="purchasing-runs-error-actions">
            {state.error.status === 401 && <a href="/login">Sign in again</a>}
            <button type="button" onClick={() => void load()}>Try again</button>
          </div>
        </section>
      )}

      {state.status === "empty" && (
        <section className="purchasing-runs-message purchasing-runs-empty" role="status">
          <span aria-hidden="true">▤</span>
          <h2>No supplier payment runs yet</h2>
          <p>Payment runs will appear here after they are created in Purchasing.</p>
        </section>
      )}

      {state.status === "ready" && (
        <section className="purchasing-runs-list" aria-label="Supplier payment runs">
          <p className="purchasing-runs-count">Showing {state.runs.length} recent {state.runs.length === 1 ? "run" : "runs"}</p>
          {state.runs.map((run) => (
            <article className="purchasing-run-card" key={run.id}>
              <header className="purchasing-run-heading">
                <div>
                  <p className="purchasing-run-reference">{run.reference}</p>
                  <p className="purchasing-run-created">Created {dateLabel(run.createdAt)}</p>
                </div>
                <div className="purchasing-run-summary">
                  <span className={`purchasing-run-status is-${run.status}`}>{statusLabel(run.status)}</span>
                  <strong>{money(run.totalMinor, run.currency)}</strong>
                </div>
              </header>
              <dl className="purchasing-run-timestamps">
                {run.instructedAt && <div><dt>Instructed</dt><dd>{dateLabel(run.instructedAt)}</dd></div>}
                {run.confirmedAt && <div><dt>Confirmed</dt><dd>{dateLabel(run.confirmedAt)}</dd></div>}
                {run.entryId && <div><dt>Journal entry</dt><dd>{run.entryId}</dd></div>}
              </dl>
              <div className="purchasing-run-lines-wrap">
                <table className="purchasing-run-lines">
                  <caption>Remittance details for {run.reference}</caption>
                  <thead><tr><th scope="col">Bill</th><th scope="col">Supplier</th><th scope="col">Supplier reference</th><th scope="col">Amount</th></tr></thead>
                  <tbody>
                    {run.lines.map((line) => (
                      <tr key={line.billId}>
                        <td>#{line.billNumber}</td>
                        <td>{line.vendorName}</td>
                        <td>{line.vendorRef ?? "—"}</td>
                        <td>{money(line.amountMinor, run.currency)}</td>
                      </tr>
                    ))}
                    {run.lines.length === 0 && <tr><td colSpan={4}>No bill details are available for this run.</td></tr>}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
