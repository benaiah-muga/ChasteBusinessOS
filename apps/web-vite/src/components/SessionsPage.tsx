import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  fetchDurableRunDetail,
  fetchDurableRuns,
  fetchSessionEvents,
  fetchSessionMetrics,
  fetchSessionReplay,
  fetchSessions,
  SessionsApiError,
  type AgentSession,
  type DurableRun,
  type DurableRunDetail,
  type ReplayTrace,
  type SessionMetrics,
  type TrajectoryEvent,
} from "../api/sessions";
import "./SessionsPage.css";

type SessionListState =
  | { status: "loading" }
  | { status: "failed"; message: string; code: number }
  | { status: "ready"; sessions: AgentSession[] };

type TimelineState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; events: TrajectoryEvent[]; replay: ReplayTrace | null; replayError: string | null };

type RunsState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; runs: DurableRun[] };

type RunDetailState =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "ready"; detail: DurableRunDetail };

type MetricsState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; metrics: SessionMetrics };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof SessionsApiError ? error.message : fallback;
}

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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 1) ?? String(value);
  } catch {
    return String(value);
  }
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  return typeof source[key] === "string" ? source[key] as string : null;
}

function eventBody(event: TrajectoryEvent): ReactNode {
  const content = record(event.content);
  const text = content ? stringField(content, "text") : null;
  if (event.role === "user" || event.role === "assistant") {
    return <p className="session-event-text">{text ?? (content ? jsonText(content) : String(event.content ?? ""))}</p>;
  }
  if (event.role === "tool_call") {
    return (
      <>
        <span className="session-tool-name">tool call · {stringField(content ?? {}, "name") ?? "unknown tool"}</span>
        <details className="session-event-details">
          <summary>arguments</summary>
          <pre>{jsonText(content?.args ?? {})}</pre>
        </details>
      </>
    );
  }
  if (event.role === "tool_result") {
    const ok = content?.ok === true;
    const name = stringField(content ?? {}, "name") ?? "unknown tool";
    const error = stringField(content ?? {}, "error");
    return (
      <>
        <span className={`session-tool-result${ok ? " session-tool-result-ok" : " session-tool-result-blocked"}`}>
          <span aria-hidden="true">›</span> {ok ? "ok" : "blocked"} · {name}
        </span>
        {error && <span className="session-tool-error">{error}</span>}
      </>
    );
  }
  return <pre className="session-event-raw">{jsonText(event.content)}</pre>;
}

function SessionTimeline({ events }: { events: TrajectoryEvent[] }) {
  return (
    <div className="session-event-list">
      {events.map((event) => (
        <article className="session-event" key={event.seq}>
          <span className="session-event-meta">#{event.seq} · {new Date(event.at).toLocaleTimeString()}</span>
          <div className={`session-event-card session-event-${event.role.replace(/[^a-z0-9_-]/gi, "-")}`}>
            {eventBody(event)}
          </div>
        </article>
      ))}
    </div>
  );
}

function statusTone(status: string): string {
  if (status === "completed" || status === "committed") return "green";
  if (status === "failed") return "red";
  return "amber";
}

function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

function RunDossier({ detail }: { detail: DurableRunDetail }) {
  return (
    <section className="session-run-dossier" aria-label="Durable run dossier">
      <div className="session-run-dossier-heading">
        <strong>Run dossier</strong>
        <span className="session-run-chip session-run-chip-neutral">
          {detail.steps.length} checkpoint{detail.steps.length === 1 ? "" : "s"}
        </span>
        <span>registry {detail.run.registryVersion}</span>
        {detail.run.lastError && <span className="session-run-error">{detail.run.lastError}</span>}
      </div>
      {detail.run.harnessProfileId && (
        <p className="session-run-composition">
          Runtime composition: {detail.run.harnessProfileId} · {detail.run.harnessProfileVersion ?? "unknown version"}
          {detail.run.harnessCompositionDigest && <code>{detail.run.harnessCompositionDigest}</code>}
        </p>
      )}
      <div className="session-run-steps">
        {detail.steps.map((step) => (
          <article className="session-run-step" key={step.id}>
            <div className="session-run-step-heading">
              <span className="session-run-step-index">#{step.stepIndex}</span>
              <span className={`session-run-chip session-run-chip-${statusTone(step.status)}`}>{statusLabel(step.status)}</span>
            </div>
            <p className="session-run-capability">{step.capabilityId ?? "unassigned step"}</p>
            {step.receiptId && <p className="session-run-receipt">Receipt {step.receiptId}</p>}
            {step.approvalId && <p className="session-run-receipt">Approval {step.approvalId}</p>}
            {step.error && <p className="session-run-error">{step.error}</p>}
            {step.inputHash && <details className="session-run-hash"><summary>Input hash</summary><code>{step.inputHash}</code></details>}
          </article>
        ))}
      </div>
    </section>
  );
}

export function SessionsPage() {
  const [sessionState, setSessionState] = useState<SessionListState>({ status: "loading" });
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [timelineRevision, setTimelineRevision] = useState(0);
  const [timeline, setTimeline] = useState<TimelineState>({ status: "idle" });
  const [runs, setRuns] = useState<RunsState>({ status: "loading" });
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runDetailRevision, setRunDetailRevision] = useState(0);
  const [runDetail, setRunDetail] = useState<RunDetailState | null>(null);
  const [metrics, setMetrics] = useState<MetricsState>({ status: "loading" });

  const loadSessions = useCallback(async (signal?: AbortSignal) => {
    setSessionState({ status: "loading" });
    try {
      const sessions = await fetchSessions(signal);
      if (!signal?.aborted) setSessionState({ status: "ready", sessions });
    } catch (error) {
      if (!signal?.aborted) {
        setSessionState({
          status: "failed",
          message: errorMessage(error, "Could not load sessions. Check your connection and try again."),
          code: error instanceof SessionsApiError ? error.status : 0,
        });
      }
    }
  }, []);

  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    setRuns({ status: "loading" });
    try {
      const value = await fetchDurableRuns(signal);
      if (!signal?.aborted) setRuns({ status: "ready", runs: value });
    } catch (error) {
      if (!signal?.aborted) setRuns({ status: "failed", message: errorMessage(error, "Could not load durable work.") });
    }
  }, []);

  const loadMetrics = useCallback(async (signal?: AbortSignal) => {
    setMetrics({ status: "loading" });
    try {
      const value = await fetchSessionMetrics(signal);
      if (!signal?.aborted) setMetrics({ status: "ready", metrics: value });
    } catch {
      if (!signal?.aborted) setMetrics({ status: "failed" });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadSessions(controller.signal);
    void loadRuns(controller.signal);
    void loadMetrics(controller.signal);
    return () => controller.abort();
  }, [loadMetrics, loadRuns, loadSessions]);

  useEffect(() => {
    if (!activeSessionId) {
      setTimeline({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setTimeline({ status: "loading" });
    void Promise.allSettled([
      fetchSessionEvents(activeSessionId, controller.signal),
      fetchSessionReplay(activeSessionId, controller.signal),
    ]).then(([eventsResult, replayResult]) => {
      if (controller.signal.aborted) return;
      if (eventsResult.status === "rejected") {
        setTimeline({ status: "failed", message: errorMessage(eventsResult.reason, "Could not load this session's events.") });
        return;
      }
      setTimeline({
        status: "ready",
        events: eventsResult.value,
        replay: replayResult.status === "fulfilled" ? replayResult.value : null,
        replayError: replayResult.status === "rejected"
          ? errorMessage(replayResult.reason, "Canonical replay is unavailable.")
          : null,
      });
    });
    return () => controller.abort();
  }, [activeSessionId, timelineRevision]);

  useEffect(() => {
    if (!activeRunId) {
      setRunDetail(null);
      return;
    }
    const controller = new AbortController();
    setRunDetail({ status: "loading" });
    void fetchDurableRunDetail(activeRunId, controller.signal).then(
      (detail) => {
        if (!controller.signal.aborted) setRunDetail({ status: "ready", detail });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setRunDetail({ status: "failed", message: errorMessage(error, "Could not load this run's checkpoints.") });
        }
      },
    );
    return () => controller.abort();
  }, [activeRunId, runDetailRevision]);

  return (
    <main className="sessions-page">
      <header className="sessions-page-header">
        <div>
          <p className="sessions-eyebrow">Agent transparency</p>
          <h1>Agent sessions</h1>
          <p>Every conversation and durable piece of work, replayable event by event with its governed checkpoints.</p>
        </div>
      </header>

      {metrics.status === "ready" && (
        <section className="sessions-context-metrics" aria-label="Context efficiency">
          <span className="sessions-metric-title">Context efficiency:</span>{" "}
          {metrics.metrics.totals.cacheHitRatePct === null
            ? "no token usage recorded yet"
            : `${metrics.metrics.totals.cacheHitRatePct}% of prompt tokens served from provider cache`}
          <span className="sessions-metric-separator" aria-hidden="true"> · </span>
          {(metrics.metrics.totals.inputTokens / 1000).toFixed(1)}k input /{" "}
          {(metrics.metrics.totals.cachedInputTokens / 1000).toFixed(1)}k cached across{" "}
          {metrics.metrics.totals.sessionsTracked} session{metrics.metrics.totals.sessionsTracked === 1 ? "" : "s"}
        </section>
      )}
      {metrics.status === "loading" && <p className="sessions-subtle-status" role="status">Loading context metrics…</p>}

      <section className="sessions-runs-panel" aria-labelledby="sessions-runs-title">
        <header className="sessions-runs-heading">
          <div>
            <h2 id="sessions-runs-title">Durable work</h2>
            <p>Resumable tasks are separate from the conversation that records them.</p>
          </div>
          {runs.status === "ready" && runs.runs.length > 0 && (
            <span>{runs.runs.length} recent run{runs.runs.length === 1 ? "" : "s"}</span>
          )}
        </header>
        {runs.status === "loading" && <p className="sessions-subtle-status" role="status">Loading durable work…</p>}
        {runs.status === "failed" && (
          <div className="sessions-inline-error" role="alert">
            <span>{runs.message}</span>
            <button type="button" onClick={() => void loadRuns()}>Retry</button>
          </div>
        )}
        {runs.status === "ready" && runs.runs.length === 0 && (
          <p className="sessions-subtle-status">No durable runs recorded for this workspace.</p>
        )}
        {runs.status === "ready" && runs.runs.length > 0 && (
          <div className="sessions-run-grid">
            {runs.runs.map((run) => (
              <button
                className={`sessions-run-card${activeRunId === run.id ? " sessions-run-card-current" : ""}`}
                key={run.id}
                type="button"
                aria-pressed={activeRunId === run.id}
                onClick={() => setActiveRunId(run.id)}
              >
                <span className={`session-run-chip session-run-chip-${statusTone(run.status)}`}>{statusLabel(run.status)}</span>
                <span className="sessions-run-step">step {run.currentStep}</span>
                <time dateTime={run.updatedAt}>{timeAgo(run.updatedAt)}</time>
                <strong>{run.goal}</strong>
                {run.harnessProfileId && (
                  <span className="sessions-run-profile">{run.harnessProfileId} · {run.harnessProfileVersion ?? "unknown version"}</span>
                )}
              </button>
            ))}
          </div>
        )}
        {runDetail?.status === "loading" && <p className="sessions-subtle-status" role="status">Loading run checkpoints…</p>}
        {runDetail?.status === "failed" && (
          <div className="sessions-inline-error" role="alert">
            <span>{runDetail.message}</span>
            <button type="button" onClick={() => setRunDetailRevision((revision) => revision + 1)}>Retry</button>
          </div>
        )}
        {runDetail?.status === "ready" && <RunDossier detail={runDetail.detail} />}
      </section>

      {sessionState.status === "loading" && <p className="sessions-loading" role="status">Loading agent sessions…</p>}
      {sessionState.status === "failed" && (
        <section className="sessions-load-error" role="alert">
          <div>
            <p className="sessions-eyebrow">Sessions unavailable</p>
            <h2>{sessionState.code === 403 ? "Access denied" : "Could not load sessions"}</h2>
            <p>{sessionState.message}</p>
          </div>
          <div className="sessions-error-actions">
            {sessionState.code === 401 && <a href="/login">Sign in again</a>}
            <button type="button" onClick={() => void loadSessions()}>Try again</button>
          </div>
        </section>
      )}
      {sessionState.status === "ready" && sessionState.sessions.length === 0 && (
        <section className="sessions-empty" role="status">
          <span aria-hidden="true">◌</span>
          <h2>No sessions yet</h2>
          <p>Talk to your workmate in the Console, every exchange is recorded here for replay and audit.</p>
        </section>
      )}
      {sessionState.status === "ready" && sessionState.sessions.length > 0 && (
        <div className="sessions-browser">
          <aside className="sessions-list" aria-label="Agent session list">
            {sessionState.sessions.map((session) => (
              <button
                className={`sessions-list-item${activeSessionId === session.id ? " sessions-list-item-current" : ""}`}
                key={session.id}
                type="button"
                aria-current={activeSessionId === session.id ? "true" : undefined}
                onClick={() => setActiveSessionId(session.id)}
              >
                <strong>{session.title ?? "Untitled session"}</strong>
                <span className="sessions-list-meta">
                  <time dateTime={session.createdAt}>{timeAgo(session.createdAt)}</time>
                  <span className={`sessions-mode${session.mode === "creator" ? " sessions-mode-creator" : ""}`}>{session.mode}</span>
                  <span>{session.status}</span>
                </span>
              </button>
            ))}
          </aside>

          <section className="sessions-timeline" aria-label="Session trajectory">
            {!activeSessionId && (
              <div className="sessions-pick-prompt">
                <span aria-hidden="true">⌁</span>
                <h2>Pick a session</h2>
                <p>Select a session on the left to replay its full trajectory.</p>
              </div>
            )}
            {timeline.status === "loading" && <p className="sessions-subtle-status" role="status">Loading session trajectory…</p>}
            {timeline.status === "failed" && (
              <div className="sessions-inline-error" role="alert">
                <span>{timeline.message}</span>
                <button type="button" onClick={() => setTimelineRevision((revision) => revision + 1)}>Retry</button>
              </div>
            )}
            {timeline.status === "ready" && timeline.events.length === 0 && (
              <p className="sessions-no-events" role="status">This session has no recorded events.</p>
            )}
            {timeline.status === "ready" && timeline.replay && (
              <section className="sessions-replay-summary" aria-label="Canonical replay summary">
                <div className="sessions-replay-heading">
                  <strong>Canonical replay</strong>
                  <span>{timeline.replay.eventCount} events</span>
                  <span>read-only · no model or capability invoked</span>
                </div>
                {timeline.replay.finalMessage && <p>{timeline.replay.finalMessage}</p>}
                {timeline.replay.observations.length > 0 && (
                  <details className="sessions-replay-observations">
                    <summary>{timeline.replay.observations.length} replay observation{timeline.replay.observations.length === 1 ? "" : "s"}</summary>
                    <ol>
                      {timeline.replay.observations.map((observation) => (
                        <li key={`${observation.seq}-${observation.name}`}>
                          <code>#{observation.seq} · {observation.name}</code>
                          <span>{observation.result}</span>
                        </li>
                      ))}
                    </ol>
                  </details>
                )}
              </section>
            )}
            {timeline.status === "ready" && timeline.replayError && (
              <div className="sessions-replay-warning" role="status">
                <span>Canonical replay is unavailable: {timeline.replayError}</span>
                <button type="button" onClick={() => setTimelineRevision((revision) => revision + 1)}>Retry</button>
              </div>
            )}
            {timeline.status === "ready" && timeline.events.length > 0 && <SessionTimeline events={timeline.events} />}
          </section>
        </div>
      )}
    </main>
  );
}
