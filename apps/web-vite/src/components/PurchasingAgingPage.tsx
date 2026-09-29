import { useCallback, useEffect, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import {
  loadPurchasingAging,
  type PurchasingAging,
} from "../api/purchasing-aging";
import { PurchasingPaymentRunsApiError } from "../api/purchasing-payment-runs";
import { legacyUrl } from "../legacy";
import "./purchasing-aging.css";

type PageState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "failed"; error: PurchasingPaymentRunsApiError }
  | { status: "ready"; buckets: PurchasingAging; currency: string };

const AGING_BANDS = [
  { key: "current", label: "Current", age: "0-30 days", tone: "current" },
  { key: "d30", label: "31-60 days", age: "31-60 days", tone: "near" },
  { key: "d60", label: "61-90 days", age: "61-90 days", tone: "late" },
  { key: "d90plus", label: "Over 90 days", age: "91+ days", tone: "overdue" },
] as const;

function formatMoney(minor: number, currency: string): string {
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

export function PurchasingAgingPage({ baseCurrency = null }: { baseCurrency?: string | null }) {
  const [state, setState] = useState<PageState>({ status: "loading" });

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    try {
      const result = await loadPurchasingAging(signal);
      if (signal?.aborted) return;
      if (!result) {
        setState({ status: "disabled" });
        return;
      }
      setState({ status: "ready", buckets: result.buckets, currency: baseCurrency ?? result.baseCurrency });
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        status: "failed",
        error: error instanceof PurchasingPaymentRunsApiError
          ? error
          : new PurchasingPaymentRunsApiError(0, "Could not load accounts payable aging. Try again."),
      });
    }
  }, [baseCurrency]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const total = state.status === "ready" ? state.buckets.totalOutstanding : 0;
  const overdue = state.status === "ready"
    ? state.buckets.d30 + state.buckets.d60 + state.buckets.d90plus
    : 0;

  return (
    <main className="purchasing-aging-page">
      <header className="purchasing-aging-header">
        <div>
          <p className="purchasing-aging-eyebrow">Purchasing · read only</p>
          <h1>Accounts payable aging</h1>
          <p>See how much is outstanding and how long vendor bills have been open. Review and pay bills in the full Purchasing workspace.</p>
        </div>
        <a className="purchasing-aging-full-workspace" href={legacyUrl("/purchasing?tab=bills")}>Open full Purchasing workspace</a>
      </header>

      {state.status === "loading" && <p className="purchasing-aging-message" role="status">Loading payable balances…</p>}

      {state.status === "disabled" && (
        <section className="purchasing-aging-message purchasing-aging-empty" role="status">
          <h2>Purchasing is turned off</h2>
          <p>Ask a workspace administrator to enable Purchasing before reviewing payables.</p>
        </section>
      )}

      {state.status === "failed" && (
        <section className="purchasing-aging-message purchasing-aging-error" role="alert" aria-labelledby="purchasing-aging-error-title">
          <div>
            <h2 id="purchasing-aging-error-title">{state.error.status === 401 ? "Sign in again" : state.error.status === 403 ? "Access denied" : "Could not load payable balances"}</h2>
            <p>{state.error.message}</p>
          </div>
          <div className="purchasing-aging-error-actions">
            {state.error.status === 401 && <a href="/login">Sign in again</a>}
            <button type="button" onClick={() => void load()}>Try again</button>
          </div>
        </section>
      )}

      {state.status === "ready" && (
        <section className="purchasing-aging-report" aria-labelledby="purchasing-aging-report-title">
          <div className="purchasing-aging-total">
            <div>
              <p className="purchasing-aging-eyebrow">Outstanding across open bills</p>
              <h2 id="purchasing-aging-report-title">{formatMoney(total, state.currency)}</h2>
              <p>{formatMoney(overdue, state.currency)} is more than 30 days old</p>
            </div>
            {total === 0 && <span className="purchasing-aging-clear">No unpaid balance</span>}
          </div>

          <div className="purchasing-aging-meter" role="img" aria-label={`Payables by age: ${AGING_BANDS.map((band) => `${band.label} ${formatMoney(state.buckets[band.key], state.currency)}`).join(", ")}`}>
            {AGING_BANDS.map((band) => {
              const share = total > 0 ? (state.buckets[band.key] / total) * 100 : 0;
              return <span key={band.key} className={`aging-meter-band is-${band.tone}`} style={{ width: `${share}%` }} />;
            })}
          </div>

          <div className="purchasing-aging-table-wrap">
            <table className="purchasing-aging-table">
              <caption>Outstanding vendor bills by age</caption>
              <thead>
                <tr><th scope="col">Age of bill</th><th scope="col">Days open</th><th scope="col">Outstanding</th><th scope="col">Share</th></tr>
              </thead>
              <tbody>
                {AGING_BANDS.map((band) => {
                  const amount = state.buckets[band.key];
                  const share = total > 0 ? (amount / total) * 100 : 0;
                  return (
                    <tr key={band.key}>
                      <th scope="row"><span className={`aging-band-dot is-${band.tone}`} aria-hidden="true" />{band.label}</th>
                      <td>{band.age}</td>
                      <td>{formatMoney(amount, state.currency)}</td>
                      <td>{share.toLocaleString(undefined, { maximumFractionDigits: 1 })}%</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr><th scope="row" colSpan={2}>Total outstanding</th><td>{formatMoney(total, state.currency)}</td><td>100%</td></tr></tfoot>
            </table>
          </div>
          <p className="purchasing-aging-note">Age bands follow each bill date and the active workspace currency.</p>
        </section>
      )}
    </main>
  );
}
