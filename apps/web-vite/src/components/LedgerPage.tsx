import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchLedgerEvents, LedgerApiError, type LedgerEvent } from "../api/ledger";
import "./LedgerPage.css";

type PageState =
  | { status: "loading" }
  | { status: "failed"; error: LedgerApiError }
  | { status: "ready"; events: LedgerEvent[] };

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function dateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function matches(event: LedgerEvent, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return event.kind.toLowerCase().includes(normalized)
    || (event.capabilityId ?? "").toLowerCase().includes(normalized)
    || event.actorType.toLowerCase().includes(normalized);
}

function LedgerTable({ events }: { events: LedgerEvent[] }) {
  return (
    <div className="ledger-table-shell">
      <table className="ledger-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Event</th>
            <th scope="col">Capability</th>
            <th scope="col">Actor</th>
            <th scope="col">When</th>
            <th scope="col">Chain</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.seq}>
              <td className="ledger-seq">{event.seq}</td>
              <td className="ledger-kind">{event.kind}</td>
              <td className="ledger-capability" title={event.capabilityId ?? ""}>{event.capabilityId ?? "-"}</td>
              <td>
                <span className="ledger-actor">
                  <span className={`ledger-actor-badge${event.actorType === "agent" ? " ledger-actor-agent" : ""}`}>{event.actorType}</span>
                  {event.actorType === "agent" && event.sessionId && (
                    <span className="ledger-session" title={`Agent session ${event.sessionId} acting for user ${event.actorId ?? "unknown"}`}>
                      s·{event.sessionId.slice(0, 6)}
                    </span>
                  )}
                </span>
              </td>
              <td className="ledger-when" title={dateTime(event.occurredAt)}>
                <time dateTime={event.occurredAt}>{timeAgo(event.occurredAt)}</time>
              </td>
              <td>
                <details className="ledger-chain">
                  <summary aria-label={`Show hash chain details for event ${event.seq}`}>
                    <span aria-hidden="true">#</span>
                    <span className="ledger-hash-short">{event.hash.slice(0, 12)}…</span>
                  </summary>
                  <dl>
                    <div><dt>Hash</dt><dd>{event.hash}</dd></div>
                    <div><dt>Previous hash</dt><dd>{event.prevHash ?? "-"}</dd></div>
                  </dl>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function LedgerPage() {
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [search, setSearch] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ status: "loading" });
    try {
      const events = await fetchLedgerEvents(signal);
      if (!signal?.aborted) setState({ status: "ready", events });
    } catch (error) {
      if (signal?.aborted) return;
      setState({
        status: "failed",
        error: error instanceof LedgerApiError
          ? error
          : new LedgerApiError(0, "Could not reach the ledger service. Check your connection and try again."),
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const filtered = useMemo(
    () => state.status === "ready" ? state.events.filter((event) => matches(event, search)) : [],
    [state, search],
  );

  return (
    <main className="ledger-page">
      <header className="ledger-page-header">
        <div>
          <p className="ledger-eyebrow">Governance</p>
          <h1>Event Ledger</h1>
          <p>Append-only and hash-chained. Every action, human or agent, with its evidence. Each entry commits to the previous one; tampering breaks the chain visibly.</p>
        </div>
        <label className="ledger-filter">
          <span>Filter ledger events</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder="Filter by kind, capability, or actor"
          />
        </label>
      </header>

      {state.status === "loading" && <p className="ledger-loading" role="status">Loading the event ledger…</p>}
      {state.status === "failed" && (
        <section className="ledger-error" role="alert" aria-labelledby="ledger-error-title">
          <div>
            <p className="ledger-eyebrow">Ledger unavailable</p>
            <h2 id="ledger-error-title">{state.error.status === 403 ? "Access denied" : "Could not load the ledger"}</h2>
            <p>{state.error.message}</p>
          </div>
          <div className="ledger-error-actions">
            {state.error.status === 401 && <a href="/login">Sign in again</a>}
            <button type="button" onClick={() => void load()}>Try again</button>
          </div>
        </section>
      )}
      {state.status === "ready" && state.events.length === 0 && (
        <section className="ledger-empty" role="status">
          <span aria-hidden="true">≋</span>
          <h2>Nothing in the ledger yet</h2>
          <p>Do anything in the console, every governed action lands here with its hash chain.</p>
        </section>
      )}
      {state.status === "ready" && state.events.length > 0 && filtered.length === 0 && (
        <section className="ledger-empty" role="status">
          <span aria-hidden="true">⌕</span>
          <h2>No events match</h2>
          <p>Try a different filter.</p>
        </section>
      )}
      {state.status === "ready" && filtered.length > 0 && <LedgerTable events={filtered} />}
    </main>
  );
}
