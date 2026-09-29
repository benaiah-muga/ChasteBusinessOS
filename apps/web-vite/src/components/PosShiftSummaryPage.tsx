import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { currencyMinorUnits } from "@chaste/erp-core";
import { fetchPosSessions, fetchPosShiftSummary, PosApiError, type PosSession, type PosShiftSummary } from "../api/pos";
import { legacyUrl } from "../legacy";
import "./pos-shift-summary-page.css";

type PageState =
  | { status: "loading" }
  | { status: "failed"; message: string; code: number }
  | { status: "empty" }
  | { status: "ready"; sessions: PosSession[]; selectedId: string; summary: PosShiftSummary | null; summaryLoading: boolean; summaryError: string | null };

type CurrencyStyle = { symbol: string; minorUnits: number };
const CURRENCY_PREFERENCES = ["org", "USD", "KES", "EUR", "GBP", "TZS", "UGX"];
const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", KES: "KSh", EUR: "€", GBP: "£", TZS: "TSh", UGX: "USh" };

function currencyFor(baseCurrency: string | null): CurrencyStyle {
  let preference: string | null = null;
  try {
    const cookie = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("chaste_display_currency="));
    if (cookie) {
      const value = decodeURIComponent(cookie.slice("chaste_display_currency=".length));
      if (CURRENCY_PREFERENCES.includes(value)) preference = value;
    }
  } catch { /* A blocked cookie leaves the device preference available. */ }
  if (!preference) {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem("chaste-prefs") ?? "null");
      if (stored && typeof stored === "object" && "currency" in stored && typeof stored.currency === "string" && CURRENCY_PREFERENCES.includes(stored.currency)) preference = stored.currency;
    } catch { /* Invalid local preferences fall back to the active organization. */ }
  }
  const code = !preference || preference === "org" ? baseCurrency ?? "USD" : preference;
  let symbol = CURRENCY_SYMBOLS[code];
  if (!symbol) {
    try { symbol = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).formatToParts(0).find((part) => part.type === "currency")?.value; }
    catch { symbol = `${code} `; }
  }
  return { symbol: symbol ?? `${code} `, minorUnits: currencyMinorUnits(code) ?? 2 };
}

function formatMoney(minor: number | null, currency: CurrencyStyle): string {
  if (minor === null) return "Not counted";
  const formatted = (Math.abs(minor) / (10 ** currency.minorUnits)).toLocaleString("en-US", {
    minimumFractionDigits: currency.minorUnits,
    maximumFractionDigits: currency.minorUnits,
  });
  return `${minor < 0 ? "−" : ""}${currency.symbol}${formatted}`;
}

function friendlyError(error: unknown): { message: string; code: number } {
  if (error instanceof PosApiError) return { message: error.message, code: error.status };
  if (error instanceof DOMException && error.name === "TimeoutError") return { message: "The POS service took too long to load. Try again.", code: 0 };
  return { message: "Could not reach the POS service. Check your connection and try again.", code: 0 };
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatStatus(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sessionLabel(session: PosSession, index: number): string {
  return session.register ?? `Register session ${session.number ?? index + 1}`;
}

function displayMethod(method: string): string {
  return formatStatus(method);
}

export function PosShiftSummaryPage({ baseCurrency = null }: { baseCurrency?: string | null }) {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const summaryRequestId = useRef(0);
  const currency = useMemo(() => currencyFor(baseCurrency), [baseCurrency]);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    try {
      const sessions = await fetchPosSessions(signal);
      if (signal?.aborted) return;
      if (sessions.length === 0) {
        setState({ status: "empty" });
        return;
      }
      const requestId = ++summaryRequestId.current;
      setState({ status: "ready", sessions, selectedId: sessions[0]!.id, summary: null, summaryLoading: true, summaryError: null });
      try {
        const summary = await fetchPosShiftSummary(sessions[0]!.id, signal);
        if (!signal?.aborted) setState((current) => requestId === summaryRequestId.current && current.status === "ready" && current.selectedId === sessions[0]!.id
          ? { status: "ready", sessions, selectedId: sessions[0]!.id, summary, summaryLoading: false, summaryError: null }
          : current);
      } catch (error) {
        if (!signal?.aborted) setState((current) => requestId === summaryRequestId.current && current.status === "ready" && current.selectedId === sessions[0]!.id
          ? { ...current, summary: null, summaryLoading: false, summaryError: friendlyError(error).message }
          : current);
      }
    } catch (error) {
      if (!signal?.aborted) {
        const detail = friendlyError(error);
        setState({ status: "failed", ...detail });
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const chooseSession = useCallback(async (selectedId: string, sessions: PosSession[]) => {
    const requestId = ++summaryRequestId.current;
    setState({ status: "ready", sessions, selectedId, summary: null, summaryLoading: true, summaryError: null });
    try {
      const summary = await fetchPosShiftSummary(selectedId);
      setState((current) => requestId === summaryRequestId.current && current.status === "ready" && current.selectedId === selectedId
        ? { ...current, summary, summaryLoading: false, summaryError: null }
        : current);
    } catch (error) {
      setState((current) => requestId === summaryRequestId.current && current.status === "ready" && current.selectedId === selectedId
        ? { ...current, summaryLoading: false, summaryError: friendlyError(error).message }
        : current);
    }
  }, []);

  const retry = () => { void load(); };

  return (
    <main className="pos-summary-page">
      <header className="pos-summary-header">
        <div>
          <p className="pos-summary-eyebrow">Point of sale · read only</p>
          <h1>POS shift summary</h1>
          <p>Review register takings, tender totals, refunds, and cash variance.</p>
        </div>
        <a className="pos-summary-full-workspace" href={legacyUrl("/pos")}>Open full POS workspace</a>
      </header>

      {state.status === "loading" && <p className="pos-summary-message" role="status">Loading register sessions…</p>}
      {state.status === "failed" && (
        <section className="pos-summary-message pos-summary-error" role="alert">
          <h2>{state.code === 401 ? "Sign in again" : state.code === 403 || state.code === 422 ? "Access denied" : "Could not load POS sessions"}</h2>
          <p>{state.message}</p>
          {state.code === 401 && <a href="/login">Sign in again</a>}
          <button type="button" onClick={retry}>Try again</button>
        </section>
      )}
      {state.status === "empty" && (
        <section className="pos-summary-message pos-summary-empty" aria-live="polite">
          <h2>No register sessions yet</h2>
          <p>Open the POS workspace to start a register session. Shift summaries will appear here.</p>
          <a href={legacyUrl("/pos")}>Open POS workspace</a>
        </section>
      )}
      {state.status === "ready" && (
        <>
          <section className="pos-summary-session-picker" aria-label="Register session">
            <label htmlFor="pos-summary-session">Register session</label>
            <select id="pos-summary-session" value={state.selectedId} onChange={(event) => void chooseSession(event.target.value, state.sessions)}>
              {state.sessions.map((session, index) => (
                <option key={session.id} value={session.id}>
                  {sessionLabel(session, index)} · {formatStatus(session.status)} · {dateLabel(session.openedAt)}{index === 0 ? " · Latest" : ""}
                </option>
              ))}
            </select>
          </section>
          {state.summaryLoading && <p className="pos-summary-message" role="status">Loading shift summary…</p>}
          {state.summaryError && (
            <section className="pos-summary-message pos-summary-error" role="alert">
              <h2>Could not load this shift summary</h2>
              <p>{state.summaryError}</p>
              <button type="button" onClick={() => void chooseSession(state.selectedId, state.sessions)}>Try again</button>
            </section>
          )}
          {state.summary && (
            <section className="pos-summary-report" aria-labelledby="pos-summary-report-title">
              <header className="pos-summary-report-header">
                <div><p className="pos-summary-eyebrow">{state.summary.register || sessionLabel(state.sessions.find((session) => session.id === state.selectedId)!, 0)}</p><h2 id="pos-summary-report-title">Shift totals</h2></div>
                <span className={`pos-summary-status pos-summary-status-${state.summary.status.toLowerCase()}`}>{formatStatus(state.summary.status)}</span>
              </header>
              <dl className="pos-summary-metrics">
                <div><dt>Sales</dt><dd>{state.summary.salesCount.toLocaleString()}</dd></div>
                <div><dt>Takings</dt><dd>{formatMoney(state.summary.takingsMinor, currency)}</dd></div>
                <div><dt>Expected cash</dt><dd>{formatMoney(state.summary.expectedCashMinor, currency)}</dd></div>
                <div><dt>Counted cash</dt><dd>{formatMoney(state.summary.countedCashMinor, currency)}</dd></div>
                <div className={state.summary.varianceMinor !== null && state.summary.varianceMinor < 0 ? "pos-summary-negative" : undefined}>
                  <dt>Cash variance</dt><dd>{formatMoney(state.summary.varianceMinor, currency)}</dd>
                </div>
              </dl>
              <div className="pos-summary-totals-grid">
                <Totals title="Tender totals" rows={state.summary.tenderTotals} currency={currency} empty="No tenders recorded." />
                <Totals title="Refund totals" rows={state.summary.refundTotals} currency={currency} empty="No refunds recorded." />
              </div>
              <p className="pos-summary-session-time">
                Opened {dateLabel(state.sessions.find((session) => session.id === state.selectedId)!.openedAt)}
                {state.sessions.find((session) => session.id === state.selectedId)!.closedAt
                  ? ` · Closed ${dateLabel(state.sessions.find((session) => session.id === state.selectedId)!.closedAt!)}`
                  : " · Still open"}
              </p>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function Totals({ title, rows, currency, empty }: { title: string; rows: PosShiftSummary["tenderTotals"]; currency: CurrencyStyle; empty: string }) {
  return (
    <section className="pos-summary-totals" aria-label={title}>
      <h3>{title}</h3>
      {rows.length === 0 ? <p>{empty}</p> : <dl>{rows.map((row) => <div key={row.method}><dt>{displayMethod(row.method)}</dt><dd>{formatMoney(row.amountMinor, currency)}</dd></div>)}</dl>}
    </section>
  );
}
