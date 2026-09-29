import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AccountingCloseApiError,
  fetchAccountingCloseEnabled,
  fetchAccountingCloseReadiness,
  type AccountingCloseReadiness,
} from "../api/accounting-close";
import { legacyUrl } from "../legacy";
import "./accounting-close-readiness-page.css";

type PageState =
  | { status: "loading" }
  | { status: "disabled" }
  | { status: "failed"; error: AccountingCloseApiError }
  | { status: "select-period" }
  | { status: "empty"; readiness: AccountingCloseReadiness }
  | { status: "ready"; readiness: AccountingCloseReadiness };

function defaultPeriod(): string {
  const prior = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1));
  return `${prior.getUTCFullYear()}-${String(prior.getUTCMonth() + 1).padStart(2, "0")}`;
}

function readPeriod(value: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year >= 2000 && year <= 2100 && month >= 1 && month <= 12 ? { year, month } : null;
}

function monthLabel(readiness: AccountingCloseReadiness): string {
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(readiness.year, readiness.month - 1, 1)));
}

function dateRange(start: string, end: string): string {
  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
  return `${formatter.format(new Date(start))} to ${formatter.format(new Date(end))}`;
}

function friendlyError(error: unknown): AccountingCloseApiError {
  return error instanceof AccountingCloseApiError
    ? error
    : new AccountingCloseApiError(0, "Could not load period-close readiness. Try again.");
}

function taskStatus(task: AccountingCloseReadiness["tasks"][number]): string {
  if (task.completed) return "Complete";
  if (task.blocking) return "Blocking";
  return task.status.replaceAll("_", " ");
}

export function AccountingCloseReadinessPage() {
  const [period, setPeriod] = useState(defaultPeriod);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<PageState>({ status: "loading" });
  const parsedPeriod = useMemo(() => readPeriod(period), [period]);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!parsedPeriod) {
      setState({ status: "select-period" });
      return;
    }
    setState({ status: "loading" });
    try {
      const enabled = await fetchAccountingCloseEnabled(signal);
      if (signal?.aborted) return;
      if (!enabled) {
        setState({ status: "disabled" });
        return;
      }
      const readiness = await fetchAccountingCloseReadiness(parsedPeriod.year, parsedPeriod.month, signal);
      if (!signal?.aborted) setState(readiness.tasks.length === 0
        ? { status: "empty", readiness }
        : { status: "ready", readiness });
    } catch (error) {
      if (signal?.aborted) return;
      setState({ status: "failed", error: friendlyError(error) });
    }
  }, [parsedPeriod]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, retry]);

  const title = state.status === "ready" || state.status === "empty" ? monthLabel(state.readiness) : null;

  return (
    <main className="accounting-close-readiness-page">
      <header className="accounting-close-readiness-header">
        <div>
          <p className="accounting-close-readiness-eyebrow">Accounting · read only</p>
          <h1>Period close readiness</h1>
          <p>Review reconciliation, FX, and sign-off checks for a month. Checklist updates, revaluation, close, and reopen stay in the full workspace.</p>
        </div>
        <a className="accounting-close-readiness-full-workspace" href={legacyUrl("/accounting/close")}>Open full period close workspace</a>
      </header>

      <section className="accounting-close-period-picker" aria-label="Period selection">
        <label htmlFor="accounting-close-period">Close period</label>
        <input
          id="accounting-close-period"
          type="month"
          min="2000-01"
          max="2100-12"
          value={period}
          onChange={(event) => setPeriod(event.currentTarget.value)}
        />
        {title && <p>{title}</p>}
      </section>

      {state.status === "loading" && <p className="accounting-close-readiness-message" role="status">Loading period-close readiness…</p>}

      {state.status === "select-period" && (
        <p className="accounting-close-readiness-message" role="status">Choose a month from January 2000 through December 2100.</p>
      )}

      {state.status === "disabled" && (
        <section className="accounting-close-readiness-message" role="status">
          <h2>Accounting is turned off</h2>
          <p>Ask a workspace administrator to enable the Accounting module before viewing close readiness.</p>
        </section>
      )}

      {state.status === "failed" && (
        <section className="accounting-close-readiness-message accounting-close-readiness-error" role="alert" aria-labelledby="accounting-close-readiness-error-title">
          <div>
            <h2 id="accounting-close-readiness-error-title">
              {state.error.status === 401 ? "Sign in again" : state.error.status === 403 || state.error.status === 422 ? "Access denied" : "Could not load close readiness"}
            </h2>
            <p>{state.error.message}</p>
          </div>
          <div className="accounting-close-readiness-error-actions">
            {state.error.status === 401 && <a href="/login">Sign in again</a>}
            <button type="button" onClick={() => setRetry((value) => value + 1)}>Try again</button>
          </div>
        </section>
      )}

      {state.status === "empty" && (
        <section className="accounting-close-readiness-message" role="status">
          <h2>No readiness checks for {title}</h2>
          <p>The Accounting service returned no checks for this period.</p>
        </section>
      )}

      {state.status === "ready" && (
        <section className="accounting-close-readiness-content" aria-label={`${title} close readiness`}>
          <section className="accounting-close-readiness-overview" aria-labelledby="accounting-close-readiness-status-title">
            <div className="accounting-close-readiness-overview-heading">
              <div>
                <p className="accounting-close-readiness-eyebrow">{dateRange(state.readiness.start, state.readiness.end)}</p>
                <h2 id="accounting-close-readiness-status-title">{state.readiness.readyToClose ? "Ready to close" : "Not ready to close"}</h2>
              </div>
              <span className={`accounting-close-readiness-badge ${state.readiness.readyToClose ? "is-ready" : "is-blocked"}`}>
                {state.readiness.readyToClose ? "Ready" : `${state.readiness.blockers.length} ${state.readiness.blockers.length === 1 ? "blocker" : "blockers"}`}
              </span>
            </div>
            <dl className="accounting-close-readiness-metrics">
              <div><dt>Unmatched bank lines</dt><dd>{state.readiness.unmatchedLineCount.toLocaleString()}</dd></div>
              <div><dt>Foreign receivable currencies</dt><dd>{state.readiness.currenciesWithExposure.length ? state.readiness.currenciesWithExposure.join(", ") : "None"}</dd></div>
            </dl>
            <div className="accounting-close-blockers" aria-labelledby="accounting-close-blockers-title">
              <h3 id="accounting-close-blockers-title">Blocking checks</h3>
              {state.readiness.blockers.length === 0 ? (
                <p>No blocking checks remain.</p>
              ) : (
                <ul>
                  {state.readiness.blockers.map((key) => {
                    const task = state.readiness.tasks.find((item) => item.key === key);
                    return <li key={key}>{task?.label ?? key}</li>;
                  })}
                </ul>
              )}
            </div>
          </section>

          <section className="accounting-close-task-list" aria-labelledby="accounting-close-task-list-title">
            <div className="accounting-close-task-list-heading">
              <h2 id="accounting-close-task-list-title">Readiness checks</h2>
              <p>{state.readiness.tasks.length} {state.readiness.tasks.length === 1 ? "check" : "checks"}</p>
            </div>
            {state.readiness.tasks.map((task) => (
              <article className={`accounting-close-task-card ${task.blocking ? "is-blocking" : ""}`} key={task.key}>
                <header>
                  <h3>{task.label}</h3>
                  <span className={`accounting-close-task-status ${task.completed ? "is-complete" : task.blocking ? "is-blocking" : ""}`}>
                    {taskStatus(task)}
                  </span>
                </header>
                <p>{task.detail}</p>
                {task.note && <p className="accounting-close-task-note">Review note: {task.note}</p>}
              </article>
            ))}
          </section>
        </section>
      )}
    </main>
  );
}
