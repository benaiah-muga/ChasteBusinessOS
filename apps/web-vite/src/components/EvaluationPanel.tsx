import { useCallback, useEffect, useRef, useState } from "react";
import {
  EvaluationApiError,
  fetchEvaluations,
  runEvaluation,
  type EvaluationCatalog,
  type EvaluationRunResult,
  type EvaluationScenario,
} from "../api/evaluations";
import "./EvaluationPanel.css";

type CatalogState =
  | { kind: "waiting" }
  | { kind: "loading" }
  | { kind: "ready"; catalog: EvaluationCatalog }
  | { kind: "error"; message: string; adminOnly: boolean };

function isForbidden(error: unknown): boolean {
  return error instanceof EvaluationApiError && error.status === 403;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof EvaluationApiError) return error.message;
  return "Could not reach the evaluations service. Check your connection and try again.";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function sanitizeEvaluationText(value: string): string {
  return value.replace(/\u2014/g, ", ").replace(/\u2013/g, "-");
}

const HISTORY_LIMIT = 30;
const RUN_LIST_LIMIT = 8;
const TREND_LIMIT = 5;

function formatPassRate(passed: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((passed / total) * 100)}%`;
}

function historySummary(runs: readonly EvaluationRunResult[]): string {
  const passed = runs.filter((run) => run.status === "passed").length;
  const noun = runs.length === 1 ? "run" : "runs";
  return `${runs.length} ${noun}, ${passed} passed, ${formatPassRate(passed, runs.length)} pass rate.`;
}

function formatRunTimestamp(createdAt: string): string {
  if (!createdAt) return "Time not recorded";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "Time not recorded";
  return sanitizeEvaluationText(date.toLocaleString());
}

function statusLabel(status: EvaluationRunResult["status"]): string {
  if (status === "passed") return "Passed";
  if (status === "failed") return "Failed";
  return "Error";
}

function mergeRunHistory(
  history: readonly EvaluationRunResult[],
  run: EvaluationRunResult,
): EvaluationRunResult[] {
  const createdAt = run.createdAt.trim();
  const kept = createdAt
    ? history.filter((entry) => entry.createdAt !== createdAt || entry.scenarioId !== run.scenarioId)
    : history;
  return [run, ...kept].slice(0, HISTORY_LIMIT);
}

function compactJson(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined) return sanitizeEvaluationText(encoded);
    return String(value);
  } catch {
    return "Unserializable value";
  }
}

function EvaluationResult({ result }: { result: EvaluationRunResult }) {
  return (
    <section className="evaluation-result" aria-label={`${result.scenarioId} result`}>
      <div className="evaluation-result__summary">
        <span className={`evaluation-status evaluation-status--${result.status}`}>{result.status}</span>
        <span className="evaluation-result__metric">{formatDuration(result.durationMs)}</span>
        <span className="evaluation-result__metric">{formatCount(result.usage.input)} input tokens</span>
        <span className="evaluation-result__metric">{formatCount(result.usage.output)} output tokens</span>
        <span className="evaluation-result__metric">{formatCount(result.usage.cachedInput)} cached</span>
        {result.model && <span className="evaluation-result__model">{result.model}</span>}
      </div>

      {result.persisted === false && (
        <p className="evaluation-result__unsaved" role="status">
          Not saved to history
        </p>
      )}

      {result.status === "error" && result.error && (
        <p className="evaluation-result__error" role="status">
          {result.error}
        </p>
      )}

      {result.toolCalls.length > 0 && (
        <div className="evaluation-result__block">
          <h4>Tool call trace</h4>
          <ol className="evaluation-trace">
            {result.toolCalls.map((call, index) => (
              <li key={`${call.name}-${index}`}>
                <div className="evaluation-trace__head">
                  <span className="evaluation-trace__index">{index + 1}</span>
                  <code>{call.name}</code>
                </div>
                <div className="evaluation-trace__payload">
                  <span>Arguments</span>
                  <pre>{compactJson(call.arguments)}</pre>
                </div>
                <div className="evaluation-trace__payload">
                  <span>Result</span>
                  <pre>{compactJson(call.result)}</pre>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="evaluation-result__block">
        <h4>Final answer</h4>
        <pre className="evaluation-final-answer">{sanitizeEvaluationText(result.finalAnswer || "The model returned no final answer.")}</pre>
      </div>

      <div className="evaluation-result__block">
        <h4>Checks</h4>
        {result.checks.length === 0 ? (
          <p className="evaluation-panel__muted">No checks were evaluated.</p>
        ) : (
          <ul className="evaluation-checks">
            {result.checks.map((check) => (
              <li
                key={check.id}
                className={`evaluation-check ${check.passed ? "evaluation-check--pass" : "evaluation-check--fail"}`}
              >
                <span className="evaluation-check__mark" aria-hidden="true">
                  {check.passed ? "✓" : "✕"}
                </span>
                <div>
                  <p className="evaluation-check__label">
                    {check.label}
                    <span className="evaluation-check__verdict">{check.passed ? "pass" : "fail"}</span>
                  </p>
                  {check.detail && <p className="evaluation-check__detail">{check.detail}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function EvaluationHistory({
  runs,
  scenarios,
}: {
  runs: readonly EvaluationRunResult[];
  scenarios: readonly EvaluationScenario[];
}) {
  const titles = new Map(scenarios.map((scenario) => [scenario.id, scenario.title] as const));
  const grouped = new Map<string, EvaluationRunResult[]>();
  for (const run of runs) {
    const existing = grouped.get(run.scenarioId);
    if (existing) existing.push(run);
    else grouped.set(run.scenarioId, [run]);
  }

  return (
    <section className="evaluation-history" aria-labelledby="evaluation-history-title">
      <header className="evaluation-history__header">
        <h3 id="evaluation-history-title">Run history</h3>
        <p className="evaluation-history__summary">{historySummary(runs)}</p>
      </header>

      <div className="evaluation-history__trends">
        {[...grouped.entries()].map(([scenarioId, scenarioRuns]) => {
          const title = titles.get(scenarioId) ?? scenarioId;
          const recent = scenarioRuns.slice(0, TREND_LIMIT);
          const passed = recent.filter((run) => run.status === "passed").length;
          return (
            <div className="evaluation-history__trend" key={scenarioId}>
              <p className="evaluation-history__trend-title">
                {sanitizeEvaluationText(title)} -{" "}
                <span className="evaluation-history__trend-count">
                  {passed}/{recent.length} passed
                </span>
              </p>
              <ul className="evaluation-history__marks" aria-label={`Recent runs for ${title}`}>
                {[...recent].reverse().map((run, index) => (
                  <li key={`${run.createdAt}-${index}`} className="evaluation-history__mark-item">
                    <span
                      className={`evaluation-history__mark evaluation-history__mark--${run.status === "passed" ? "pass" : "fail"}`}
                      role="img"
                      aria-label={`Run ${index + 1} for ${title}: ${run.status}`}
                      title={`${formatRunTimestamp(run.createdAt)}: ${run.status}`}
                    >
                      {run.status === "passed" ? "\u2713" : "\u2715"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <ol className="evaluation-history__runs" aria-label="Recent evaluation runs">
        {runs.slice(0, RUN_LIST_LIMIT).map((run, index) => {
          const title = titles.get(run.scenarioId) ?? run.scenarioId;
          return (
            <li
              className="evaluation-history__run"
              key={`${run.scenarioId}-${run.createdAt || "unsaved"}-${index}`}
            >
              <time className="evaluation-history__run-time" dateTime={run.createdAt || undefined}>
                {formatRunTimestamp(run.createdAt)}
              </time>
              <span className="evaluation-history__run-title">
                {sanitizeEvaluationText(title)} -{" "}
                <span className="evaluation-history__run-model">{run.model || "unknown model"}</span>
              </span>
              <span className={`evaluation-status evaluation-status--${run.status}`}>{statusLabel(run.status)}</span>
              <span className="evaluation-history__run-duration">took {formatDuration(run.durationMs)}</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function ScenarioCard({
  scenario,
  live,
  busy,
  activeScenarioId,
  adminOnly,
  result,
  onRun,
}: {
  scenario: EvaluationScenario;
  live: boolean;
  busy: boolean;
  activeScenarioId: string | null;
  adminOnly: boolean;
  result: EvaluationRunResult | undefined;
  onRun: (scenarioId: string) => void;
}) {
  const isActive = activeScenarioId === scenario.id;
  const disabled = busy || !live || adminOnly;

  return (
    <article className="evaluation-scenario">
      <div className="evaluation-scenario__head">
        <h3>{scenario.title}</h3>
        <button
          type="button"
          className="evaluation-panel__button evaluation-panel__button--primary"
          aria-label={`Run ${scenario.title}`}
          disabled={disabled}
          onClick={() => onRun(scenario.id)}
        >
          {isActive ? "Running..." : "Run"}
        </button>
      </div>
      <p className="evaluation-scenario__description">{scenario.description}</p>
      {scenario.checks.length > 0 && (
        <ul className="evaluation-scenario__checks" aria-label={`Checks for ${scenario.title}`}>
          {scenario.checks.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      )}
      {result && <EvaluationResult result={result} />}
    </article>
  );
}

export function EvaluationPanel({ organizationId }: { organizationId: string | null }) {
  const [catalog, setCatalog] = useState<CatalogState>(
    organizationId ? { kind: "loading" } : { kind: "waiting" },
  );
  const [results, setResults] = useState<ReadonlyMap<string, EvaluationRunResult>>(() => new Map());
  const [history, setHistory] = useState<EvaluationRunResult[]>([]);
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [adminOnly, setAdminOnly] = useState(false);
  const busyRef = useRef(false);
  const organizationRef = useRef(organizationId);
  organizationRef.current = organizationId;
  const runGeneration = useRef(0);

  useEffect(() => {
    runGeneration.current += 1;
    busyRef.current = false;
    setResults(new Map());
    setHistory([]);
    setActiveScenarioId(null);
    setRunningAll(false);
    setRunError(null);
    setAdminOnly(false);
  }, [organizationId]);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!organizationId) {
      setCatalog({ kind: "waiting" });
      return;
    }
    setCatalog({ kind: "loading" });
    try {
      const next = await fetchEvaluations(organizationId, signal);
      if (!signal?.aborted) {
        setCatalog({ kind: "ready", catalog: next });
        setHistory(next.recentRuns.slice(0, HISTORY_LIMIT));
      }
    } catch (error) {
      if (signal?.aborted) return;
      setCatalog({ kind: "error", message: errorMessage(error), adminOnly: isForbidden(error) });
    }
  }, [organizationId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function saveResult(result: EvaluationRunResult) {
    setResults((current) => {
      const next = new Map(current);
      next.set(result.scenarioId, result);
      return next;
    });
    setHistory((current) => mergeRunHistory(current, result));
  }

  function reportRunError(error: unknown) {
    if (isForbidden(error)) {
      setAdminOnly(true);
      return;
    }
    setRunError(errorMessage(error));
  }

  const canRun = catalog.kind === "ready" && catalog.catalog.live && Boolean(organizationId) && !adminOnly;

  async function runScenario(scenarioId: string) {
    if (busyRef.current || !canRun || !organizationId) return;
    const organization = organizationId;
    const generation = ++runGeneration.current;
    busyRef.current = true;
    setActiveScenarioId(scenarioId);
    setRunError(null);
    try {
      const result = await runEvaluation(scenarioId, organization);
      if (generation === runGeneration.current && organizationRef.current === organization) {
        saveResult(result);
      }
    } catch (error) {
      if (!isAbortError(error) && generation === runGeneration.current) reportRunError(error);
    } finally {
      if (generation === runGeneration.current) {
        busyRef.current = false;
        setActiveScenarioId(null);
      }
    }
  }

  async function runAll() {
    if (busyRef.current || !canRun || !organizationId || catalog.kind !== "ready") return;
    const organization = organizationId;
    const generation = ++runGeneration.current;
    busyRef.current = true;
    setRunningAll(true);
    setRunError(null);
    try {
      for (const scenario of catalog.catalog.scenarios) {
        if (generation !== runGeneration.current || organizationRef.current !== organization) break;
        setActiveScenarioId(scenario.id);
        try {
          const result = await runEvaluation(scenario.id, organization);
          if (generation !== runGeneration.current || organizationRef.current !== organization) break;
          saveResult(result);
        } catch (error) {
          if (!isAbortError(error) && generation === runGeneration.current) {
            reportRunError(error);
            break;
          }
        }
      }
    } finally {
      if (generation === runGeneration.current) {
        busyRef.current = false;
        setRunningAll(false);
        setActiveScenarioId(null);
      }
    }
  }

  const catalogData = catalog.kind === "ready" ? catalog.catalog : null;
  const busy = activeScenarioId !== null || runningAll;
  const activeScenario = catalogData?.scenarios.find((scenario) => scenario.id === activeScenarioId);

  return (
    <section className="evaluation-panel" aria-labelledby="evaluation-panel-title">
      <header className="evaluation-panel__header">
        <p className="evaluation-panel__eyebrow">Quality</p>
        <h2 id="evaluation-panel-title">Live agent evaluations</h2>
        <p className="evaluation-panel__intro">
          Run the workmate against fixture data and inspect what it read, prepared, and answered. Every tool call is
          served from a fixed fixture, so a run never changes business records.
        </p>
      </header>

      {catalog.kind === "waiting" && (
        <p className="evaluation-panel__notice" role="status">
          Waiting for the active organization to finish loading before evaluations can start.
        </p>
      )}

      {catalog.kind === "loading" && (
        <p className="evaluation-panel__muted" role="status">
          Loading evaluation scenarios...
        </p>
      )}

      {catalog.kind === "error" &&
        (catalog.adminOnly ? (
          <p className="evaluation-panel__notice evaluation-panel__notice--warning" role="status">
            Quality runs are limited to organization admins. Ask an organization admin to run these checks.
          </p>
        ) : (
          <div className="evaluation-panel__notice evaluation-panel__notice--error" role="alert">
            <span>{catalog.message}</span>
            <button
              type="button"
              className="evaluation-panel__button evaluation-panel__button--secondary"
              onClick={() => void load()}
            >
              Try again
            </button>
          </div>
        ))}

      {catalogData && (
        <>
          <div className="evaluation-panel__toolbar">
            <div className="evaluation-panel__model">
              <span className={`evaluation-panel__live ${catalogData.live ? "is-live" : "is-offline"}`}>
                {catalogData.live ? "Live" : "Not configured"}
              </span>
              <span>
                Model <code>{catalogData.live ? catalogData.model || "unknown" : "not connected"}</code>
              </span>
            </div>
            <button
              type="button"
              className="evaluation-panel__button evaluation-panel__button--primary"
              disabled={!catalogData.live || busy || adminOnly || catalogData.scenarios.length === 0}
              onClick={() => void runAll()}
            >
              {runningAll ? "Running all..." : "Run all"}
            </button>
          </div>

          {!catalogData.live && (
            <p className="evaluation-panel__notice evaluation-panel__notice--warning" role="status">
              <code>DEEPSEEK_API_KEY</code> is not configured on the server, so live runs are disabled. Scenarios stay
              visible so you can review what each run would check.
            </p>
          )}

          {adminOnly && (
            <p className="evaluation-panel__notice evaluation-panel__notice--warning" role="status">
              Quality runs are limited to organization admins. Ask an organization admin to run these checks.
            </p>
          )}

          {runError && (
            <p className="evaluation-panel__notice evaluation-panel__notice--error" role="alert">
              {runError}
            </p>
          )}

          {busy && (
            <p className="evaluation-panel__progress" role="status" aria-live="polite">
              {runningAll ? "Running all scenarios sequentially. " : ""}
              {activeScenario ? `Running ${activeScenario.title}...` : "Running..."}
            </p>
          )}

          {catalogData.scenarios.length === 0 ? (
            <p className="evaluation-panel__muted">No evaluation scenarios are available.</p>
          ) : (
            <div className="evaluation-panel__scenarios">
              {catalogData.scenarios.map((scenario) => (
                <ScenarioCard
                  key={scenario.id}
                  scenario={scenario}
                  live={catalogData.live}
                  busy={busy}
                  activeScenarioId={activeScenarioId}
                  adminOnly={adminOnly}
                  result={results.get(scenario.id)}
                  onRun={(scenarioId) => void runScenario(scenarioId)}
                />
              ))}
            </div>
          )}

          {history.length > 0 && (
            <EvaluationHistory runs={history} scenarios={catalogData.scenarios} />
          )}
        </>
      )}
    </section>
  );
}
